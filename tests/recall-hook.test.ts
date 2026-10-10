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
    (event: string, filterOrHook: Hook | { tool: string }, hook?: Hook) => {
      registered[typeof filterOrHook === 'function' ? event : `${event}:${filterOrHook.tool}`] = hook ?? (filterOrHook as Hook);
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
  const run = spawnSync(process.execPath, [argv.at(-1)!], { input: init?.stdin ?? '', encoding: 'utf8' });
  return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
};

function host(home: string, run: (argv: readonly string[], init?: Run['init']) => Promise<unknown> = realCli) {
  const runs: Run[] = [];
  const toolRegister = vi.fn(async (spec: { name: string }) => ({ tool: `mcp__fast-jev-compaction__${spec.name}` }));
  const $ = {
    env: { get: async (name: string) => ({ HOME: home, TYPESAFE_API_KEY: 'k' })[name] },
    fs: { exists: async () => false, read: async () => '', write: async () => {} },
    settings: { read: async () => ({}) },
    clock: { sleep: () => new Promise<void>(() => {}) },
    ui: { log: () => {}, toast: () => {} },
    tool: { register: toolRegister },
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
  return { $, runs, toolRegister };
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
    });
    expect(runs[0]!.argv.at(-1)).toMatch(/src[\\/]recall[\\/]cli\.ts$/);
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
  });
});
