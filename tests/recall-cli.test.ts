import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

  it('runs as a script: request on stdin, answer on stdout', () => {
    const { dir } = configDir();
    const run = spawnSync(process.execPath, [CLI], {
      input: JSON.stringify({ configDir: dir, sessionId: SESSION, request: { expand: ['t1'] } }),
      encoding: 'utf8',
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('FULL SAVED OUTPUT');
  });
});

describe('recallCommand', () => {
  it('runs tools/node.cmd with bash on Linux and macOS', () => {
    expect(recallCommand('/home/me/.claude/plugins/cache/x/fast-jev-compaction/0.9.0')).toEqual({
      argv: ['bash', '/home/me/.claude/plugins/cache/x/fast-jev-compaction/0.9.0/tools/node.cmd', '/home/me/.claude/plugins/cache/x/fast-jev-compaction/0.9.0/src/recall/cli.ts'],
    });
  });

  it('runs .\\node.cmd through cmd.exe from the tools folder on Windows, a space in the path or not', () => {
    expect(recallCommand('C:\\Users\\Jo Ann\\.claude\\plugins\\fjc')).toEqual({
      argv: ['cmd.exe', '/d', '/s', '/c', '.\\node.cmd', 'C:\\Users\\Jo Ann\\.claude\\plugins\\fjc\\src\\recall\\cli.ts'],
      cwd: 'C:\\Users\\Jo Ann\\.claude\\plugins\\fjc\\tools',
    });
  });
});
