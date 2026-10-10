import { describe, expect, it, vi } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  dotenvKey,
  getApiKey,
  jevAsker,
  mayUseBuiltin,
  register,
  estimatePostCompactPercent,
  exceedsTarget,
  resolveHookConfig,
  summarize,
  toSessionMessages,
  withCompactionDeadline,
} from '../hooks/fast-jev.ts';
import { parseEnv } from '../src/dotenv.js';
import {
  applyDecisions,
  collectToolCalls,
  decideCall,
  RETRY_DELAY_MS,
  withoutCompactionNote,
  type Message,
} from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

type HookHandler = (host: any, event: any, next: (event: any) => unknown) => Promise<unknown>;

function registeredHooks(options: Record<string, unknown> = {}): Map<string, HookHandler> {
  const handlers = new Map<string, HookHandler>();
  const on = ((name: string, ...args: unknown[]) => {
    handlers.set(name, args.at(-1) as HookHandler);
    return {};
  }) as never;
  register(on, options as never);
  return handlers;
}

function turnComplete(overrides: Record<string, unknown> = {}) {
  return {
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    turnId: 'turn-1',
    reason: 'answer',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({
      provider: 'jev',
      recall: true,
      sessionIndex: 'auto',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      targetPercent: 45,
      model: 'jev-latest',
      compactionTimeoutMs: 15000,
      builtinFallback: 'auto',
      proseModel: 'haiku',
    });
    expect(
      resolveHookConfig({
        apiKey: 'k',
        keepThreshold: 0.3,
        maxStateTokens: 1000,
        model: 'jev-x',
        goal: 'g',
        compactAtPercent: 'no',
        builtinFallback: 'sometimes',
      }),
    ).toEqual({
      provider: 'jev',
      recall: true,
      sessionIndex: 'auto',
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      compactionTimeoutMs: 15000,
      builtinFallback: 'auto',
      proseModel: 'haiku',
      targetPercent: 45,
    });
    // Unset, the hook picks verbatim or digest per compaction (see 'old prose through the hook').
    expect(resolveHookConfig({ oldProse: 'keep', truncateHeadChars: 300 })).toMatchObject({
      oldProse: 'keep',
      truncateHeadChars: 300,
    });
    expect(resolveHookConfig({ keepMode: 'threshold', targetPercent: 30, keepResultTokens: 5 })).toMatchObject({
      keepMode: 'threshold',
      targetPercent: 30,
      keepResultTokens: 5,
    });
    expect(resolveHookConfig({ keepMode: 'bogus' })).not.toHaveProperty('keepMode');
    expect(resolveHookConfig({ builtinFallback: 'never' }).builtinFallback).toBe('never');
    expect(resolveHookConfig({ builtinFallback: 'always' }).builtinFallback).toBe('always');
  });

  it('reads the old-prose options and ignores bad values', () => {
    expect(resolveHookConfig({ oldProse: 'digest', recentTurns: 5, proseModel: 'sonnet' })).toMatchObject({
      oldProse: 'digest',
      recentTurns: 5,
      proseModel: 'sonnet',
    });
    expect(resolveHookConfig({ oldProse: 'maybe', recentTurns: 'x' })).not.toHaveProperty('oldProse');
    expect(resolveHookConfig({})).not.toHaveProperty('recentTurns');
  });

  it('carries the endpoint and the key file through', () => {
    expect(
      resolveHookConfig({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', envFile: '/tmp/.env' }),
    ).toMatchObject({
      baseUrl: 'https://openrouter.ai/api/alpha/decisions',
      envFile: '/tmp/.env',
    });
    expect(resolveHookConfig({ baseUrl: '', envFile: '' })).not.toHaveProperty('baseUrl');
  });
});

/** A `$` stand-in holding only what `getApiKey` reaches for. */
function keyEngine(options: {
  env?: Record<string, string>;
  settings?: Record<string, unknown>;
  files?: Record<string, string>;
}) {
  return {
    env: { get: async (name: string) => options.env?.[name] },
    settings: { read: async () => options.settings ?? {} },
    fs: {
      read: async (path: string) => {
        const text = options.files?.[path];
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
    },
  };
}

describe('api key resolution', () => {
  it('prefers the option, then the environment, then the settings', async () => {
    const config = resolveHookConfig({});
    expect(await getApiKey(keyEngine({ env: { TYPESAFE_API_KEY: 'env' } }), { ...config, apiKey: 'opt' })).toBe('opt');
    expect(await getApiKey(keyEngine({ env: { TYPESAFE_API_KEY: 'env' } }), config)).toBe('env');
    expect(await getApiKey(keyEngine({ env: { OPENROUTER_API_KEY: 'or' } }), config)).toBe('or');
    expect(
      await getApiKey(keyEngine({ settings: { env: { TYPESAFE_API_KEY: 'set' } } }), config),
    ).toBe('set');
    expect(await getApiKey(keyEngine({}), config)).toBeUndefined();
  });

  it('falls back to the dotenv file, and past a file it cannot read', async () => {
    const config = { ...resolveHookConfig({}), envFile: '/tmp/.env' };
    const engine = keyEngine({ files: { '/tmp/.env': 'OPENROUTER_API_KEY=from-file\n' } });
    expect(await getApiKey(engine, config)).toBe('from-file');
    // A missing file is not an error: the key is simply not there.
    expect(await getApiKey(keyEngine({}), config)).toBeUndefined();
    expect(await getApiKey(keyEngine({}), { ...config, envFile: undefined })).toBeUndefined();
  });
});

describe('dotenv reading', () => {
  it('reads assignments, skips comments and blanks, honours quotes', () => {
    const text = [
      '# a comment',
      '',
      'OPENROUTER_API_KEY=sk-or-v1-abc',
      'QUOTED="sk with spaces"',
      "SINGLE='sk-single'",
      'TRAILING=sk-value # not part of it',
      'EMPTY=',
      'BROKEN LINE',
      'OPENROUTER_API_KEY=last-wins',
    ].join('\n');
    expect(parseEnv(text)).toEqual({
      OPENROUTER_API_KEY: 'last-wins',
      QUOTED: 'sk with spaces',
      SINGLE: 'sk-single',
      TRAILING: 'sk-value',
      EMPTY: '',
    });
  });

  it('prefers the TypeSafe name over the OpenRouter one', async () => {
    const engine = keyEngine({
      files: { '.env': 'TYPESAFE_API_KEY=ts\nOPENROUTER_API_KEY=or\n' },
    });
    expect(await dotenvKey(engine, '.env')).toBe('ts');
  });
});

describe('compaction deadline', () => {
  it('accepts a positive timeout and defaults invalid values', () => {
    expect(resolveHookConfig({ compactionTimeoutMs: 2500 }).compactionTimeoutMs).toBe(2500);
    for (const value of [0, -1, NaN, Infinity, '15000']) {
      expect(resolveHookConfig({ compactionTimeoutMs: value }).compactionTimeoutMs).toBe(15000);
    }
  });

  it('cancels the timer when work succeeds or throws', async () => {
    for (const fails of [false, true]) {
      let timerSignal: AbortSignal | undefined;
      const pending = withCompactionDeadline(async () => {
        if (fails) throw new Error('request failed');
        return 'done';
      }, 1234, (ms, { signal }) => {
        expect(ms).toBe(1234);
        timerSignal = signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))));
      });
      if (fails) await expect(pending).rejects.toThrow('request failed');
      else await expect(pending).resolves.toBe('done');
      expect(timerSignal?.aborted).toBe(true);
    }
  });

  it('settles at the deadline even if work is still pending and rejects later', async () => {
    let expire!: () => void;
    let rejectWork!: (error: Error) => void;
    const work = new Promise<never>((_resolve, reject) => { rejectWork = reject; });
    const pending = withCompactionDeadline(() => work, 1234, () => new Promise((resolve) => { expire = resolve; }));
    const assertion = expect(pending).rejects.toThrow('Jev compaction timed out after 1234ms');
    expire();
    await assertion;
    rejectWork(new Error('late request failure'));
  });
});

describe('post-compaction target', () => {
  const stats = { charsBefore: 1000, charsAfter: 500 };

  it('scales the usage percent by the character ratio', () => {
    expect(estimatePostCompactPercent(80, stats)).toBe(40);
  });

  it('falls back above the target, accepts at or below it and when usage is missing', () => {
    expect(exceedsTarget(estimatePostCompactPercent(100, stats), 45)).toBe(true);
    expect(exceedsTarget(estimatePostCompactPercent(90, stats), 45)).toBe(false);
    expect(exceedsTarget(estimatePostCompactPercent(undefined, stats), 45)).toBe(false);
    expect(estimatePostCompactPercent(80, { charsBefore: 0, charsAfter: 0 })).toBeUndefined();
  });
});

describe('session message mapping', () => {
  /** Maps `messages` after dropping the first call's result and keeping the second call whole. */
  function dropFirstResult(messages: SessionMessage[]) {
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    return toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
  }

  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = dropFirstResult(messages);
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const out = dropFirstResult(messages);
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ keepMode: 'threshold', preserveRecentMessages: 1, dropCalls: true }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages[0]!.text).toMatch(/^\[fast-jev-compaction note\] .*1 tool calls dropped/);
    expect(withoutCompactionNote(messages).map((m) => m.handle)).toEqual(['h-0', 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ keepMode: 'threshold', preserveRecentMessages: 1, dropCalls: true }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('sends the request to the configured endpoint', async () => {
    const urls: string[] = [];
    const openrouter = 'https://openrouter.ai/api/alpha/decisions';
    await jevAsker(async (url) => {
      urls.push(url);
      return { status: 200, ok: true, text: JSON.stringify({ answers: { call_t1: { noul: 0.9 } } }) };
    }, 'k', 'jev-x', openrouter).ask('state', { call_t1: { type: 'noul', instructions: 'keep?' } });
    expect(urls).toEqual([openrouter]);

    // The whole chain, so the config option really reaches the request.
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', baseUrl: openrouter };
    await compactSession(transcript(), config, async (url, init) => {
      urls.push(url);
      return jevFetch(() => 0.9)(url, init);
    });
    expect(urls).toEqual([openrouter, openrouter]);
  });

  it('reaches the TypeSafe endpoint when no baseUrl is set', async () => {
    const urls: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    await compactSession(transcript(), config, async (url, init) => {
      urls.push(url);
      return jevFetch(() => 0.1)(url, init);
    });
    expect(urls).toEqual(['https://api.typesafe.ai/v1/systemone']);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ keepMode: 'threshold', preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});

describe('registered compaction hooks', () => {
  /** A host whose every call is a spy, for checking what the hook never calls. */
  const spyHost = () => ({
    env: { get: vi.fn() },
    settings: { read: vi.fn() },
    http: { fetch: vi.fn() },
    ui: { log: vi.fn(), toast: vi.fn() },
  });

  /** The turn.complete hook with spied usage, compact and next. */
  function turnHook(options: Record<string, unknown>, usage: ReturnType<typeof vi.fn>) {
    const handler = registeredHooks(options).get('turn.complete')!;
    const compact = vi.fn(async () => ({}));
    const next = vi.fn(async (event) => event);
    const host = { session: { usage, compact }, ui: { log: vi.fn() } };
    return { handler, usage, compact, next, host };
  }

  it('does not send speculative precompute transcripts to Jev', async () => {
    const hooks = registeredHooks();
    const handler = hooks.get('session.compact')!;
    const next = vi.fn(async (event) => event);
    const host = spyHost();
    const event = { trigger: 'precompute', messages: [] };

    const result = await handler(host, event, next);

    expect(result).toMatchObject({ skip: expect.any(String) });
    expect(next).not.toHaveBeenCalled();
    expect(host.http.fetch).not.toHaveBeenCalled();
  });

  it('passes subagent and fork compactions through without calling Jev', async () => {
    const hooks = registeredHooks();
    const handler = hooks.get('session.compact')!;
    const next = vi.fn(async (event) => ({ messages: event.messages }));
    const host = spyHost();
    const events = [
      { trigger: 'manual', agentId: 'agent-1', messages: [] },
      { trigger: 'precompute', agentId: 'fork-1', messages: [] },
    ];

    for (const event of events) await handler(host, event, next);

    expect(next).toHaveBeenNthCalledWith(1, events[0]);
    expect(next).toHaveBeenNthCalledWith(2, events[1]);
    expect(host.http.fetch).not.toHaveBeenCalled();
  });

  it('only auto-compacts completed main-agent answers', async () => {
    const { handler, usage, compact, next, host } = turnHook(
      { compactAtPercent: 1 },
      vi.fn(async () => ({ context: { percent: 100 } })),
    );

    for (const event of [
      turnComplete({ reason: 'aborted', isAborted: true }),
      turnComplete({ reason: 'refusal' }),
      turnComplete({ reason: 'error' }),
      turnComplete({ agentId: 'agent-1' }),
    ]) {
      await handler(host, event, next);
    }

    expect(usage).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(4);
  });

  it('auto-compacts a main-session answer when usage reaches the configured threshold', async () => {
    const event = turnComplete();
    const { handler, usage, compact, next, host } = turnHook(
      { compactAtPercent: 60 },
      vi.fn(async () => ({ context: { percent: 75 } })),
    );

    const result = await handler(host, event, next);

    expect(usage).toHaveBeenCalledOnce();
    expect(compact).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(event);
    expect(result).toBe(event);
  });

  it('claims the auto-compaction guard before awaiting usage and releases it after completion', async () => {
    const firstUsage = deferred<{ context: { percent: number } }>();
    const secondUsage = deferred<{ context: { percent: number } }>();
    const { handler, usage, compact, next, host } = turnHook(
      { compactAtPercent: 60 },
      vi.fn().mockReturnValueOnce(firstUsage.promise).mockReturnValueOnce(secondUsage.promise),
    );

    const first = handler(host, turnComplete(), next);
    const concurrent = handler(host, turnComplete({ turnId: 'turn-2' }), next);
    firstUsage.resolve({ context: { percent: 30 } });
    secondUsage.resolve({ context: { percent: 30 } });
    await Promise.all([first, concurrent]);

    expect(usage).toHaveBeenCalledTimes(1);
    expect(compact).not.toHaveBeenCalled();

    const afterRelease = handler(host, turnComplete({ turnId: 'turn-3' }), next);
    expect(usage).toHaveBeenCalledTimes(2);
    secondUsage.resolve({ context: { percent: 30 } });
    await afterRelease;
  });
});

type Hook = ($: unknown, event: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>;

/** The hooks `register` installs, keyed by event, with the given plugin options. */
function hooks(options: Record<string, unknown> = {}): Record<string, Hook> {
  const registered: Record<string, Hook> = {};
  const on = (event: string, hook: Hook) => {
    registered[event] = hook;
  };
  (register as unknown as (on: unknown, options: unknown) => void)(on, options);
  return registered;
}

function host(fetch: ReturnType<typeof jevFetch>) {
  const notices: string[] = [];
  const sinks: (string | undefined)[] = [];
  const toasts: string[] = [];
  const $ = {
    env: { get: async (name: string) => (name === 'TYPESAFE_API_KEY' ? 'k' : undefined) },
    settings: { read: async () => ({}) },
    http: { fetch },
    // The retry wait passes at once; the compaction deadline never arrives.
    clock: { sleep: (ms: number) => (ms <= RETRY_DELAY_MS ? Promise.resolve() : new Promise<void>(() => {})) },
    ui: {
      log: (text: string, options?: { to?: string }) => {
        notices.push(text);
        sinks.push(options?.to);
      },
      toast: (text: string) => toasts.push(text),
    },
  };
  return { $, notices, sinks, toasts };
}

const CORE = { messages: ['built-in summary'] };

async function compactWith(
  trigger: string,
  fetch: ReturnType<typeof jevFetch>,
  options: Record<string, unknown> = {},
) {
  const { $, notices, sinks, toasts } = host(fetch);
  let delegated = false;
  const out = await hooks({ preserveRecentMessages: 1, ...options })['session.compact']!(
    $,
    { trigger, messages: transcript() },
    async () => {
      delegated = true;
      return CORE;
    },
  );
  return { out, delegated, notices, sinks, toasts };
}

describe('compaction output on screen', () => {
  it('sends every log line to the debug log and shows one short toast', async () => {
    const cases = [
      { trigger: 'manual', fetch: jevFetch(() => 0.1), toast: /^fast-jev: compacted, \d+% smaller \(\d+\/7 messages\)$/ },
      { trigger: 'manual', fetch: jevFetch(() => 0.9), toast: /^fast-jev: not compacted \(below 25% minimum\)$/ },
      { trigger: 'auto', fetch: jevFetch(() => 0.9), toast: /^fast-jev: built-in summary \(below 25% minimum\)$/ },
      { trigger: 'auto', fetch: failing, toast: /^fast-jev: built-in summary \(.*500.*\)$/ },
    ];
    for (const c of cases) {
      const { notices, sinks, toasts } = await compactWith(c.trigger, c.fetch, { keepMode: 'threshold', dropCalls: true });
      expect(notices.some((line) => line.startsWith('decisions'))).toBe(c.fetch !== failing);
      expect(sinks.every((to) => to === 'debug')).toBe(true);
      expect(toasts).toHaveLength(1);
      expect(toasts[0]).toMatch(c.toast);
      expect(toasts[0]!.length).toBeLessThanOrEqual(120);
    }
  });
});

const failing = async () => ({ status: 500, ok: false, text: 'upstream error' });

describe('built-in summary fallback', () => {
  it('is only for the engine auto compaction by default', () => {
    expect(mayUseBuiltin('auto', 'auto')).toBe(true);
    for (const trigger of ['manual', 'plugin', 'precompute', undefined]) {
      expect(mayUseBuiltin(trigger, 'auto')).toBe(false);
      expect(mayUseBuiltin(trigger, 'always')).toBe(true);
      expect(mayUseBuiltin(trigger, 'never')).toBe(false);
    }
    expect(mayUseBuiltin('auto', 'never')).toBe(false);
  });

  it('installs a Jev result that clears the minimum on any trigger', async () => {
    for (const trigger of ['manual', 'auto']) {
      const { out, delegated, notices } = await compactWith(trigger, jevFetch(() => 0.1), { keepMode: 'threshold', dropCalls: true });
      expect(delegated).toBe(false);
      expect((out as { messages: unknown[] }).messages.length).toBeLessThan(transcript().length);
      expect(notices.at(-1)).toMatch(/^kept \d+\/7 messages, no summary/);
    }
  });

  it('leaves a /compact that Jev cannot shrink as it is', async () => {
    const { out, delegated, notices } = await compactWith('manual', jevFetch(() => 0.9));
    expect(delegated).toBe(false);
    expect(out).toEqual({
      skip: expect.stringMatching(/^fast-jev-compaction: below 25% minimum: 0% reduction; .*; conversation left as it is$/),
    });
    expect(notices.at(-1)).toMatch(/^not compacted, no built-in summary \(below 25% minimum/);
  });

  it('hands an engine auto compaction that Jev cannot shrink to the built-in summary', async () => {
    const { out, delegated, notices } = await compactWith('auto', jevFetch(() => 0.9));
    expect(delegated).toBe(true);
    expect(out).toBe(CORE);
    expect(notices.at(-1)).toMatch(/^fallback to built-in summary \(below 25% minimum/);
  });

  it('skips on a Jev failure unless the engine itself is compacting', async () => {
    // precompute never reaches Jev (skipped up front, see 'registered compaction hooks').
    for (const trigger of ['manual', 'plugin']) {
      const { out, delegated } = await compactWith(trigger, failing);
      expect(delegated).toBe(false);
      expect(out).toEqual({ skip: expect.stringMatching(/500.*; conversation left as it is$/) });
    }
    const { out, delegated } = await compactWith('auto', failing);
    expect(delegated).toBe(true);
    expect(out).toBe(CORE);
  });

  it('keeps the skip notice to one short line', async () => {
    const long = async () => ({ status: 403, ok: false, text: `<!DOCTYPE html>${'x'.repeat(2000)}` });
    const { out } = await compactWith('manual', long);
    expect((out as { skip: string }).skip.length).toBeLessThan(300);
  });

  it('follows builtinFallback always and never', async () => {
    expect((await compactWith('manual', jevFetch(() => 0.9), { builtinFallback: 'always' })).out).toBe(CORE);
    expect((await compactWith('auto', jevFetch(() => 0.9), { builtinFallback: 'never' })).out).toEqual({
      skip: expect.stringMatching(/conversation left as it is$/),
    });
  });
});

describe('turn.complete request', () => {
  function driver() {
    const hook = hooks()['turn.complete']!;
    const state = { percent: 0, answer: { skip: 'nothing to prune' } as { skip?: string }, requested: [] as number[] };
    const $ = {
      session: {
        usage: async () => ({ context: { percent: state.percent } }),
        compact: async () => {
          state.requested.push(state.percent);
          return state.answer;
        },
      },
      ui: { log: () => {} },
    };
    const turn = async (percent: number) => {
      state.percent = percent;
      await hook($, turnComplete(), async () => ({}));
    };
    return { state, turn };
  }

  it('asks again after a skipped request only once the context has grown', async () => {
    const { state, turn } = driver();
    for (const percent of [50, 61, 65, 70, 71]) await turn(percent);
    state.answer = {};
    for (const percent of [81, 62]) await turn(percent);
    expect(state.requested).toEqual([61, 71, 81, 62]);
  });

  it('forgets the wait once the context drops below compactAtPercent', async () => {
    const { state, turn } = driver();
    for (const percent of [61, 65, 30, 61]) await turn(percent);
    expect(state.requested).toEqual([61, 61]);
  });
});

describe('auto-compaction at compactAtPercent', () => {
  function turnEnd(compact: () => Promise<unknown>) {
    const hooks: Record<string, (...args: any[]) => Promise<any>> = {};
    register(((name: string, hook: any) => void (hooks[name] = hook)) as never, { compactAtPercent: 50 } as never);
    const commands: string[] = [];
    const log: string[] = [];
    const $ = {
      session: { usage: async () => ({ context: { percent: 80 } }), compact },
      command: { run: async (input: { command: string }) => (commands.push(input.command), { text: '' }) },
      ui: { log: (text: string) => log.push(text) },
      env: { get: async () => undefined },
    };
    const run = () => hooks['turn.complete']!($, { reason: 'answer' }, async () => ({ text: 'answer' }));
    return { run, commands, log };
  }

  it('compacts through $.session.compact where the host has it', async () => {
    let compacted = 0;
    const t = turnEnd(async () => (compacted += 1, { messages: [] }));
    expect(await t.run()).toEqual({ text: 'answer' });
    expect(compacted).toBe(1);
    expect(t.commands).toEqual([]);
  });

  it('queues /compact where a headless (SDK) session refuses $.session.compact', async () => {
    const t = turnEnd(async () => {
      throw new Error(
        'fast-jev-compaction: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on',
      );
    });
    expect(await t.run()).toEqual({ text: 'answer' });
    expect(t.commands).toEqual(['compact']);
    expect(t.log).toEqual([]);
  });

  it('only logs any other refusal', async () => {
    const t = turnEnd(async () => {
      throw new Error('rejects while a turn runs');
    });
    await t.run();
    expect(t.commands).toEqual([]);
    expect(t.log).toEqual(['auto-compact skipped (rejects while a turn runs)']);
  });

  it('does not queue /compact again until the context has grown', async () => {
    const t = turnEnd(async () => {
      throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet');
    });
    await t.run();
    await t.run();
    expect(t.commands).toEqual(['compact']);
  });
});

describe('old prose through the hook', () => {
  const turns = (n: number): { role: 'user' | 'assistant'; text: string; toolUses: never[] }[] =>
    Array.from({ length: n }, (_, i) => [
      { role: 'user' as const, text: `prompt ${i} ${'detail '.repeat(100)}`, toolUses: [] },
      { role: 'assistant' as const, text: `reply ${i} ${'narration '.repeat(100)}`, toolUses: [] },
    ]).flat();

  async function run(options: Record<string, unknown>, complete?: (r: unknown) => Promise<string | null>) {
    const { $, notices } = host(jevFetch(() => 0.1));
    const reply = complete ?? (async () => 'MODEL SUMMARY');
    (($ as unknown) as { model: unknown }).model = {
      complete: async (r: unknown) => {
        const text = await reply(r);
        return text === null
          ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' }
          : { isAnswered: true, text };
      },
    };
    const messages = turns(12);
    const out = (await hooks({ preserveRecentMessages: 2, ...options })['session.compact']!(
      $,
      { trigger: 'manual', messages },
      async () => ({ messages: [] }),
    )) as { messages: { role: string; text: string; handle?: string }[] };
    return { out, notices, messages };
  }

  it('digest replaces the old prefix and leaves the recent turns', async () => {
    const { out, messages } = await run({ oldProse: 'digest', recentTurns: 3 });
    const history = withoutCompactionNote(out.messages);
    expect(history[0]!.text).toMatch(/^\[fast-jev-compaction digest of 9 earlier turns.*; the recall tool reads them back/);
    expect(out.messages.at(-1)!.text).toBe(messages.at(-1)!.text);
    expect(history).toHaveLength(2 + 3 * 2);
  });

  it('summarize asks the session model with proseModel and installs its reply', async () => {
    const requests: { model: string; maxTokens: number }[] = [];
    const { out } = await run({ oldProse: 'summarize', recentTurns: 3, proseModel: 'sonnet' }, async (r) => {
      requests.push(r as { model: string; maxTokens: number });
      return 'MODEL SUMMARY';
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: 'sonnet', maxTokens: 3000 });
    expect(withoutCompactionNote(out.messages)[0]!.text).toBe('[fast-jev-compaction summary of 9 earlier turns]\nMODEL SUMMARY');
  });

  it('summarize falls back to the digest when the model does not answer', async () => {
    const { out } = await run({ oldProse: 'summarize', recentTurns: 3 }, async () => null);
    expect(withoutCompactionNote(out.messages)[0]!.text).toMatch(/^\[fast-jev-compaction digest of 9 earlier turns/);
  });

  it('keep makes no model call', async () => {
    let called = false;
    await run({ oldProse: 'keep' }, async () => {
      called = true;
      return 'x';
    });
    expect(called).toBe(false);
  });

  const digestMarker = /^\[fast-jev-compaction digest of (\d+) earlier turns/;
  // A result larger than all the prose, which Jev cuts: verbatim prose clears the guards.
  const shrinkable = () => [
    ...turns(12),
    call('big', 'Read', { file_path: 'src/big.ts' }, ''),
    result('big', 'x'.repeat(50_000)),
    message('assistant', 'Read it.'),
    message('user', 'next'),
  ];
  async function compactPlain(options: Record<string, unknown>, messages: unknown[]) {
    const { $, notices } = host(jevFetch(() => 0.1));
    // threshold: every result Jev scores 0.1 is cut, whatever its size.
    const out = (await hooks({ preserveRecentMessages: 2, recentTurns: 3, keepMode: 'threshold', ...options })[
      'session.compact'
    ]!(
      $,
      { trigger: 'manual', messages },
      async () => ({ messages: [] }),
    )) as { messages?: { text: string }[]; skip?: string };
    return { out, notices };
  }

  it('keeps old prose verbatim by default while that frees enough', async () => {
    const { out } = await compactPlain({}, shrinkable());
    expect(out.skip).toBeUndefined();
    expect(out.messages).toBeDefined();
    expect(out.messages!.some((m) => digestMarker.test(m.text))).toBe(false);
  });

  it('digests old prose by default when verbatim prose would be refused', async () => {
    const { out, notices } = await run({ recentTurns: 3 });
    expect(withoutCompactionNote(out.messages)[0]!.text).toMatch(digestMarker);
    expect(notices.at(-1)).toMatch(/old prose digest: .*; verbatim prose was refused \(below 25% minimum/);
  });

  it('starts with the digest once the conversation holds one', async () => {
    const earlier = [
      message('user', '[fast-jev-compaction digest of 5 earlier turns; tool calls, results and intermediate narration were dropped]\n• first prompt: hi'),
      message('assistant', 'Understood. Continuing from the earlier-turns digest above.'),
    ];
    const { out } = await compactPlain({}, [...earlier, ...shrinkable()]);
    const turnsDigested = Number(digestMarker.exec(withoutCompactionNote(out.messages!)[0]!.text)?.[1]);
    expect(turnsDigested).toBeGreaterThan(5);
  });

  it('does not retry when there is no prose old enough to digest', async () => {
    const asked = async (options: Record<string, unknown>) => {
      const bodies: string[] = [];
      const { $ } = host(jevFetch(() => 0.9, bodies));
      await hooks(options)['session.compact']!($, { trigger: 'manual', messages: transcript() }, async () => ({}));
      return bodies.length;
    };
    expect(await asked({})).toBe(await asked({ oldProse: 'keep' }));
  });

  it('gives the digest only what is left of compactionTimeoutMs', async () => {
    const waits: number[] = [];
    const { $ } = host(jevFetch(() => 0.1));
    (($ as unknown) as { clock: unknown }).clock = {
      sleep: (ms: number) => {
        if (ms > RETRY_DELAY_MS) waits.push(ms);
        return ms <= RETRY_DELAY_MS ? Promise.resolve() : new Promise<void>(() => {});
      },
    };
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 2_000));
    try {
      await hooks({ preserveRecentMessages: 2, recentTurns: 3, compactionTimeoutMs: 15_000 })['session.compact']!(
        $,
        { trigger: 'manual', messages: turns(12) },
        async () => ({}),
      );
    } finally {
      clock.mockRestore();
    }
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeLessThanOrEqual(15_000);
    expect(waits[1]).toBeLessThan(waits[0]!);
  });

  it('names the verbatim refusal when the digest is refused too', async () => {
    const { out } = await compactPlain({ minReductionRatio: 0.99 }, turns(12));
    expect(out.skip).toMatch(/verbatim prose refused \(below 99% minimum\); digest: below 99% minimum/);
  });

  it('starts verbatim after a summary, which is not a digest', async () => {
    const summary = '[fast-jev-compaction summary of 5 earlier turns]\nWe set up the build.';
    const earlier = [message('user', summary), message('assistant', 'Understood. Continuing from the earlier-turns summary above.')];
    const { out } = await compactPlain({}, [...earlier, ...shrinkable()]);
    expect(withoutCompactionNote(out.messages!)[0]!.text).toBe(summary);
  });

  it('does not retry an explicit oldProse: keep', async () => {
    const { out } = await compactPlain({ oldProse: 'keep' }, turns(12));
    expect(out.skip).toMatch(/below 25% minimum/);
  });
});
