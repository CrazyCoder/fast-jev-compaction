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

const failing = async () => ({ status: 500, ok: false, text: 'down' });

/** Jev answering every question with 0.01: every result is cut. */
const cutAll = async (_url: string, init: { body: string }) => {
  const { questions } = JSON.parse(init.body) as { questions: Record<string, unknown> };
  const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 0.01 }]));
  return { status: 200, ok: true, text: JSON.stringify({ answers }) };
};

function host(live: unknown[] = [], fetch: typeof failing | typeof cutAll = failing) {
  const { fs, files } = memoryFs();
  const register = vi.fn(async (spec: { name: string }) => ({ tool: `mcp__fast-jev-compaction__${spec.name}` }));
  const $ = {
    env: { get: async (name: string) => ({ HOME: '/home/me', TYPESAFE_API_KEY: 'k' })[name] },
    fs,
    settings: { read: async () => ({}) },
    clock: { sleep: () => new Promise<void>(() => {}) },
    ui: { log: () => {}, toast: () => {} },
    tool: { register },
    session: { id: async () => 'sess-1', messages: async (args?: unknown) => (args ? [] : live), usage: async () => ({ context: {} }) },
    http: { fetch },
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

  it('reads a saved output only from Claude Code\'s own tool-results folders', async () => {
    const saved = '/home/me/.claude/projects/p/sess-1/tool-results/abc.txt';
    const rows = (path: string) => [
      callRow('toolu_s', '', { command: 'gh api' }),
      resultRow('toolu_s', `Output too large. Full output saved to: ${path}\n\nPreview`),
    ];
    for (const [path, readable] of [
      [saved, true],
      ['/home/me/.ssh/id_rsa', false],
      ['/home/me/.claude/projects/p/sess-1/tool-results/../../../../.ssh/id_rsa', false],
    ] as const) {
      const { $, files } = host(rows(path));
      files.set(path, { text: 'FILE CONTENT', mtimeMs: 0 });
      const out = (await hooks()[`tool.call:${RECALL_TOOL}`]!($, { tool: RECALL_TOOL, expand: ['toolu_s'] }, async () => ({}))) as {
        result: string;
      };
      expect(out.result.includes('FILE CONTENT'), path).toBe(readable);
    }
  });

  /** The build result's text after a compaction in which Jev cuts every result. */
  async function cutResult($: ReturnType<typeof host>['$']): Promise<string> {
    const rows = [...transcript(), userRow('ok'), { role: 'assistant', text: 'Done.', toolUses: [] }];
    const out = (await hooks({ preserveRecentMessages: 1, keepMode: 'threshold' })['session.compact']!(
      $,
      { trigger: 'manual', messages: rows },
      async () => ({}),
    )) as { messages: { toolResults?: { text: string }[] }[] };
    return out.messages.flatMap((m) => m.toolResults ?? [])[0]!.text;
  }

  it('writes cut notes that name the recall call', async () => {
    expect(await cutResult(host([], cutAll).$)).toMatch(/; full text: recall expand \["toolu_build"\]\]$/);
  });

  it('tells the model to run the tool again when the archive could not be written', async () => {
    const { $ } = host([], cutAll);
    $.fs.write = async () => {
      throw new Error('EACCES');
    };
    expect(await cutResult($)).toMatch(/; re-run the tool if needed\]$/);
  });

  it('empties old archives at session start, the current session\'s and recall: false aside', async () => {
    for (const recall of [true, false]) {
      const { $, files } = host();
      const old = (id: string) => `/home/me/.claude/fast-jev-compaction/recall/${id}/000001-001.json`;
      files.set(old('sess-1'), { text: '[]', mtimeMs: 0 });
      files.set(old('other'), { text: '[]', mtimeMs: 0 });
      await hooks({ recall })['session.start']!($, {}, async () => ({ cwd: '.' }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect([files.get(old('sess-1'))!.text, files.get(old('other'))!.text], `recall: ${recall}`).toEqual(['[]', '']);
    }
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
