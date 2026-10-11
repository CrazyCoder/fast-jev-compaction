import { describe, expect, it } from 'vitest';
import {
  appendCompactionLog,
  COMPACTION_LOG_LINES,
  compactionLogPath,
  jevAsker,
  register,
  summarize,
} from '../hooks/jetcompact.ts';
import { JevTransportError } from '../src/index.js';

const LOG = '/home/me/.claude/jetcompact/compactions.log';

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

type Hook = (host: unknown, event: unknown, next: (e: unknown) => unknown) => Promise<unknown>;

/** The hooks `register` installs with the given plugin options, by event name. */
function registered(options: Record<string, unknown>): Record<string, Hook> {
  const hooks: Record<string, Hook> = {};
  (register as unknown as (on: unknown, options: unknown) => void)(
    (event: string, hook: Hook) => {
      hooks[event] = hook;
      return { catch: () => undefined };
    },
    options,
  );
  return hooks;
}

/** A host whose Jev answers every question with `noul`; `api` is the conversation's API form. */
function jevHost(noul: number, api?: unknown[], bodies: string[] = []) {
  return {
    env: { get: async (name: string) => (name === 'TYPESAFE_API_KEY' ? 'k' : undefined) },
    settings: { read: async () => ({}) },
    clock: { sleep: () => new Promise<void>(() => {}) },
    ui: { log: () => {}, toast: () => {} },
    session: { usage: async () => ({ context: {} }), ...(api && { messages: async () => api }) },
    http: {
      fetch: async (_url: string, init: { body: string }) => {
        bodies.push(init.body);
        const { questions } = JSON.parse(init.body) as { questions: Record<string, unknown> };
        const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul }]));
        return { status: 200, ok: true, text: JSON.stringify({ answers }) };
      },
    },
  };
}

const BODY = 'line\n'.repeat(200);

/** A prompt and a Skill call as rows, and as the API form, where the skill's `body` follows its result. */
function skillSession(body: string) {
  return {
    rows: [
      { role: 'user', text: 'Use the skill.', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 's', tool: 'Skill', input: {} }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 's', text: 'Launching skill: x', isError: false }] },
    ],
    api: [
      { role: 'user', content: [{ type: 'text', text: 'Use the skill.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 's' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's', content: 'Launching skill: x' }, { type: 'text', text: body }] },
    ],
  };
}

/** A prompt, one Read call with a long result, and a reply. */
function readSession(prompt = 'go') {
  return [
    { role: 'user', text: prompt, toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'a.ts' }, text: BODY }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: BODY, isError: false }] },
    { role: 'assistant', text: 'Done.', toolUses: [] },
  ];
}

describe('Jev transport through the hook', () => {
  it('reports a fetch that gets no answer as a JevTransportError', async () => {
    const asker = jevAsker(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.typesafe.ai');
    }, 'k', 'jev-latest');
    await expect(asker.ask('s', {})).rejects.toBeInstanceOf(JevTransportError);
  });

  it('passes /compact instructions to Jev', async () => {
    const bodies: string[] = [];
    const hooks = registered({ preserveRecentMessages: 1 });
    const messages = readSession('Fix it.');
    await hooks['session.compact']!(jevHost(0.1, undefined, bodies), { trigger: 'manual', messages, instructions: 'the error codes' }, async () => ({}));
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).state.goal).toContain('The user asked this compaction to keep: the error codes');
  });

  it('folds hidden content from the API view back into the returned rows', async () => {
    const hooks = registered({ preserveRecentMessages: 1, minReductionRatio: 0, targetPercent: 100, keepMode: 'threshold' });
    const [, read, result, done] = readSession();
    const skill = skillSession('SKILL BODY');
    const messages = [...skill.rows, read, result, done].map((message, i) => ({ ...message, handle: `h${i}` }));
    const api = [
      ...skill.api,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: BODY }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ];
    const out = (await hooks['session.compact']!(jevHost(0.01, api), { trigger: 'manual', messages }, async () => ({}))) as {
      messages: { text: string; toolResults?: { tool_use_id: string; text: string }[]; handle?: string }[];
    };
    const skillResult = out.messages.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === 's')!;
    expect(skillResult.text).toMatch(/\n\nSKILL BODY$/);
    expect(out.messages.every((m) => m.handle === undefined)).toBe(true);
  });

  it('measures the size guards after the fold', async () => {
    const hooks = registered({ preserveRecentMessages: 1, minReductionRatio: 0 });
    const skill = skillSession('BODY');
    const messages = [...skill.rows, { role: 'assistant', text: 'Done.', toolUses: [] }];
    const api = [
      ...skill.api,
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ];
    // Jev keeps everything (0% before the fold); the folded body makes it negative.
    const out = await hooks['session.compact']!(jevHost(0.99, api), { trigger: 'manual', messages }, async () => ({}));
    expect(out).toEqual({ skip: expect.stringMatching(/below 0% minimum: -\d+% reduction.*hidden content: 1 folded back \(\d+ chars\)/) });
  });

  it('logs a plugin-triggered compaction that ran out of time', async () => {
    const files = new Map<string, string>();
    const { $ } = fsHost(files, { HOME: '/home/me', TYPESAFE_API_KEY: 'k' });
    const hooks = registered({ preserveRecentMessages: 1 });
    const messages = readSession();
    const host = {
      ...$,
      settings: { read: async () => ({}) },
      clock: { sleep: async () => {} },
      http: { fetch: () => new Promise(() => {}) },
    };
    const out = await hooks['session.compact']!(host, { trigger: 'plugin', messages }, async () => ({}));
    expect(out).toEqual({ skip: expect.stringMatching(/conversation left unchanged$/) });
    expect(linesOf(files)).toEqual([expect.stringMatching(/^\S+Z plugin not compacted \(/)]);
  });

  it('drops stale reminders an earlier fold left in the rows, and counts them as reduction', async () => {
    const stale = `<system-reminder>\nThe task tools haven't been used recently. ${'nudge '.repeat(800)}\n</system-reminder>`;
    const rows = readSession().map((row) =>
      row.toolResults ? { ...row, toolResults: [{ tool_use_id: 'a', text: `${BODY}\n\n${stale}`, isError: false }] } : row,
    );
    // Jev keeps every call: the only reduction is the stale reminder.
    const out = (await registered({ preserveRecentMessages: 1 })['session.compact']!(
      jevHost(0.99, []),
      { trigger: 'manual', messages: rows },
      async () => ({}),
    )) as { messages?: { toolResults?: { text: string }[] }[] };
    expect(out.messages?.[2]?.toolResults?.[0]?.text).toBe(BODY);
  });

  it('names failed requests in the outcome summary', () => {
    const stats = { stateTokens: 10, stateStage: 'full', requests: 3, requestsFailed: 1, requestError: 'Jev request failed (401): no' };
    expect(summarize({ messages: [], decisions: [], stats } as never)).toMatch(
      /in 3 request\(s\), 1 failed \(calls kept; Jev request failed \(401\): no\)$/,
    );
  });
});

describe('compaction log file', () => {
  it('lives under CLAUDE_CONFIG_DIR, else HOME or USERPROFILE /.claude', async () => {
    const at = (env: Record<string, string>) => compactionLogPath({ env: { get: async (name: string) => env[name] } });
    expect(await at({ HOME: '/home/me' })).toBe(LOG);
    expect(await at({ USERPROFILE: 'C:\\Users\\me' })).toBe('C:/Users/me/.claude/jetcompact/compactions.log');
    expect(await at({ HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg/' })).toBe('/cfg/jetcompact/compactions.log');
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
      (event: string, hook: (typeof hooks)[string]) => {
        hooks[event] = hook;
        return { catch: () => undefined };
      },
      {},
    );
    const host = { ...$, settings: { read: async () => ({}) }, clock: { sleep: () => new Promise<void>(() => {}) } };
    await hooks['session.compact']!(host, { trigger: 'auto', messages: [] }, async () => ({ messages: [] }));
    const lines = linesOf(files);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\S+Z auto fallback to built-in summary \(TYPESAFE_API_KEY is not configured\)$/);
  });

  it('logs what Claude Code refused or timed out, then lets it go on', async () => {
    const files = new Map<string, string>();
    const { $ } = fsHost(files, { HOME: '/home/me' });
    type Catch = (host: unknown, event: unknown, next: (e: unknown) => unknown) => Promise<unknown>;
    const catches: Record<string, Catch> = {};
    (register as unknown as (on: unknown, options: unknown) => void)(
      (event: string) => ({
        catch: (handler: Catch) => {
          catches[event] = handler;
        },
      }),
      {},
    );
    const next = (error: Record<string, unknown>, called: boolean) =>
      Object.assign(async () => 'went on', { error, called });
    const event = { trigger: 'auto', messages: [] };
    expect(await catches['session.compact']!($, event, next({ kind: 'timeout' }, false))).toBe('went on');
    expect(await catches['session.compact']!($, event, next({ kind: 'throw', message: 'bad shape' }, true))).toBe('went on');
    expect(await catches['session.compact']!($, event, next({ kind: 're-entry' }, false))).toBe('went on');
    expect(linesOf(files)).toEqual([
      expect.stringMatching(/Z auto failed in Claude Code \(over its time budget\); built-in summary instead$/),
      expect.stringMatching(/Z auto failed in Claude Code \(bad shape\); after falling back$/),
    ]);
    // A typed /compact may not fall back by default: nothing runs instead.
    const typed = await catches['session.compact']!($, { trigger: 'manual', messages: [] }, next({ kind: 'timeout' }, false));
    expect(typed).toEqual({ skip: expect.stringMatching(/the compaction failed/) });
    expect(linesOf(files).at(-1)).toMatch(/Z manual failed in Claude Code \(over its time budget\); not compacted$/);
  });
});
