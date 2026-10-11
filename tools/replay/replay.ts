// Replay harness: simulates the compaction hook on a parsed transcript and measures it.
import {
  collectToolCalls,
  compact,
  resolveOptions,
  estimateTokens,
  type CompactOptions,
  type CompactResult,
  type KeepMode,
  type Message,
} from '../../src/index.js';
import type { AskerFactory } from './askers.js';
import { DEFAULT_WINDOW_TURNS, detectLoss, inputText, type DegradedCall } from './loss.js';
import { segmentsOf, type ParsedTranscript } from './transcript.js';

export type PointsMode = 'threshold' | 'recorded';

export interface ReplayConfig {
  points: PointsMode;
  policy: KeepMode;
  /** `undefined` leaves the option out; the library may not support it (feature-detected by the CLI). */
  trimHostText?: boolean;
  /** Estimated tokens of the working history that trigger a compaction. */
  thresholdTokens: number;
  /** Threshold mode: minimum growth (estimated tokens) since the last floor before the next trigger. */
  minGrowthTokens: number;
  maxPointsPerSegment: number;
  windowTurns: number;
  /** More `compact()` options, such as keep budgets or `decider` (`--options`). */
  options?: CompactOptions;
}

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  points: 'threshold',
  policy: 'rank',
  thresholdTokens: 150_000,
  minGrowthTokens: 25_000,
  maxPointsPerSegment: 12,
  windowTurns: DEFAULT_WINDOW_TURNS,
};

/** Privacy: only ids, sizes, counts and tool names. */
export interface PointResult {
  segment: number;
  /** Index in the transcript of the first message after the point. */
  messageIndex: number;
  tokensBefore: number;
  /** Estimated tokens after compaction: the floor the session restarts from. */
  tokensAfter: number;
  charsBefore: number;
  charsAfter: number;
  reduction: number;
  calls: number;
  kept: number;
  resultsDropped: number;
  callsDropped: number;
  callsStubbed: number;
  pinned: number;
  /** Results newly dropped or stubbed at this point (already-degraded ones are not recounted). */
  degraded: number;
  degradedTokens: number;
  lostAndNeeded: number;
  neededTokenCount: number;
  reruns: number;
  /** Assistant turns actually available to the loss window (<= windowTurns; less near a segment end). */
  windowTurns: number;
  /** Characters cut by host-text trimming (0 when off or unsupported). */
  hostCharsTrimmed: number;
  hostMessagesTrimmed: number;
  /** Trimmed host messages with a lost distinctive token later typed into a tool call. */
  hostLostAndNeeded: number;
  hostNeededTokenCount: number;
  byTool: Record<string, { degraded: number; lostAndNeeded: number; reruns: number }>;
}

export interface SegmentResult {
  segment: number;
  messages: number;
  points: PointResult[];
}

export interface SessionResult {
  session: string;
  messages: number;
  segments: SegmentResult[];
  /** Points an asker could not score (recorded asker with mismatched ids). */
  unscored: number;
  errors: number;
}

type HostTrimmer = (messages: readonly Message[], options: unknown) => { messages: Message[] };

/** `src/host-text.ts` exists only on branches with trimHostText; loaded by a computed path so this typechecks without it. */
async function loadHostTrimmer(): Promise<HostTrimmer | null> {
  try {
    const path = '../../src/host-text.js';
    return ((await import(path)) as { trimHostText: HostTrimmer }).trimHostText;
  } catch {
    return null;
  }
}
const hostTrimmer = await loadHostTrimmer();

const tokenCache = new WeakMap<Message, number>();

export function messageTokens(message: Message): number {
  const cached = tokenCache.get(message);
  if (cached !== undefined) return cached;
  let tokens = estimateTokens(message.text) + 4;
  for (const use of message.toolUses) tokens += estimateTokens(inputText(use.input)) + estimateTokens(use.tool);
  for (const result of message.toolResults ?? []) tokens += estimateTokens(result.text);
  tokenCache.set(message, tokens);
  return tokens;
}

export function historyTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

function compactOptions(config: ReplayConfig): CompactOptions {
  const options: CompactOptions & { trimHostText?: boolean } = { keepMode: config.policy, ...config.options };
  if (config.trimHostText !== undefined) options.trimHostText = config.trimHostText;
  return options;
}

interface PointInput {
  segment: number;
  working: readonly Message[];
  /** Original-transcript index of the first message after the point. */
  from: number;
  /** Exclusive end of the loss window. */
  until: number;
  original: readonly Message[];
}

async function runPoint(
  input: PointInput,
  config: ReplayConfig,
  asker: ReturnType<AskerFactory>,
  alreadyDegraded: Set<string>,
): Promise<{ point: PointResult; result: CompactResult } | null> {
  if (!asker) return null;
  const { working } = input;
  const calls = collectToolCalls(working, 0);
  const result = await compact(working, asker, compactOptions(config));
  const byCallId = new Map(calls.map((call) => [call.id, call]));

  const degraded: DegradedCall[] = [];
  for (const decision of result.decisions) {
    if (decision.action === 'keep') continue;
    const call = byCallId.get(decision.id);
    if (!call || alreadyDegraded.has(call.tool_use_id)) continue;
    const text = working[call.resultIndex]?.toolResults?.find((r) => r.tool_use_id === call.tool_use_id)?.text ?? '';
    degraded.push({ tool_use_id: call.tool_use_id, tool: call.tool, input: call.input, resultText: text });
  }
  const hostItems: DegradedCall[] = [];
  if (config.trimHostText && hostTrimmer) {
    const trimmed = hostTrimmer(working, resolveOptions(compactOptions(config))).messages;
    trimmed.forEach((message, index) => {
      const before = working[index];
      if (before && before.text !== message.text) {
        hostItems.push({ tool_use_id: `host:${index}`, tool: 'host-text', input: {}, resultText: before.text });
      }
    });
  }
  const all = detectLoss({
    original: input.original,
    from: input.from,
    until: input.until,
    compacted: result.messages,
    degraded: [...degraded, ...hostItems],
    turns: config.windowTurns,
  });
  const verdicts = all.slice(0, degraded.length);
  const hostVerdicts = all.slice(degraded.length);
  for (const call of degraded) alreadyDegraded.add(call.tool_use_id);

  const byTool: PointResult['byTool'] = {};
  for (const verdict of verdicts) {
    const entry = (byTool[verdict.tool] ??= { degraded: 0, lostAndNeeded: 0, reruns: 0 });
    entry.degraded++;
    if (verdict.lostAndNeeded) entry.lostAndNeeded++;
    if (verdict.rerun) entry.reruns++;
  }
  const { stats } = result;
  const tokensBefore = historyTokens(working);
  const tokensAfter = historyTokens(result.messages);
  return {
    result,
    point: {
      segment: input.segment,
      messageIndex: input.from,
      tokensBefore,
      tokensAfter,
      charsBefore: stats.charsBefore,
      charsAfter: stats.charsAfter,
      reduction: tokensBefore === 0 ? 0 : (tokensBefore - tokensAfter) / tokensBefore,
      calls: stats.calls,
      kept: stats.kept,
      resultsDropped: stats.resultsDropped,
      callsDropped: stats.callsDropped,
      callsStubbed: stats.callsStubbed,
      pinned: stats.pinned,
      degraded: degraded.length,
      degradedTokens: degraded.reduce((sum, call) => sum + estimateTokens(call.resultText), 0),
      lostAndNeeded: verdicts.filter((v) => v.lostAndNeeded).length,
      neededTokenCount: verdicts.reduce((sum, v) => sum + v.neededTokens, 0),
      reruns: verdicts.filter((v) => v.rerun).length,
      hostCharsTrimmed: (stats as { hostCharsTrimmed?: number }).hostCharsTrimmed ?? 0,
      hostMessagesTrimmed: hostItems.length,
      hostLostAndNeeded: hostVerdicts.filter((v) => v.lostAndNeeded).length,
      hostNeededTokenCount: hostVerdicts.reduce((sum, v) => sum + v.neededTokens, 0),
      windowTurns: Math.min(
        config.windowTurns,
        input.original.slice(input.from, input.until).filter((m) => m.role === 'assistant').length,
      ),
      byTool,
    },
  };
}

/** Replays the compaction points of one transcript segment with one asker factory. */
type SegmentReplay = (
  parsed: ParsedTranscript,
  segment: number,
  range: { start: number; end: number },
  config: ReplayConfig,
  factory: AskerFactory,
  tally: { unscored: number; errors: number },
) => Promise<PointResult[]>;

/**
 * `threshold` points: replays a segment message by message on a working history. Each time its
 * estimate passes `thresholdTokens` (and has grown `minGrowthTokens` since the last floor, with no
 * tool call still waiting for its result), the hook is simulated: the working history becomes the
 * compacted one and the next original messages are appended to it, so the floor growth across
 * successive points is the real recurrence, not a re-compaction of the untouched prefix.
 */
const replayThreshold: SegmentReplay = async (parsed, segment, range, config, factory, tally) => {
  const points: PointResult[] = [];
  const degraded = new Set<string>();
  let working: Message[] = [];
  let open = new Set<string>();
  let estimate = 0;
  let lastFloor = 0;
  for (let i = range.start; i < range.end && points.length < config.maxPointsPerSegment; i++) {
    const message = parsed.messages[i]!;
    working.push(message);
    estimate += messageTokens(message);
    for (const use of message.toolUses) open.add(use.tool_use_id);
    for (const result of message.toolResults ?? []) open.delete(result.tool_use_id);
    if (estimate < config.thresholdTokens || estimate - lastFloor < config.minGrowthTokens || open.size > 0) continue;

    try {
      const outcome = await runPoint(
        { segment, working, from: i + 1, until: range.end, original: parsed.messages },
        config,
        factory({ messages: working }),
        degraded,
      );
      if (!outcome) {
        tally.unscored++;
        break;
      }
      points.push(outcome.point);
      working = [...outcome.result.messages];
      estimate = historyTokens(working);
      lastFloor = estimate;
      open = new Set();
    } catch {
      tally.errors++;
      break;
    }
  }
  return points;
};

/**
 * `recorded` points: the compactions the hook really logged (they coincide with the compact
 * boundary that follows, so their loss window crosses it into the next segment). The prefix is the segment's original
 * messages up to the log entry (no sequential state: earlier in-place compactions are not
 * re-simulated), so floors are comparable across askers but not a growth recurrence.
 */
const replayRecorded: SegmentReplay = async (parsed, segment, range, config, factory, tally) => {
  const points: PointResult[] = [];
  for (const event of parsed.recorded) {
    if (event.messageIndex <= range.start || event.messageIndex > range.end) continue;
    if (points.length >= config.maxPointsPerSegment) break;
    const working = parsed.messages.slice(range.start, event.messageIndex);
    try {
      const outcome = await runPoint(
        { segment, working, from: event.messageIndex, until: parsed.messages.length, original: parsed.messages },
        config,
        factory({ messages: working, event }),
        new Set(),
      );
      if (outcome) points.push(outcome.point);
      else tally.unscored++;
    } catch {
      tally.errors++;
    }
  }
  return points;
};

export async function replaySession(
  session: string,
  parsed: ParsedTranscript,
  config: ReplayConfig,
  factory: AskerFactory,
): Promise<SessionResult> {
  const tally = { unscored: 0, errors: 0 };
  const segments: SegmentResult[] = [];
  segmentsOf(parsed).forEach((range, segment) => {
    segments.push({ segment, messages: range.end - range.start, points: [] });
  });
  const ranges = segmentsOf(parsed);
  for (const [segment, range] of ranges.entries()) {
    const points =
      config.points === 'recorded'
        ? await replayRecorded(parsed, segment, range, config, factory, tally)
        : await replayThreshold(parsed, segment, range, config, factory, tally);
    segments[segment]!.points = points;
  }
  return { session, messages: parsed.messages.length, segments, ...tally };
}
