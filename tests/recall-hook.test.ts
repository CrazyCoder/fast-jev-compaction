import { describe, expect, it, vi } from 'vitest';
import { register } from '../hooks/fast-jev.ts';
import { RECALL_TOOL, recallRequest } from '../src/recall/tool.js';
import { memoryFs } from './helpers/memory-fs.js';
import { callRow, resultRow, userRow } from './helpers/rows.js';

type Hook = (host: unknown, event: unknown, next: (e: unknown) => unknown) => Promise<unknown>;

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

const ROOT = '/home/me/.claude/fast-jev-compaction/recall/sess-1';
const BODY = 'export const x = 1;\n'.repeat(400);

function host(live: unknown[] = []) {
  const { fs, files } = memoryFs();
  const register = vi.fn(async (spec: { name: string }) => ({ tool: `mcp__fast-jev-compaction__${spec.name}` }));
  const $ = {
    env: { get: async (name: string) => ({ HOME: '/home/me' })[name] },
    fs,
    settings: { read: async () => ({}) },
    clock: { sleep: () => new Promise<void>(() => {}) },
    ui: { log: () => {}, toast: () => {} },
    tool: { register },
    session: { id: async () => 'sess-1', messages: async (args?: unknown) => (args ? [] : live), usage: async () => ({ context: {} }) },
    http: { fetch: async () => ({ status: 500, ok: false, text: 'down' }) },
  };
  return { $, files, register };
}

const transcript = () => [
  userRow('Find why the build fails.'),
  callRow('toolu_build', '', { command: 'npm run build' }),
  resultRow('toolu_build', `error TS2304: Cannot find name 'widget'\n${BODY}`),
];

describe('recall in the hook', () => {
  it('registers the recall tool when a session starts', async () => {
    const { $, register } = host();
    await hooks()['session.start']!($, {}, async () => ({ cwd: '.' }));
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'recall' }));
  });

  it('archives what a compaction receives before anything is cut, even when Jev fails', async () => {
    const { $, files } = host();
    await hooks()['session.compact']!($, { trigger: 'manual', messages: transcript() }, async () => ({}));
    const chunks = [...files.keys()].filter((k) => k.startsWith(`${ROOT}/`));
    expect(chunks).toEqual([`${ROOT}/000001-001.json`]);
    expect(files.get(chunks[0]!)!.text).toContain("Cannot find name 'widget'");
  });

  it('answers a recall call from the archive and the live rows', async () => {
    const { $ } = host([userRow('Next, fix it.')]);
    const registered = hooks();
    await registered['session.compact']!($, { trigger: 'manual', messages: transcript() }, async () => ({}));
    const call = registered[`tool.call:${RECALL_TOOL}`]!;
    const found = (await call($, { tool: RECALL_TOOL, query: 'widget' }, async () => ({}))) as { result: string };
    expect(found.result).toMatch(/^#2 call Read \(toolu_build\)/m);
    const full = (await call($, { tool: RECALL_TOOL, expand: ['toolu_build'] }, async () => ({}))) as { result: string };
    expect(full.result).toContain(BODY.slice(0, 200));
    const listed = (await call($, { tool: RECALL_TOOL, range: [1, 9] }, async () => ({}))) as { result: string };
    expect(listed.result).toContain('#3 prompt Next, fix it.');
  });

  it('does nothing with recall: false', async () => {
    const { $, files, register } = host();
    const registered = hooks({ recall: false });
    expect(registered[`tool.call:${RECALL_TOOL}`]).toBeUndefined();
    await registered['session.compact']!($, { trigger: 'manual', messages: transcript() }, async () => ({}));
    expect([...files.keys()].some((k) => k.includes('/recall/'))).toBe(false);
    expect(register).not.toHaveBeenCalled();
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
