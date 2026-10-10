import { describe, expect, it } from 'vitest';
import {
  appendCompactionLog,
  COMPACTION_LOG_LINES,
  compactionLogPath,
  jevAsker,
  register,
  summarize,
} from '../hooks/fast-jev.ts';
import { JevTransportError } from '../src/index.js';

const LOG = '/home/me/.claude/fast-jev-compaction/compactions.log';

function fsHost(files: Map<string, string>, env: Record<string, string> = { HOME: '/home/me' }) {
  const debug: string[] = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  let unreadable = false;
  const $ = {
    env: { get: async (name: string) => env[name] },
    ui: { log: (text: string) => debug.push(text), toast: () => {} },
    fs: {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => {
        await tick();
        if (unreadable) throw new Error('EACCES: permission denied');
        return files.get(path)!;
      },
      write: async (path: string, text: string) => {
        await tick();
        files.set(path, text);
      },
    },
  };
  return { $, debug, makeUnreadable: () => (unreadable = true) };
}

const linesOf = (files: Map<string, string>) => files.get(LOG)!.split('\n').filter(Boolean);

describe('Jev transport through the hook', () => {
  it('reports a fetch that gets no answer as a JevTransportError', async () => {
    const asker = jevAsker(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.typesafe.ai');
    }, 'k', 'jev-latest');
    await expect(asker.ask('s', {})).rejects.toBeInstanceOf(JevTransportError);
  });

  it('passes /compact instructions to Jev', async () => {
    const bodies: string[] = [];
    const hooks: Record<string, (host: unknown, event: unknown, next: (e: unknown) => unknown) => Promise<unknown>> = {};
    (register as unknown as (on: unknown, options: unknown) => void)(
      (event: string, hook: (typeof hooks)[string]) => (hooks[event] = hook),
      { preserveRecentMessages: 1 },
    );
    const body = 'line\n'.repeat(200);
    const messages = [
      { role: 'user', text: 'Fix it.', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'a.ts' }, text: body }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: body, isError: false }] },
      { role: 'assistant', text: 'Done.', toolUses: [] },
    ];
    const host = {
      env: { get: async (name: string) => (name === 'TYPESAFE_API_KEY' ? 'k' : undefined) },
      settings: { read: async () => ({}) },
      clock: { sleep: () => new Promise<void>(() => {}) },
      ui: { log: () => {}, toast: () => {} },
      session: { usage: async () => ({ context: {} }) },
      http: {
        fetch: async (_url: string, init: { body: string }) => {
          bodies.push(init.body);
          const { questions } = JSON.parse(init.body) as { questions: Record<string, unknown> };
          const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 0.1 }]));
          return { status: 200, ok: true, text: JSON.stringify({ answers }) };
        },
      },
    };
    await hooks['session.compact']!(host, { trigger: 'manual', messages, instructions: 'the error codes' }, async () => ({}));
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).state.goal).toContain('The user asked this compaction to keep: the error codes');
  });

  it('names failed requests in the outcome summary', () => {
    const stats = { stateTokens: 10, stateStage: 'full', requests: 3, requestsFailed: 1 };
    expect(summarize({ messages: [], decisions: [], stats } as never)).toMatch(/in 3 request\(s\), 1 failed \(calls kept\)$/);
  });
});

describe('compaction log file', () => {
  it('lives under CLAUDE_CONFIG_DIR, else HOME or USERPROFILE /.claude', async () => {
    const at = (env: Record<string, string>) => compactionLogPath({ env: { get: async (name: string) => env[name] } });
    expect(await at({ HOME: '/home/me' })).toBe(LOG);
    expect(await at({ USERPROFILE: 'C:\\Users\\me' })).toBe('C:/Users/me/.claude/fast-jev-compaction/compactions.log');
    expect(await at({ HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg/' })).toBe('/cfg/fast-jev-compaction/compactions.log');
    expect(await at({})).toBeUndefined();
  });

  it('appends one timestamped line at a time and keeps the newest lines', async () => {
    const files = new Map([[LOG, Array.from({ length: COMPACTION_LOG_LINES }, (_, i) => `old ${i}`).join('\n')]]);
    const { $ } = fsHost(files);
    await Promise.all([appendCompactionLog($, 'manual A'), appendCompactionLog($, 'auto B\nsecond line')]);
    const lines = linesOf(files);
    expect(lines).toHaveLength(COMPACTION_LOG_LINES);
    expect(lines[0]).toBe('old 2');
    expect(lines.slice(-2).map((l) => l.replace(/^\S+Z /, ''))).toEqual(['manual A', 'auto B second line']);
  });

  it('never replaces a log it cannot read', async () => {
    const files = new Map([[LOG, 'kept\n']]);
    const { $, debug, makeUnreadable } = fsHost(files);
    makeUnreadable();
    await appendCompactionLog($, 'manual C');
    expect(files.get(LOG)).toBe('kept\n');
    expect(debug).toEqual(['compaction log not written (EACCES: permission denied)']);
  });

  it('records each compaction outcome as one line', async () => {
    const files = new Map<string, string>();
    const { $ } = fsHost(files, { HOME: '/home/me', TYPESAFE_API_KEY: '' });
    const hooks: Record<string, (host: unknown, event: unknown, next: (e: unknown) => unknown) => Promise<unknown>> = {};
    (register as unknown as (on: unknown, options: unknown) => void)(
      (event: string, hook: (typeof hooks)[string]) => (hooks[event] = hook),
      {},
    );
    const host = { ...$, settings: { read: async () => ({}) }, clock: { sleep: () => new Promise<void>(() => {}) } };
    await hooks['session.compact']!(host, { trigger: 'auto', messages: [] }, async () => ({ messages: [] }));
    const lines = linesOf(files);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\S+Z auto fallback to built-in summary \(TYPESAFE_API_KEY is not configured\)$/);
  });
});
