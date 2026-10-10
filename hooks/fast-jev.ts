import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { parseEnv } from '../src/dotenv.js';
import { redactDeep } from '../src/redact.js';
import { DEFAULT_MODEL, JevTransportError } from '../src/request.js';
import { dropTransientReminders, foldHiddenContent, hiddenContent, type ApiMessage } from '../src/hidden.js';
import { DECISIONS_MODEL, wireFor, type JevProvider } from '../src/decisions.js';
import {
  RECALL_DESCRIPTION,
  RECALL_INPUT_SCHEMA,
  RECALL_NAME,
  recallCommand,
  recallRequest,
} from '../src/recall/tool.ts';
import { parseCondensed, type ProseSummarizer } from '../src/prose.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

/**
 * Which compactions Jev could not do may go on to Claude Code's built-in
 * summary: `auto` (default) only the engine's own, `always` every one,
 * `never` none.
 */
export type BuiltinFallback = 'auto' | 'always' | 'never';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  targetPercent: 45,
  model: DEFAULT_MODEL,
  compactionTimeoutMs: 15_000,
  builtinFallback: 'auto' as BuiltinFallback,
  proseModel: 'haiku',
};

/** Characters of a cut result's head once old prose is digested, unless `truncateHeadChars` is set. */
const DIGEST_HEAD_CHARS = 100;

/**
 * The old-prose settings each compaction tries in order, the first that clears
 * the size guards winning. A set `oldProse` is used as it is. Unset, old prose
 * stays verbatim, which suits sessions that compact once or twice; when that
 * would be refused, or once the conversation already holds a digest, the old
 * prose is digested and cut results keep shorter heads. Replaying long
 * sessions, verbatim prose let each compaction end higher than the last until
 * compaction was refused for good; switching to the digest kept it bounded.
 */
export function prosePlans(config: HookConfig, messages: readonly Message[]): Partial<CompactOptions>[] {
  if (config.oldProse) return [{}];
  const digest: Partial<CompactOptions> = {
    oldProse: 'digest',
    truncateHeadChars: config.truncateHeadChars ?? DIGEST_HEAD_CHARS,
  };
  if (messages.some((message) => parseCondensed(message))) return [digest];
  return [{ oldProse: 'keep' }, digest];
}

/**
 * Percentage points the context must grow by after a skipped `turn.complete`
 * request before the next one, so a conversation with nothing left to prune
 * is not re-scored after every turn.
 */
const RETRY_AFTER_SKIP_PERCENT = 10;

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  /** Who scores the calls: `jev` (default) or `openai` (OpenAI's Decisions API). */
  provider: JevProvider;
  apiKey?: string;
  /** Jev endpoint; unset reaches TypeSafe directly, as the library defaults to. */
  baseUrl?: string;
  /** A dotenv file to read the key from when the environment has none. */
  envFile?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  targetPercent: number;
  model: string;
  compactionTimeoutMs: number;
  builtinFallback: BuiltinFallback;
  /** Offer the recall tool, and point cut notes at it (default true). */
  recall: boolean;
  /** Recall's cross-session search through a qmd index when qmd is installed (`auto`, default), or never (`off`). */
  sessionIndex: 'auto' | 'off';
  /** Model alias or id `oldProse: 'summarize'` writes its summary with, through the session's own client. */
  proseModel: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionFallback(options: PluginOptions): BuiltinFallback {
  const value = options['builtinFallback'];
  return value === 'auto' || value === 'always' || value === 'never'
    ? value
    : HOOK_DEFAULTS.builtinFallback;
}

/**
 * Whether a compaction Jev could not do may be handed to the built-in summary.
 * Only the engine's `auto` compaction (its threshold, or a prompt too long)
 * must shrink the conversation; `/compact` (`manual`), a plugin's request and
 * a `precompute` can leave it as it is, which is free, where the summary is a
 * long model call that rewrites the verbatim history.
 */
export function mayUseBuiltin(trigger: string | undefined, mode: BuiltinFallback): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return trigger === 'auto';
}

/** The model to ask: the configured one, else the provider's; a Jev name never goes to OpenAI. */
function providerModel(provider: JevProvider, configured: string | undefined): string {
  if (provider === 'openai') return configured && !configured.startsWith('jev') ? configured : DECISIONS_MODEL;
  return configured ?? HOOK_DEFAULTS.model;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const provider: JevProvider = options['provider'] === 'openai' ? 'openai' : 'jev';
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'keepResultTokens',
    'keepCallTokens',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'maxConcurrentRequests',
    'truncateHeadChars',
    'hostTextHeadChars',
    'taskResultHeadChars',
    'recentTurns',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  if (typeof options['dropCalls'] === 'boolean') {
    numbers.dropCalls = options['dropCalls'];
  }
  if (typeof options['trimHostText'] === 'boolean') {
    numbers.trimHostText = options['trimHostText'];
  }
  const config: HookConfig = {
    ...numbers,
    ...(options['oldProse'] === 'keep' ||
    options['oldProse'] === 'summarize' ||
    options['oldProse'] === 'digest'
      ? { oldProse: options['oldProse'] }
      : {}),
    ...(options['keepMode'] === 'threshold' || options['keepMode'] === 'rank'
      ? { keepMode: options['keepMode'] }
      : {}),
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    targetPercent: optionNumber(options, 'targetPercent', HOOK_DEFAULTS.targetPercent),
    provider,
    model: providerModel(provider, optionString(options, 'model')),
    compactionTimeoutMs: optionNumber(options, 'compactionTimeoutMs', HOOK_DEFAULTS.compactionTimeoutMs),
    builtinFallback: optionFallback(options),
    recall: options['recall'] !== false,
    sessionIndex: options['sessionIndex'] === 'off' ? 'off' : 'auto',
    proseModel: optionString(options, 'proseModel') ?? HOOK_DEFAULTS.proseModel,
  };
  if (config.compactionTimeoutMs <= 0) config.compactionTimeoutMs = HOOK_DEFAULTS.compactionTimeoutMs;
  // `apiKey` and `baseUrl` belong to Jev: with openai they are ignored, so a
  // TypeSafe key or a Jev gateway never receives an OpenAI request, and the
  // OpenAI key comes from OPENAI_API_KEY alone.
  if (provider === 'jev') {
    const apiKey = optionString(options, 'apiKey');
    if (apiKey) config.apiKey = apiKey;
    const baseUrl = optionString(options, 'baseUrl');
    if (baseUrl) config.baseUrl = baseUrl;
  }
  const envFile = optionString(options, 'envFile');
  if (envFile) config.envFile = envFile;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. Secrets are redacted from what is sent (`onRedact` gets the count). */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string,
  baseUrl?: string,
  onRedact: (count: number) => void = () => {},
  provider: JevProvider = 'jev',
): JevAsker {
  const wire = wireFor(provider);
  return {
    async ask(state, questions) {
      const safeState = redactDeep(state, [apiKey]);
      const safeQuestions = redactDeep(questions, [apiKey]);
      onRedact(safeState.count + safeQuestions.count);
      const request = wire.build(
        { apiKey, model, baseUrl },
        safeState.value,
        safeQuestions.value,
      );
      let response: HookFetchResponse;
      try {
        response = await fetchFn(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
      } catch (error) {
        throw new JevTransportError(error);
      }
      return wire.parse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
  onRedact?: (count: number) => void,
  summarize?: ProseSummarizer,
  sleep?: (ms: number) => Promise<void>,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error(`${wireFor(config.provider).keyName} is not configured`);
  const result = await compact(
    messages,
    jevAsker(fetchFn, config.apiKey, config.model, config.baseUrl, onRedact, config.provider),
    { ...config, recallNotes: config.recall },
    { summarize, sleep },
  );
  return { result, messages: toSessionMessages(messages, result.messages) };
}

/**
 * Drops the engine's `handle` so each kept message is persisted as a fresh record
 * after the compact boundary. With handles, kept tool_result records keep a
 * parentUuid behind the boundary and kept assistant records keep their
 * message.id, so `--resume` walks back into the full pre-compaction history
 * (fast-jev-compaction#89, anthropics/claude-code#95328). Costs each record its
 * group of hidden entries (skill bodies, prompts typed while a tool ran,
 * attachments, images); the hook folds those back as text first (src/hidden.ts).
 *
 * The engine hands over one message per record, and a response with parallel
 * calls is several assistant records sharing a message.id. Fresh records get
 * fresh ids, so adjacent assistant messages are merged back into one; left
 * apart, every call but the last loses its result to the engine's pairing repair.
 */
export function withoutHandles(messages: readonly SessionMessage[]): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const { handle: _handle, ...message } of messages) {
    const prev = out.at(-1);
    if (prev?.role === 'assistant' && message.role === 'assistant') {
      out[out.length - 1] = {
        ...prev,
        text: [prev.text, message.text].filter(Boolean).join('\n\n'),
        toolUses: [...prev.toolUses, ...message.toolUses],
      };
    } else {
      out.push(message);
    }
  }
  return out;
}

class CompactionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Jev compaction timed out after ${timeoutMs}ms`);
  }
}

/** Bound the entire Jev round, including all batches, using the host's clock. */
export async function withCompactionDeadline<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  sleep: (ms: number, options: { signal: AbortSignal }) => Promise<void>,
): Promise<T> {
  const timer = new AbortController();
  const deadline = sleep(timeoutMs, { signal: timer.signal }).then(() => {
    throw new CompactionTimeoutError(timeoutMs);
  });
  try {
    // Race observes late rejections too. A late response cannot install a
    // second compaction after the deadline has already settled this round.
    return await Promise.race([Promise.resolve().then(work), deadline]);
  } finally {
    timer.abort();
  }
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.callsStubbed > 0 ? `${stats.callsStubbed} call_stubbed` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
    stats.oldProse !== 'keep'
      ? `old prose ${stats.oldProse}: ${stats.oldProseReplaced} messages, ${stats.oldProseCharsBefore}→${stats.oldProseCharsAfter} chars`
      : '',
    stats.hostTextTrimmed > 0
      ? `${stats.hostTextTrimmed} host notices trimmed (${stats.hostCharsTrimmed} chars)`
      : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)${
    stats.requestsFailed > 0
      ? `, ${stats.requestsFailed} failed (calls kept${stats.requestError ? `; ${stats.requestError}` : ''})`
      : ''
  }`;
}

/**
 * Context percent after compaction, assuming the window shrinks like the
 * transcript's characters. Undefined when usage or the character counts give
 * nothing to scale.
 */
export function estimatePostCompactPercent(
  percentBefore: number | undefined,
  stats: Pick<CompactResult['stats'], 'charsBefore' | 'charsAfter'>,
): number | undefined {
  if (percentBefore === undefined || !Number.isFinite(percentBefore)) return undefined;
  if (stats.charsBefore <= 0) return undefined;
  return (percentBefore * stats.charsAfter) / stats.charsBefore;
}

/** True when the estimate is known and above `targetPercent`. */
export function exceedsTarget(estimate: number | undefined, targetPercent: number): boolean {
  return estimate !== undefined && estimate > targetPercent;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

/** The variables a provider's key is read from, in order. */
const KEY_NAMES: Record<JevProvider, readonly string[]> = {
  jev: ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY'],
  openai: ['OPENAI_API_KEY'],
};

function settingEnv(settings: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const env = settings['env'];
  if (!env || typeof env !== 'object') return undefined;
  const value = (env as Record<string, unknown>)[name];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * The key the given dotenv file holds, or `undefined` when it cannot be read.
 * An absolute path is read as given; a relative one is under the session's
 * working directory, as `$.fs.read` reads it.
 */
export async function dotenvKey(
  $: { fs: { read: (path: string) => Promise<string> } },
  path: string,
  provider: JevProvider = 'jev',
): Promise<string | undefined> {
  try {
    const parsed = parseEnv(await $.fs.read(path));
    for (const name of KEY_NAMES[provider]) {
      const value = parsed[name];
      if (value) return value;
    }
  } catch {
    // A missing or unreadable file is not an error: the key is simply not there.
  }
  return undefined;
}

export async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
    fs: { read: (path: string) => Promise<string> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  // The names are spelled literally: `claude plugin validate` reads them off
  // this source, and a name it cannot see is refused.
  if (config.provider === 'openai') {
    const fromOpenAi = await $.env.get('OPENAI_API_KEY');
    if (fromOpenAi) return fromOpenAi;
  } else {
    const fromEnv = await $.env.get('TYPESAFE_API_KEY');
    if (fromEnv) return fromEnv;
    const fromOpenRouter = await $.env.get('OPENROUTER_API_KEY');
    if (fromOpenRouter) return fromOpenRouter;
  }
  const settings = await $.settings.read();
  for (const name of KEY_NAMES[config.provider]) {
    const value = settingEnv(settings, name);
    if (value) return value;
  }
  if (config.envFile) return dotenvKey($, config.envFile, config.provider);
  return undefined;
}

type UiLog = { ui: { log: (text: string, options?: { to?: 'debug' }) => void } };

/** Diagnostics go to the debug log (`claude --debug`) only, never the transcript. */
function debugLog($: UiLog, text: string): void {
  $.ui.log(text, { to: 'debug' });
}

/** Lines the compaction log keeps; older ones are dropped. */
export const COMPACTION_LOG_LINES = 200;

type LogHost = UiLog & {
  env: { get: (name: string) => Promise<string | undefined> };
  fs: {
    exists: (path: string) => Promise<boolean>;
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<void>;
  };
};

/** Claude Code's config dir: `CLAUDE_CONFIG_DIR`, else `~/.claude`; undefined without a home. */
export async function configDir($: Pick<LogHost, 'env'>): Promise<string | undefined> {
  const explicit = await $.env.get('CLAUDE_CONFIG_DIR');
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'));
  const base = explicit || (home ? `${home}/.claude` : undefined);
  return base?.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * The plugin's own log, `<config dir>/fast-jev-compaction/compactions.log`.
 * The debug log exists only under `--debug`, never in the desktop app, so each
 * outcome is kept here too.
 */
export async function compactionLogPath($: Pick<LogHost, 'env'>): Promise<string | undefined> {
  const base = await configDir($);
  return base ? `${base}/fast-jev-compaction/compactions.log` : undefined;
}

// $.fs has no append, so a line is a read and a whole write: this session's
// appends run one at a time.
let logQueue: Promise<void> = Promise.resolve();

/** Appends one timestamped line, keeping the newest COMPACTION_LOG_LINES; never throws. */
export function appendCompactionLog($: LogHost, line: string, now: Date = new Date()): Promise<void> {
  const appended = logQueue.then(() => writeCompactionLine($, line, now)).catch(() => undefined);
  logQueue = appended;
  return appended;
}

async function writeCompactionLine($: LogHost, line: string, now: Date): Promise<void> {
  try {
    const path = await compactionLogPath($);
    if (!path) return;
    // Only a missing log starts afresh; one that cannot be read is left alone.
    const previous = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
    const lines = previous.split('\n').filter((l) => l.length > 0);
    lines.push(`${now.toISOString()} ${line.replace(/\s*\n\s*/g, ' ')}`);
    await $.fs.write(path, `${lines.slice(-COMPACTION_LOG_LINES).join('\n')}\n`);
  } catch (error) {
    debugLog($, `compaction log not written (${error instanceof Error ? error.message : String(error)})`);
  }
}

const TOAST_REASON_CHARS = 80;

/**
 * One short toast per compaction; the details go to the debug log and, as
 * one line labelled with the trigger, to the compaction log.
 */
async function notify(
  $: LogHost & { ui: { toast: (text: string, options?: { timeoutMs?: number }) => void } },
  trigger: string,
  detail: string,
  toast: string,
): Promise<void> {
  debugLog($, detail);
  $.ui.toast(`fast-jev: ${toast}`, { timeoutMs: 8_000 });
  await appendCompactionLog($, `${trigger} ${detail}`);
}

/** The head of a fallback reason, before its `: details` part, for a toast. */
function toastReason(why: string): string {
  const head = why.split(': ')[0]!;
  return head.length > TOAST_REASON_CHARS ? `${head.slice(0, TOAST_REASON_CHARS - 1)}…` : head;
}

/** The host's refusal of `$.session.compact` in a headless (-p / SDK) session. */
export function isHeadlessRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.includes('not available in a headless');
}

/** How long one recall answer may take; the first one may download Node. */
const RECALL_TIMEOUT_MS = 120_000;

type RecallHost = {
  plugin: { root: string };
  process: {
    run: (
      argv: readonly string[],
      init?: { cwd?: string; stdin?: string; timeoutMs?: number },
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
};

/** Runs src/recall/cli.ts under the pinned Node of tools/node.cmd, `input` on stdin. */
async function runRecallCli($: RecallHost, input: string, timeoutMs = RECALL_TIMEOUT_MS) {
  const { argv, cwd } = recallCommand($.plugin.root);
  return $.process.run(argv, { ...(cwd && { cwd }), stdin: input, timeoutMs });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  let retryAtPercent = 0;
  let nodeWarmed = false;
  if (configured.recall) {
    on('session.start', async ($, event, next) => {
      const started = await next(event);
      try {
        await $.tool.register({ name: RECALL_NAME, description: RECALL_DESCRIPTION, inputSchema: RECALL_INPUT_SCHEMA });
      } catch (error) {
        debugLog($, `recall: ${error instanceof Error ? error.message : String(error)}`);
      }
      return started;
    });
    // RECALL_TOOL, spelled out so `claude plugin validate` can read the filter.
    on('tool.call', { tool: 'mcp__fast-jev-compaction__recall' }, async ($, e) => {
      try {
        const base = await configDir($);
        if (!base) return { result: 'Recall failed: no config dir (CLAUDE_CONFIG_DIR, HOME or USERPROFILE).' };
        const request = recallRequest(e as Record<string, unknown>);
        const input = { configDir: base, sessionId: await $.session.id(), request, sessionIndex: configured.sessionIndex };
        const run = await runRecallCli($, JSON.stringify(input));
        if (run.exitCode !== 0) return { result: `Recall failed: ${(run.stderr || run.stdout).trim().slice(0, 500)}` };
        return { result: run.stdout };
      } catch (error) {
        return { result: `Recall failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    });
  }

  on('session.compact', async ($, event, next) => {
    if (event.agentId) return next(event);
    if (event.trigger === 'precompute') {
      return { skip: 'fast-jev-compaction does not handle speculative compactions' };
    }
    // Cut notes point at the recall tool from now on: have its Node downloaded
    // before the first call, without holding up the compaction.
    if (configured.recall && !nodeWarmed) {
      nodeWarmed = true;
      void runRecallCli($, '').catch((error: unknown) =>
        debugLog($, `recall: Node not ready (${error instanceof Error ? error.message : String(error)})`),
      );
    }

    const giveUp = async (why: string) => {
      if (mayUseBuiltin(event.trigger, configured.builtinFallback)) {
        await notify($, event.trigger, `fallback to built-in summary (${why})`, `built-in summary (${toastReason(why)})`);
        return next(event);
      }
      await notify($, event.trigger, `not compacted, no built-in summary (${why})`, `not compacted (${toastReason(why)})`);
      const reason = why.length > 200 ? `${why.slice(0, 200)}…` : why;
      return { skip: `fast-jev-compaction: ${reason}; conversation left as it is` };
    };
    try {
      // `/compact <instructions>`: what the user wants kept, for Jev's goal.
      const config = {
        ...configured,
        apiKey: await getApiKey($, configured),
        instructions: event.instructions,
      };
      // A retry with the digest asks Jev much the same questions: each answered
      // request is sent once. A failed one is not kept, so its retry goes out.
      const answers = new Map<string, Promise<HookFetchResponse>>();
      const fetchOnce = (url: string, init?: HookFetchInit): Promise<HookFetchResponse> => {
        const key = `${url}\n${init?.body ?? ''}`;
        const known = answers.get(key);
        if (known) return known;
        const answer = $.http
          .fetch(url, init)
          .then((r: HookFetchResponse) => ({ status: r.status, ok: r.ok, text: r.text }));
        answers.set(key, answer);
        answer.then(
          (r) => r.ok || answers.delete(key),
          () => answers.delete(key),
        );
        return answer;
      };
      let percentBefore: number | undefined;
      try {
        percentBefore = (await $.session.usage()).context.percent;
      } catch {
        percentBefore = undefined;
      }
      let refusal = '';
      let refusedBecause = '';
      for (const [attempt, plan] of prosePlans(configured, event.messages).entries()) {
        const planned = { ...config, ...plan };
        let redacted = 0;
        const { result, messages } = await withCompactionDeadline(
          () =>
            compactSession(
              event.messages,
              planned,
              fetchOnce,
              (count) => {
                redacted += count;
              },
              async ({ system, prompt, maxTokens }) => {
                const reply = await $.model.complete({ model: config.proseModel, system, prompt, maxTokens });
                if (!reply.isAnswered) throw new Error(`prose model did not answer (${reply.reason})`);
                return reply.text;
              },
              (ms) => $.clock.sleep(ms),
            ),
          config.compactionTimeoutMs,
          (ms, options) => $.clock.sleep(ms, options),
        );
        debugLog($, `redacted ${redacted} secret-shaped value(s) from the Jev request`);
        for (const line of decisionLogLines(result)) debugLog($, line);
        // Rows go back without handles, which costs them their hidden content:
        // read it from the API form and fold it back in as text, before the
        // size guards so they measure what is returned. Content after a result
        // Jev cut is cut the same way. Transient reminders an earlier fold left
        // in the rows go first.
        const cleaned = dropTransientReminders(messages);
        let returned = cleaned.messages;
        const afterCleaning = result.stats.charsAfter - cleaned.chars;
        let measured = { ...result, stats: { ...result.stats, charsAfter: afterCleaning } };
        let hiddenNote = cleaned.chars > 0 ? `; ${cleaned.chars} chars of stale reminders dropped` : '';
        try {
          const view = await $.session.messages({ as: 'api' });
          const cutIds = new Set(
            result.decisions.filter((d) => d.action !== 'keep' && d.reason !== 'pinned').map((d) => d.id),
          );
          const fold = foldHiddenContent(cleaned.messages, hiddenContent(event.messages, view as ApiMessage[]), {
            cutIds,
            headChars: resolveOptions(planned).truncateHeadChars,
          });
          returned = fold.messages;
          measured = { ...result, stats: { ...result.stats, charsAfter: afterCleaning + fold.chars } };
          hiddenNote += `; hidden content: ${fold.folded} folded back (${fold.chars} chars)${
            fold.lost > 0 ? `, ${fold.lost} lost` : ''
          }`;
        } catch (error) {
          hiddenNote += `; hidden content not folded (${error instanceof Error ? error.message : String(error)})`;
        }
        const estimate = estimatePostCompactPercent(percentBefore, measured.stats);
        if (reductionRatio(measured) < config.minReductionRatio) {
          refusedBecause = `below ${percent(config.minReductionRatio)} minimum`;
        } else if (exceedsTarget(estimate, config.targetPercent)) {
          refusedBecause = `estimated ~${Math.round(estimate ?? 0)}% context after compaction, above the ${config.targetPercent}% target`;
        } else {
          const retried = attempt > 0 ? `; verbatim prose was refused (${refusedBecause})` : '';
          await notify(
            $,
            event.trigger,
            `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(measured)})${hiddenNote}${retried}`,
            `compacted, ${percent(reductionRatio(measured))} smaller (${messages.length}/${event.messages.length} messages)`,
          );
          return { messages: withoutHandles(returned) };
        }
        refusal = `${refusedBecause}: ${summarize(measured)}${hiddenNote}`;
      }
      return giveUp(refusal);
    } catch (error) {
      if (error instanceof CompactionTimeoutError && event.trigger === 'plugin') {
        await notify($, event.trigger, `not compacted (${error.message})`, `not compacted (${toastReason(error.message)})`);
        return { skip: `fast-jev-compaction: ${error.message}; conversation left unchanged` };
      }
      return giveUp(error instanceof Error ? error.message : String(error));
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (event.agentId || event.reason !== 'answer' || compacting) return next(event);
    compacting = true;
    let used = 0;
    try {
      const { context } = await $.session.usage();
      used = context.percent ?? 0;
      if (used < configured.compactAtPercent) retryAtPercent = 0;
      if (used < Math.max(configured.compactAtPercent, retryAtPercent)) return next(event);
      const { skip } = await $.session.compact();
      retryAtPercent = skip === undefined ? 0 : used + RETRY_AFTER_SKIP_PERCENT;
    } catch (error) {
      if (isHeadlessRefusal(error)) {
        // SDK sessions (the desktop app's Code tab, `claude -p`) have no
        // $.session.compact yet. /compact, queued for when this turn is over,
        // raises the same session.compact event, so the hook above still runs.
        // Its outcome never comes back here, so wait as after a skip; a compaction
        // that worked brings usage under compactAtPercent, which clears the wait.
        retryAtPercent = used + RETRY_AFTER_SKIP_PERCENT;
        await appendCompactionLog($, `auto-compact at ${Math.round(used)}%: headless session, queued /compact`);
        void $.command.run({ command: 'compact' }).catch((queued: unknown) =>
          debugLog($, `auto-compact skipped (${queued instanceof Error ? queued.message : String(queued)})`),
        );
        return next(event);
      }
      debugLog($, `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
