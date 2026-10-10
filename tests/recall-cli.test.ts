import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { answer } from '../src/recall/cli.ts';
import { recallCommand } from '../src/recall/tool.ts';

const SESSION = '5a4ae1c5-3b95-4504-a9dc-d54cfa937af9';
const CLI = fileURLToPath(new URL('../src/recall/cli.ts', import.meta.url));

/** A config dir with one project holding this session's transcript and a saved output. */
function configDir(): { dir: string; saved: string } {
  const dir = mkdtempSync(join(tmpdir(), 'recall-cli-'));
  const project = join(dir, 'projects', 'C--work-app');
  const saved = join(project, SESSION, 'tool-results', 'big.txt');
  mkdirSync(join(project, SESSION, 'tool-results'), { recursive: true });
  writeFileSync(saved, 'FULL SAVED OUTPUT\n'.repeat(3));
  const rows = [
    { type: 'user', message: { content: 'Find the redis timeout.' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rg timeout' } }] } },
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: `Output too large. Full output saved to: ${saved}\n\nPreview` },
        ],
      },
    },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'WebFetch', input: {} }] } },
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't2', content: `Full output saved to: ${join(dir, 'secret.txt')}\n` },
        ],
      },
    },
  ];
  writeFileSync(join(project, `${SESSION}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n'));
  writeFileSync(join(dir, 'secret.txt'), 'SECRET');
  return { dir, saved };
}

describe('recall in Node', () => {
  it('answers from the session transcript, reading saved outputs only from tool-results', async () => {
    const { dir } = configDir();
    expect(await answer({ configDir: dir, sessionId: SESSION, request: { query: 'redis' } })).toMatch(/^#1 prompt/m);
    const expanded = await answer({ configDir: dir, sessionId: SESSION, request: { expand: ['t1', 't2'] } });
    expect(expanded).toContain('FULL SAVED OUTPUT');
    expect(expanded).not.toContain('SECRET');
  });

  it('says so when the session has no transcript', async () => {
    const { dir } = configDir();
    expect(await answer({ configDir: dir, sessionId: 'nope', request: { query: 'x' } })).toBe(
      'Recall: no transcript found for this session.',
    );
  });

  /** Runs `script` with this Node, a request on stdin, and checks the answer on stdout. */
  function expectScriptAnswers(script: string): void {
    const { dir } = configDir();
    const run = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ configDir: dir, sessionId: SESSION, request: { expand: ['t1'] } }),
      encoding: 'utf8',
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('FULL SAVED OUTPUT');
  }

  it('runs as a script: request on stdin, answer on stdout', () => {
    expectScriptAnswers(CLI);
  });

  it('runs as a script reached through a symlink or junction', () => {
    const link = join(mkdtempSync(join(tmpdir(), 'recall-link-')), 'src');
    symlinkSync(join(CLI, '..', '..'), link, 'junction');
    expectScriptAnswers(join(link, 'recall', 'cli.ts'));
  });
});

describe('recall in subagent transcripts', () => {
  /** The session above plus an Agent call t3 whose subagent read the cache config. */
  function withAgent(): string {
    const { dir } = configDir();
    const project = join(dir, 'projects', 'C--work-app');
    const agentRow = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Agent', input: { description: 'Find the cache config' } }] } };
    writeFileSync(join(project, `${SESSION}.jsonl`), `\n${JSON.stringify(agentRow)}`, { flag: 'a' });
    const agents = join(project, SESSION, 'subagents');
    mkdirSync(agents, { recursive: true });
    const sidechain = (type: string, content: unknown) => JSON.stringify({ type, isSidechain: true, message: { content } });
    writeFileSync(
      join(agents, 'agent-abc123.jsonl'),
      [
        sidechain('user', 'Find where the cache timeout is set.'),
        sidechain('assistant', [{ type: 'tool_use', id: 's1', name: 'Grep', input: { pattern: 'timeout' } }]),
        sidechain('user', [{ type: 'tool_result', tool_use_id: 's1', content: 'config/cache.yml:3: timeout: 5' }]),
        sidechain('assistant', [{ type: 'text', text: 'The timeout is in config/cache.yml.' }]),
      ].join('\n'),
    );
    writeFileSync(join(agents, 'agent-abc123.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find the cache config', toolUseId: 't3' }));
    return dir;
  }
  const ask = (dir: string, request: Record<string, unknown>) => answer({ configDir: dir, sessionId: SESSION, request });

  it('lists the subagents with the call that started each', async () => {
    expect(await ask(withAgent(), { agent: 'list' })).toBe(
      ['Subagents of this session (1):', 'abc123 Explore: Find the cache config (started by t3; 3 entries)', 'Search one with agent: "<id or part of its name>", or all with agent: "all".'].join('\n'),
    );
  });

  it('searches one subagent, or the session and all subagents', async () => {
    const dir = withAgent();
    const one = await ask(dir, { query: 'cache.yml', agent: 'cache config' });
    expect(one).toMatch(/^#\d+ \[Explore: Find the cache config\] call Grep \(s1\)/m);
    const all = await ask(dir, { query: 'timeout', agent: 'all' });
    expect(all).toContain('[Explore: Find the cache config]');
    expect(all).toMatch(/^#1 prompt/m);
    expect(await ask(dir, { query: 'x', agent: 'nope' })).toBe('No subagent matches "nope". agent: "list" shows them.');
  });

  it('numbers subagent entries from #100001 per agent, the same whichever agent is asked for', async () => {
    const dir = withAgent();
    const one = await ask(dir, { query: 'cache.yml', agent: 'cache config' });
    const n = /^#(\d+) \[Explore: Find the cache config\] call Grep \(s1\)/m.exec(one)?.[1];
    expect(n).toBe('100002');
    expect(await ask(dir, { expand: [`#${n}`] })).toContain('config/cache.yml:3: timeout: 5');
    expect(await ask(dir, { range: [100001, 100003], agent: 'all' })).toContain('#100002 [Explore: Find the cache config] call Grep (s1)');
  });

  it('keeps a subagent entry\'s number while the session grows', async () => {
    const dir = withAgent();
    const transcript = join(dir, 'projects', 'C--work-app', `${SESSION}.jsonl`);
    writeFileSync(transcript, `\n${JSON.stringify({ type: 'user', message: { content: 'one more prompt' } })}`, { flag: 'a' });
    expect(await ask(dir, { query: 'cache.yml', agent: 'cache config' })).toMatch(/^#100002 \[Explore/m);
  });

  it('expands a subagent call by its id from the session view, and shows which agent an Agent call started', async () => {
    const dir = withAgent();
    expect(await ask(dir, { expand: ['s1'] })).toContain('config/cache.yml:3: timeout: 5');
    expect(await ask(dir, { expand: ['t3'] })).toContain('call Agent (t3) [started agent abc123]');
  });
});

describe('recallCommand', () => {
  it('runs tools/node.cmd with bash on Linux and macOS', () => {
    expect(recallCommand('/home/me/.claude/plugins/cache/x/jetcompact/0.10.0')).toEqual({
      argv: ['bash', '/home/me/.claude/plugins/cache/x/jetcompact/0.10.0/tools/node.cmd', '/home/me/.claude/plugins/cache/x/jetcompact/0.10.0/src/recall/cli.ts'],
    });
  });

  it('runs .\\node.cmd through cmd.exe from the tools folder on Windows, a space in the path or not', () => {
    // The script path is relative, so cmd.exe never parses the plugin folder (`&`, `%`).
    expect(recallCommand('C:\\Users\\Jo Ann\\.claude\\plugins\\R&D fjc')).toEqual({
      argv: ['cmd.exe', '/d', '/s', '/c', '.\\node.cmd', '..\\src\\recall\\cli.ts'],
      cwd: 'C:\\Users\\Jo Ann\\.claude\\plugins\\R&D fjc\\tools',
    });
  });
});
