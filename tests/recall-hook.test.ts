import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { register } from '../hooks/fast-jev.ts';
import { RECALL_TOOL, recallRequest } from '../src/recall/tool.ts';
import { callRow, resultRow, userRow } from './helpers/rows.js';

type Hook = (host: unknown, event: unknown, next: (e: unknown) => unknown) => Promise<unknown>;
type Run = { argv: readonly string[]; init?: { cwd?: string; stdin?: string; timeoutMs?: number } };

/** Registered hooks by event, and for `tool.call` by the tool its filter names. */
function hooks(options: Record<string, unknown> = {}) {
  const registered: Record<string, Hook> = {};
  (register as unknown as (on: unknown, options: unknown) => void)(
    (event: string, filterOrHook: Hook | { tool?: string; command?: string }, hook?: Hook) => {
      const key = typeof filterOrHook === 'function' ? event : `${event}:${filterOrHook.tool ?? filterOrHook.command}`;
      registered[key] = hook ?? (filterOrHook as Hook);
    },
    options,
  );
  return registered;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const BODY = 'export const x = 1;\n'.repeat(400);

/** Jev answering every question with 0.01: every result is cut. */
const cutAll = async (_url: string, init: { body: string }) => {
  const { questions } = JSON.parse(init.body) as { questions: Record<string, unknown> };
  const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 0.01 }]));
  return { status: 200, ok: true, text: JSON.stringify({ answers }) };
};

/** Runs src/recall/cli.ts with this Node, as tools/node.cmd would with the pinned one. */
const realCli = async (argv: readonly string[], init?: Run['init']) => {
  const run = spawnSync(process.execPath, [argv.at(-1)!], {
    input: init?.stdin ?? '',
    encoding: 'utf8',
    ...(init?.cwd && { cwd: init.cwd }),
  });
  return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
};

function host(home: string, run: (argv: readonly string[], init?: Run['init']) => Promise<unknown> = realCli) {
  const runs: Run[] = [];
  const toolRegister = vi.fn(async (spec: { name: string }) => ({ tool: `mcp__fast-jev-compaction__${spec.name}` }));
  const commandRegister = vi.fn(async (spec: { name: string }) => ({ command: spec.name }));
  const $ = {
    env: { get: async (name: string) => ({ HOME: home, TYPESAFE_API_KEY: 'k' })[name] },
    fs: { exists: async () => false, read: async () => '', write: async () => {} },
    settings: { read: async () => ({}) },
    clock: { sleep: () => new Promise<void>(() => {}) },
    ui: { log: () => {}, toast: () => {} },
    tool: { register: toolRegister },
    command: { register: commandRegister },
    plugin: { root: ROOT },
    process: {
      run: async (argv: readonly string[], init?: Run['init']) => {
        runs.push({ argv, ...(init && { init }) });
        return run(argv, init);
      },
    },
    session: { id: async () => 'sess-1', messages: async () => [], usage: async () => ({ context: {} }) },
    http: { fetch: cutAll },
  };
  return { $, runs, toolRegister, commandRegister };
}

/** A home whose ~/.claude holds session sess-1's transcript. */
function homeWithTranscript(): string {
  const home = mkdtempSync(join(tmpdir(), 'recall-hook-'));
  const project = join(home, '.claude', 'projects', 'C--work-app');
  mkdirSync(project, { recursive: true });
  const rows = [
    { type: 'user', message: { content: 'Find why the build fails.' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_build', name: 'Bash', input: { command: 'npm run build' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_build', content: `error TS2304: Cannot find name 'widget'\n${BODY}` }] } },
    { type: 'user', message: { content: 'Next, fix it.' } },
  ];
  writeFileSync(join(project, 'sess-1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
  return home;
}

const rows = () => [
  userRow('Find why the build fails.'),
  callRow('toolu_build', '', { command: 'npm run build' }),
  resultRow('toolu_build', `error TS2304: Cannot find name 'widget'\n${BODY}`),
  userRow('ok'),
  { role: 'assistant', text: 'Done.', toolUses: [] },
];

describe('recall in the hook', () => {
  it('registers the recall tool when a session starts', async () => {
    const { $, toolRegister } = host('/home/me');
    await hooks()['session.start']!($, {}, async () => ({ cwd: '.' }));
    expect(toolRegister).toHaveBeenCalledWith(expect.objectContaining({ name: 'recall' }));
  });

  it('registers /recall-index even when the tool cannot be registered', async () => {
    const { $, toolRegister, commandRegister } = host('/home/me');
    toolRegister.mockRejectedValueOnce(new Error('tools are not supported here'));
    await hooks()['session.start']!($, {}, async () => ({ cwd: '.' }));
    expect(commandRegister).toHaveBeenCalledWith(expect.objectContaining({ name: 'recall-index' }));
  });

  it('registers /recall-index and answers it with the recall script', async () => {
    const home = homeWithTranscript();
    const { $, runs, commandRegister } = host(home);
    const registered = hooks();
    await registered['session.start']!($, {}, async () => ({ cwd: '.' }));
    expect(commandRegister).toHaveBeenCalledWith(expect.objectContaining({ name: 'recall-index' }));
    const out = (await registered['command.run:recall-index']!($, { command: 'recall-index', args: '' }, async () => ({}))) as { text: string };
    expect(out.text).toMatch(/^No session index yet/);
    expect(JSON.parse(runs.at(-1)!.init!.stdin!)).toMatchObject({ indexCommand: '' });
    // A build of every project can take minutes; the host takes 1 to 600,000 ms.
    expect(runs.at(-1)!.init!.timeoutMs).toBe(600_000);
  });

  it('answers a call by running the recall script on the session transcript', async () => {
    const home = homeWithTranscript();
    const { $, runs } = host(home);
    const call = hooks()[`tool.call:${RECALL_TOOL}`]!;
    const found = (await call($, { tool: RECALL_TOOL, query: 'widget' }, async () => ({}))) as { result: string };
    expect(found.result).toMatch(/^#2 call Bash \(toolu_build\)/m);
    const full = (await call($, { tool: RECALL_TOOL, expand: ['toolu_build'] }, async () => ({}))) as { result: string };
    expect(full.result).toContain(BODY.slice(0, 200));
    expect(JSON.parse(runs[0]!.init!.stdin!)).toEqual({
      configDir: `${home.replace(/\\/g, '/')}/.claude`,
      sessionId: 'sess-1',
      request: { query: 'widget' },
      sessionIndex: 'auto',
    });
    expect(runs[0]!.argv.at(-1)).toMatch(/src[\\/]recall[\\/]cli\.ts$/);
  });

  it('passes sessionIndex to the script, "auto" unless set to "off"', async () => {
    for (const [option, sent] of [[undefined, 'auto'], ['off', 'off'], ['bogus', 'auto']] as const) {
      const { $, runs } = host('/home/me', async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
      await hooks(option ? { sessionIndex: option } : {})[`tool.call:${RECALL_TOOL}`]!($, { tool: RECALL_TOOL, sessions: 'x' }, async () => ({}));
      expect(JSON.parse(runs[0]!.init!.stdin!).sessionIndex, String(option)).toBe(sent);
    }
  });

  it('reports a script that fails', async () => {
    const { $ } = host('/home/me', async () => ({ exitCode: 1, stdout: '', stderr: 'ERROR: download failed\n' }));
    const out = (await hooks()[`tool.call:${RECALL_TOOL}`]!($, { tool: RECALL_TOOL, query: 'x' }, async () => ({}))) as {
      result: string;
    };
    expect(out.result).toBe('Recall failed: ERROR: download failed');
  });

  it('writes cut notes that name the recall call, and has Node fetched once', async () => {
    const { $, runs } = host('/home/me', async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const registered = hooks({ preserveRecentMessages: 1, keepMode: 'threshold' });
    for (let i = 0; i < 2; i++) {
      const out = (await registered['session.compact']!($, { trigger: 'manual', messages: rows() }, async () => ({}))) as {
        messages: { toolResults?: { text: string }[] }[];
      };
      expect(out.messages.flatMap((m) => m.toolResults ?? [])[0]!.text).toMatch(/; full text: recall expand \["toolu_build"\]\]$/);
    }
    expect(runs.map((r) => r.init?.stdin)).toEqual(['']);
  });

  it('does nothing with recall: false', async () => {
    const { $, runs, toolRegister } = host('/home/me');
    const registered = hooks({ recall: false, preserveRecentMessages: 1, keepMode: 'threshold' });
    expect(registered[`tool.call:${RECALL_TOOL}`]).toBeUndefined();
    expect(registered['session.start']).toBeUndefined();
    const out = (await registered['session.compact']!($, { trigger: 'manual', messages: rows() }, async () => ({}))) as {
      messages: { toolResults?: { text: string }[] }[];
    };
    expect(out.messages.flatMap((m) => m.toolResults ?? [])[0]!.text).toMatch(/; re-run the tool if needed\]$/);
    expect(runs).toEqual([]);
    expect(toolRegister).not.toHaveBeenCalled();
  });
});

describe('recall requests', () => {
  it('takes what the model sends, loosely', () => {
    expect(recallRequest({ query: 'x', page: 2 })).toEqual({ query: 'x', page: 2 });
    expect(recallRequest({ expand: 'toolu_a' })).toEqual({ expand: ['toolu_a'] });
    expect(recallRequest({ expand: ['#3', 4, null], offset: 100 })).toEqual({ expand: ['#3', 4], offset: 100 });
    expect(recallRequest({ range: ['2', 5] })).toEqual({ range: [2, 5] });
    expect(recallRequest({ range: [1], page: 'two' })).toEqual({});
    expect(recallRequest({ touched: true })).toEqual({ touched: true });
    expect(recallRequest({ touched: 'app.ts' })).toEqual({ touched: 'app.ts' });
    expect(recallRequest({ touched: 1 })).toEqual({});
    expect(recallRequest({ query: 'x', agent: 'all' })).toEqual({ query: 'x', agent: 'all' });
    expect(recallRequest({ sessions: 'jscpd', project: 'billing-api' })).toEqual({ sessions: 'jscpd', project: 'billing-api' });
    expect(recallRequest({ session: '0f1e2d3c', expand: ['t1'] })).toEqual({ session: '0f1e2d3c', expand: ['t1'] });
  });
});
