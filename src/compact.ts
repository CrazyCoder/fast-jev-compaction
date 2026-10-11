import { marker, PLUGIN_ID } from './brand.js';
import { trimHostText } from './host-text.js';
import { condenseOldProse, DEFAULT_RECENT_TURNS, type ProseSummarizer } from './prose.js';
import { RECALL_TOOL } from './recall/recall.js';
import { isRetryable, noulAnswer, stopsAll } from './request.js';
import {
  collectToolCalls,
  estimateTokens,
  fitState,
  goalFromMessages,
  isPinned,
  MAX_INSTRUCTION_CHARS,
  sliceSurrogateSafe,
  truncate,
} from './state.js';
import type {
  CallAction,
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  instructions: '',
  keepMode: 'rank',
  keepThreshold: 0.5,
  keepResultTokens: 12_000,
  keepCallTokens: 4_000,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  maxConcurrentRequests: 4,
  truncateHeadChars: 300,
  recallNotes: false,
  dropCalls: false,
  trimHostText: true,
  hostTextHeadChars: 200,
  taskResultHeadChars: 4000,
  oldProse: 'keep',
  recentTurns: DEFAULT_RECENT_TURNS,
  ageCutResults: false,
  questionCriteria: false,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

/** The note a compaction with recall notes opens the history with; the next compaction replaces it. */
const NOTE_MARKER = `[${PLUGIN_ID} note]`;
const NOTE_ACK = 'Understood: earlier content is cut, not lost; I will use recall to read it back.';

type Turn = { role?: string; text: string; toolUses?: readonly unknown[] };

/** `messages` without the compaction note and acknowledgement a compaction opened them with. */
export function withoutCompactionNote<T extends Turn>(messages: readonly T[]): readonly T[] {
  const [note, ack] = messages;
  const opens =
    note?.role === 'user' &&
    !note.toolUses?.length &&
    note.text.startsWith(NOTE_MARKER) &&
    ack?.role === 'assistant' &&
    ack.text === NOTE_ACK &&
    !ack.toolUses?.length;
  return opens ? messages.slice(2) : messages;
}

/**
 * What a compaction cut, for the model, and how recall reads it back; undefined
 * when it cut nothing.
 */
function compactionNote(
  stats: Pick<CompactResult['stats'], 'resultsDropped' | 'callsStubbed' | 'callsDropped' | 'oldProseReplaced'>,
): string | undefined {
  const parts = [
    stats.resultsDropped > 0 && `${stats.resultsDropped} tool results cut to their first characters`,
    stats.callsStubbed > 0 && `${stats.callsStubbed} older tool calls reduced to stubs`,
    stats.callsDropped > 0 && `${stats.callsDropped} tool calls dropped`,
    stats.oldProseReplaced > 0 && `${stats.oldProseReplaced} older messages condensed into a digest`,
  ].filter((part): part is string => typeof part === 'string');
  if (parts.length === 0) return undefined;
  return [
    `${NOTE_MARKER} This conversation was compacted to fit the context: ${parts.join(', ')}.`,
    'Nothing was deleted from the session transcript. A cut note names its tool_use_id: recall expand ["<id>"] returns that call and result in full, and recall query searches everything earlier.',
    'Use recall before running a tool again to see an old result, and before saying something from earlier is gone.',
  ].join(' ');
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    instructions: options.instructions?.trim() ?? DEFAULT_OPTIONS.instructions,
    keepMode: options.keepMode === 'threshold' ? 'threshold' : DEFAULT_OPTIONS.keepMode,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    keepResultTokens: Math.max(
      0,
      finite(options.keepResultTokens, DEFAULT_OPTIONS.keepResultTokens),
    ),
    keepCallTokens: Math.max(0, finite(options.keepCallTokens, DEFAULT_OPTIONS.keepCallTokens)),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    maxConcurrentRequests: Math.max(
      1,
      Math.floor(finite(options.maxConcurrentRequests, DEFAULT_OPTIONS.maxConcurrentRequests)),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    dropCalls: typeof options.dropCalls === 'boolean' ? options.dropCalls : DEFAULT_OPTIONS.dropCalls,
    trimHostText:
      typeof options.trimHostText === 'boolean' ? options.trimHostText : DEFAULT_OPTIONS.trimHostText,
    recallNotes: options.recallNotes === true,
    hostTextHeadChars: Math.max(
      0,
      Math.floor(finite(options.hostTextHeadChars, DEFAULT_OPTIONS.hostTextHeadChars)),
    ),
    taskResultHeadChars: Math.max(
      0,
      Math.floor(finite(options.taskResultHeadChars, DEFAULT_OPTIONS.taskResultHeadChars)),
    ),
    oldProse:
      options.oldProse === 'digest' || options.oldProse === 'summarize'
        ? options.oldProse
        : DEFAULT_OPTIONS.oldProse,
    recentTurns: Math.max(
      1,
      Math.floor(finite(options.recentTurns, DEFAULT_OPTIONS.recentTurns)),
    ),
    ageCutResults: options.ageCutResults === true,
    questionCriteria: options.questionCriteria === true,
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall, criteria = false): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
      ...(criteria ? { criteria: CALL_CRITERIA } : {}),
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
      ...(criteria ? { criteria: RESULT_CRITERIA } : {}),
    },
  };
}

/**
 * The two sides of each question, from tamaratran/fast-jev-compaction#55:
 * Jev's docs ask for `true`/`false` criteria whenever the boundary is subtle.
 */
const CALL_CRITERIA = {
  true: 'The call records a change to the world, or a constraint the assistant must not violate again: an edit or write that changed a file, a command that installed, moved or deleted something, a check whose outcome the user was told about',
  false: 'The call only gathered information that has since been superseded or acted upon: a search used to locate a file that was then edited, a read of a file that has since changed, a failing check that has since been fixed',
};
const RESULT_CRITERIA = {
  true: 'The exact contents are still in use and could not be recovered by re-running the tool: an error the assistant is still diagnosing, output the user asked about, the current state of a file being edited',
  false: 'The contents are stale, already stated in the assistant text, or trivially re-obtainable: a directory listing already used, a passing test run, a file read before it was rewritten',
};

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'> & { questionCriteria?: boolean },
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call, options.questionCriteria)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'> & Partial<Pick<ResolvedCompactOptions, 'dropCalls'>>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  if (options.dropCalls === false) {
    return { ...base, action: 'stub_call', reason: 'call_stubbed' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

/** Estimated tokens a call costs to keep verbatim, or to keep as input plus truncated head. */
export interface CallSize {
  resultTokens: number;
  truncatedTokens: number;
}

function sizeOf(messages: readonly Message[], call: ToolCall, headChars: number): CallSize {
  const message = messages[call.resultIndex];
  const text =
    message?.toolResults?.find((result) => result.tool_use_id === call.tool_use_id)?.text ?? '';
  let input = '';
  try {
    input = JSON.stringify(call.input);
  } catch {
    input = '[unserializable input]';
  }
  return {
    resultTokens: estimateTokens(text),
    truncatedTokens:
      estimateTokens(input) +
      estimateTokens(truncatedResultText(text, call.isError, headChars)),
  };
}

/**
 * Rank-mode decisions, in `calls` order. Jev's scores are compressed, so the
 * absolute threshold keeps nothing; the best-scored results are kept within
 * `keepResultTokens`, then the best-scored inputs within `keepCallTokens`.
 * A call too big for what is left is skipped, not a stop. Ties go to the more
 * recent call.
 */
export function rankDecisions(
  calls: readonly ToolCall[],
  answers: ReadonlyMap<string, CallAnswer>,
  sizes: ReadonlyMap<string, CallSize>,
  options: Pick<ResolvedCompactOptions, 'keepResultTokens' | 'keepCallTokens'> &
    Partial<Pick<ResolvedCompactOptions, 'dropCalls'>>,
): CallDecision[] {
  const answerOf = (call: ToolCall): CallAnswer =>
    answers.get(call.id) ?? { keepCall: 1, keepResult: 1 };
  const order = new Map(calls.map((call, index) => [call.id, index]));
  const ranked = (score: (call: ToolCall) => number, pool: readonly ToolCall[]): ToolCall[] =>
    [...pool].sort(
      (a, b) => score(b) - score(a) || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0),
    );
  const actions = new Map<string, CallAction>();
  const spend = (
    pool: readonly ToolCall[],
    budget: number,
    cost: (call: ToolCall) => number,
    action: CallAction,
  ): void => {
    let used = 0;
    for (const call of pool) {
      const tokens = cost(call);
      if (budget <= 0 || used + tokens > budget) continue;
      used += tokens;
      actions.set(call.id, action);
    }
  };
  const candidates = calls.filter((call) => !call.pinned);
  const sizeOfCall = (call: ToolCall): CallSize =>
    sizes.get(call.id) ?? { resultTokens: 0, truncatedTokens: 0 };
  spend(
    ranked((call) => answerOf(call).keepResult, candidates),
    options.keepResultTokens,
    (call) => sizeOfCall(call).resultTokens,
    'keep',
  );
  spend(
    ranked(
      (call) => answerOf(call).keepCall,
      candidates.filter((call) => !actions.has(call.id)),
    ),
    options.keepCallTokens,
    (call) => sizeOfCall(call).truncatedTokens,
    'drop_result',
  );
  return calls.map((call) => {
    const base = { id: call.id, tool: call.tool, ...answerOf(call) };
    if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
    const action = actions.get(call.id);
    if (action === 'keep') return { ...base, action, reason: 'kept' };
    if (action === 'drop_result') return { ...base, action, reason: 'result_dropped' };
    if (options.dropCalls === false) return { ...base, action: 'stub_call', reason: 'call_stubbed' };
    return { ...base, action: 'drop_call', reason: 'call_dropped' };
  });
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
  criteria = false,
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map((call) => questionsFor(call, criteria)));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

/** Wait before the one retry of a rate-limited or failed request. */
export const RETRY_DELAY_MS = 1000;

/** The `signal` passed to `compact` aborted: whoever asked for the compaction moved on. */
export class CompactionInterrupted extends Error {
  constructor() {
    super('compaction interrupted');
    this.name = 'CompactionInterrupted';
  }
}

/**
 * Asks every batch with at most `limit` requests in flight. A 429 or 5xx is
 * retried once; after a failure every request would share (401, 403, no
 * answer) no further request is started. Resolves the answers that came back
 * and the failures; a failed batch's calls get no answer, so they are kept.
 */
async function askAll(
  asker: JevAsker,
  jobs: readonly { state: CompactionState; batch: readonly ToolCall[]; criteria?: boolean }[],
  limit: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<{ answers: Map<string, CallAnswer>; failures: unknown[] }> {
  const answers = new Map<string, CallAnswer>();
  const failures: unknown[] = [];
  let stop: unknown;
  let next = 0;
  const ask = async (job: (typeof jobs)[number]) => {
    try {
      return await askBatch(asker, job.state, job.batch, job.criteria);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      await sleep(RETRY_DELAY_MS);
      if (signal?.aborted) throw new CompactionInterrupted();
      if (stop !== undefined) throw stop;
      return askBatch(asker, job.state, job.batch, job.criteria);
    }
  };
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next]!;
      next += 1;
      // Whoever asked has moved on: start nothing more.
      if (signal?.aborted) stop ??= new CompactionInterrupted();
      if (stop !== undefined) {
        failures.push(stop);
        continue;
      }
      try {
        for (const [id, answer] of await ask(job)) answers.set(id, answer);
      } catch (error) {
        if (stopsAll(error)) stop ??= error;
        failures.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return { answers, failures };
}

/** A cut result: the head it kept, then its note (`[jetcompact truncated N chars …]`). */
const CUT_RESULT = new RegExp(`^([\\s\\S]*?)\\n?\\[${PLUGIN_ID} truncated (\\d+) chars of this tool result([^\\n]*)\\]$`);

/**
 * `ageCutResults`: every result that came in already cut by an earlier
 * compaction, and is not pinned, loses its head; the note, with the count
 * raised by the head's length, is all that stays.
 */
function ageCutResults(
  before: readonly Message[],
  after: Message[],
  calls: readonly ToolCall[],
): { messages: Message[]; count: number } {
  const pinned = new Set(calls.filter((call) => call.pinned).map((call) => call.tool_use_id));
  const cutBefore = new Set<string>();
  for (const message of before) {
    for (const result of message.toolResults ?? []) {
      if (!pinned.has(result.tool_use_id) && CUT_RESULT.test(result.text)) cutBefore.add(result.tool_use_id);
    }
  }
  if (cutBefore.size === 0) return { messages: after, count: 0 };
  const aged = new Set<string>();
  const age = (id: string, text: string): string => {
    if (!cutBefore.has(id)) return text;
    const match = CUT_RESULT.exec(text);
    if (!match || match[1] === '') return text;
    aged.add(id);
    return `[${PLUGIN_ID} truncated ${Number(match[2]) + match[1]!.length} chars of this tool result${match[3]}]`;
  };
  const messages = after.map((message) => {
    const toolUses = message.toolUses.map((tool) => {
      const text = age(tool.tool_use_id, tool.text ?? '');
      return text === (tool.text ?? '') ? tool : { ...tool, text };
    });
    const toolResults = message.toolResults?.map((result) => {
      const text = age(result.tool_use_id, result.text);
      return text === result.text ? result : { ...result, text };
    });
    const changed =
      toolUses.some((tool, i) => tool !== message.toolUses[i]) ||
      (toolResults ?? []).some((result, i) => result !== message.toolResults?.[i]);
    return changed ? { ...message, toolUses, ...(toolResults ? { toolResults } : {}) } : message;
  });
  return { messages, count: aged.size };
}

/** How a cut note says to get the rest: the recall tool by id, or running the tool again. */
function restOf(id: string, recall: boolean, fallback: string): string {
  return recall ? `; full text: recall expand ["${id}"]` : fallback;
}

function truncatedResultText(text: string, isError: boolean, headChars: number, id = '', recall = false): string {
  if (text.length <= headChars + 120) return text;
  // End the head on a code point boundary: cutting a surrogate pair in half
  // would leave a lone surrogate in the rebuilt transcript.
  const cut = sliceSurrogateSafe(text, 0, headChars).length;
  const head = cut > 0 ? `${text.slice(0, cut)}\n` : '';
  return `${head}[${PLUGIN_ID} truncated ${text.length - cut} chars of this tool result${
    isError ? ' (error)' : ''
  }${restOf(id, recall, '; re-run the tool if needed')}]`;
}

function truncatedInput(input: Record<string, unknown>, headChars: number, id: string, recall: boolean): Record<string, unknown> {
  const json = JSON.stringify(input);
  if (json.length <= headChars + 120) return input;
  return {
    input_head: sliceSurrogateSafe(json, 0, headChars),
    note: marker(`truncated ${json.length - headChars} chars of this tool input${restOf(id, recall, '')}`),
  };
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note;
 * a stubbed call keeps its tool name with input and result both cut to a head.
 * With `recallNotes`, each cut note names the recall call that gets the rest.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
  recallNotes = false,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  // Recall cannot expand its own calls, so their cut notes stay plain.
  const pointsToRecall = (id: string) => recallNotes && !calls.some((c) => c.tool_use_id === id && c.tool === RECALL_TOOL);
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: (Message | null)[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(
        message.role === 'assistant' &&
          message.text.trim().length === 0 &&
          message.toolUses.length === 0 &&
          (message.toolResults?.length ?? 0) === 0
          ? null
          : message,
      );
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        const action = actions.get(tool.tool_use_id);
        if (action !== 'drop_result' && action !== 'stub_call') return tool;
        const recall = pointsToRecall(tool.tool_use_id);
        const text = truncatedResultText(tool.text ?? '', tool.isError ?? false, headChars, tool.tool_use_id, recall);
        const input = action === 'stub_call' ? truncatedInput(tool.input, headChars, tool.tool_use_id, recall) : tool.input;
        if ((tool.text ?? '') === text && input === tool.input) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        const action = actions.get(result.tool_use_id);
        if (action !== 'drop_result' && action !== 'stub_call') return result;
        const text = truncatedResultText(
          result.text,
          result.isError ?? false,
          headChars,
          result.tool_use_id,
          pointsToRecall(result.tool_use_id),
        );
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept.filter((message): message is Message => message !== null);
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

type StateGroup = { state: ReturnType<typeof fitState>; calls: ToolCall[] };

function tooLarge(error: unknown): boolean {
  return String((error as Error)?.message).startsWith('history too large for Jev');
}

/**
 * One state for all candidates when the history fits `maxStateTokens`. When it
 * does not (long sessions), the candidates are split into contiguous windows,
 * halved until each window's state fits: a window's state keeps the goal, the
 * first message, the pinned newest messages and its own messages in full, and
 * leaves the rest of the history out. Relevance of an old call depends mostly
 * on the goal and the recent turns, which every window carries. A call whose
 * window cannot fit even alone is returned in `unasked`; it gets no answer and
 * therefore stays, like any call Jev was not asked about.
 */
export function stateGroups(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  candidates: readonly ToolCall[],
  options: ResolvedCompactOptions,
): { groups: StateGroup[]; unasked: ToolCall[]; stage: string } {
  try {
    const state = fitState(messages, calls, options);
    return { groups: [{ state, calls: [...candidates] }], unasked: [], stage: state.stage };
  } catch (error) {
    if (!tooLarge(error)) throw error;
  }
  const windowOptions = { ...options, goal: options.goal || goalFromMessages(messages) };
  const groups: StateGroup[] = [];
  const unasked: ToolCall[] = [];
  const fit = (group: ToolCall[]): void => {
    const lo = Math.min(...group.map((call) => call.callIndex));
    const hi = Math.max(...group.map((call) => call.resultIndex));
    const inWindow = new Set(group.map((call) => call.id));
    const view = messages.map((message, i) =>
      (i >= lo && i <= hi) || isPinned(i, messages.length, options.preserveRecentMessages)
        ? message
        : { ...message, text: '' },
    );
    try {
      const state = fitState(view, calls.filter((call) => call.pinned || inWindow.has(call.id)), windowOptions);
      groups.push({ state, calls: group });
    } catch (error) {
      if (!tooLarge(error)) throw error;
      if (group.length === 1) {
        unasked.push(group[0]!);
        return;
      }
      const half = Math.ceil(group.length / 2);
      fit(group.slice(0, half));
      fit(group.slice(half));
    }
  };
  const half = Math.ceil(candidates.length / 2);
  fit(candidates.slice(0, half));
  if (candidates.length > half) fit(candidates.slice(half));
  const stage = `windows:${groups.length}${unasked.length > 0 ? ` unasked:${unasked.length}` : ''}`;
  return { groups, unasked, stage };
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions; when it cannot be fitted, the
 * calls are asked in windows (see `stateGroups`). Throws when Jev fails; the
 * caller decides whether to fall back.
 */
export async function compact(
  original: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
  deps: { summarize?: ProseSummarizer; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  // An earlier compaction's note goes; this one writes its own.
  const history = withoutCompactionNote(original);
  const prose = await condenseOldProse(history, resolved, deps.summarize);
  const host = resolved.trimHostText
    ? trimHostText(prose.messages, resolved)
    : { messages: prose.messages, trimmed: 0, charsCut: 0 };
  const messages = host.messages;
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = original.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let requests = 0;
  let requestsFailed = 0;
  let requestError: string | undefined;
  let answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    const goal = resolved.instructions
      ? `${resolved.goal || goalFromMessages(messages)}\nThe user asked this compaction to keep: ${truncate(
          resolved.instructions,
          MAX_INSTRUCTION_CHARS,
        )}`
      : resolved.goal;
    const { groups, stage } = stateGroups(messages, calls, candidates, { ...resolved, goal });
    fitted = { tokens: Math.max(0, ...groups.map((group) => group.state.tokens)), stage };
    const jobs = groups.flatMap((group) =>
      batchCalls(group.calls, group.state.tokens, resolved).map((batch) => ({ state: group.state.state, batch, criteria: resolved.questionCriteria })),
    );
    requests = jobs.length;
    // Without a host clock the one retry goes out at once.
    const sleep = deps.sleep ?? (async () => {});
    if (deps.signal?.aborted) throw new CompactionInterrupted();
    const asked = await askAll(asker, jobs, resolved.maxConcurrentRequests, sleep, deps.signal);
    if (deps.signal?.aborted) throw new CompactionInterrupted();
    // Nothing answered: let the caller fall back with the reason.
    if (jobs.length > 0 && asked.failures.length === jobs.length) throw asked.failures[0];
    answers = asked.answers;
    requestsFailed = asked.failures.length;
    const failure = asked.failures[0];
    if (failure !== undefined) requestError = failure instanceof Error ? failure.message : String(failure);
  }

  const decisions =
    resolved.keepMode === 'rank'
      ? rankDecisions(
          calls,
          answers,
          new Map(
            candidates.map((call) => [
              call.id,
              sizeOf(messages, call, resolved.truncateHeadChars),
            ]),
          ),
          resolved,
        )
      : calls.map((call) =>
          decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
        );
  const applied = applyDecisions(
    messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
    resolved.recallNotes,
  );
  const aged = resolved.ageCutResults ? ageCutResults(messages, applied, calls) : { messages: applied, count: 0 };
  const kept = aged.messages;
  const cut = {
    resultsDropped: count(decisions, 'result_dropped'),
    callsDropped: count(decisions, 'call_dropped'),
    callsStubbed: count(decisions, 'call_stubbed'),
    oldProseReplaced: prose.replaced,
  };
  const note = resolved.recallNotes ? compactionNote(cut) : undefined;
  if (note) {
    kept.unshift(
      { role: 'user', text: note, toolUses: [] },
      { role: 'assistant', text: NOTE_ACK, toolUses: [] },
    );
  }
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: original.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: cut.resultsDropped,
      callsDropped: cut.callsDropped,
      callsStubbed: cut.callsStubbed,
      resultsAged: aged.count,
      pinned: count(decisions, 'pinned'),
      hostTextTrimmed: host.trimmed,
      hostCharsTrimmed: host.charsCut,
      oldProse: prose.applied,
      oldProseReplaced: prose.replaced,
      oldProseCharsBefore: prose.charsBefore,
      oldProseCharsAfter: prose.charsAfter,
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests,
      requestsFailed,
      ...(requestError === undefined ? {} : { requestError }),
      ms: Date.now() - started,
    },
  };
}
