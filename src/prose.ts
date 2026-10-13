import { marker, PLUGIN_ID } from './brand.js';
import { isHostText, stripHostText } from './host-text.js';
import { sliceSurrogateSafe, truncate } from './state.js';
import type { Message, OldProseMode } from './types.js';

export const DEFAULT_RECENT_TURNS = 4;

/** Characters kept of the session's first prompt, the task statement. */
const FIRST_PROMPT_CHARS = 2000;
/** Characters kept of any later user prompt. */
const PROMPT_CHARS = 400;
/** Characters kept of the assistant's final reply of a turn. */
const REPLY_CHARS = 500;
/** Ceiling of a digest; the oldest entries after the first prompt are dropped past it. */
export const DIGEST_MAX_CHARS = 12_000;
/** Distinct paths, URLs and ids listed in a digest footer. */
const MAX_REFERENCES = 60;
const MAX_REFERENCE_CHARS = 160;
/** Prior digest/summary text carried into a summary request, and a summary's size. */
export const SUMMARY_MAX_TOKENS = 3000;
/** Characters of old transcript sent to the summarizer. */
const SUMMARY_INPUT_CHARS = 120_000;

const MARKER = new RegExp(`^\\[${PLUGIN_ID} (digest|summary) of (\\d+) earlier turns[^\\]]*\\]\\n?`);
const ACK_PREFIX = 'Understood. Continuing from the earlier-turns ';
const REFERENCED = 'Referenced: ';

export interface CondensedMarker {
  kind: 'digest' | 'summary';
  turns: number;
  body: string;
}

/** A message a previous pass wrote in place of old prose. */
export function parseCondensed(message: Message): CondensedMarker | undefined {
  if (message.role !== 'user' || (message.toolResults ?? []).length > 0) return undefined;
  const match = MARKER.exec(message.text);
  if (!match) return undefined;
  return {
    kind: match[1] as 'digest' | 'summary',
    turns: Number(match[2]),
    body: message.text.slice(match[0].length),
  };
}

function isAck(message: Message): boolean {
  return (
    message.role === 'assistant' && message.toolUses.length === 0 && message.text.startsWith(ACK_PREFIX)
  );
}

/** A user message that starts a turn: the person's prose, not a tool result, host notice or earlier digest. */
export function isUserTurn(message: Message): boolean {
  return (
    message.role === 'user' &&
    (message.toolResults ?? []).length === 0 &&
    parseCondensed(message) === undefined &&
    message.text.trim().length > 0 &&
    !isHostText(message.text)
  );
}

export interface ProseSplit {
  /** Everything before the cut; replaced by a digest or summary. */
  old: Message[];
  /** From the first message of the `recentTurns`-th last user turn on; kept as today. */
  recent: Message[];
}

function toolUseIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) for (const use of message.toolUses) ids.add(use.tool_use_id);
  return ids;
}

/**
 * Splits at the start of the `recentTurns`-th last user turn. The cut always
 * falls on a user turn, so a tool_use and its tool_result (which follows in
 * the same turn) end on the same side; should a result still reference a call
 * on the other side, the cut moves back one turn. Undefined when the history
 * has no more than `recentTurns` turns.
 */
export function splitOldProse(
  messages: readonly Message[],
  recentTurns: number,
): ProseSplit | undefined {
  const keep = Math.max(1, Math.floor(recentTurns));
  const starts: number[] = [];
  messages.forEach((message, index) => {
    if (isUserTurn(message)) starts.push(index);
  });
  for (let k = starts.length - keep; k >= 1; k--) {
    const cut = starts[k]!;
    const old = messages.slice(0, cut);
    const recent = messages.slice(cut);
    const oldUses = toolUseIds(old);
    const crossing = recent.some((message) =>
      (message.toolResults ?? []).some((result) => oldUses.has(result.tool_use_id)),
    );
    if (!crossing) return { old, recent };
  }
  return undefined;
}

interface Turn {
  prompt: string;
  reply: string;
  tools: Map<string, number>;
  /** The paths the turn's Read calls opened, in order, without repeats. */
  reads: string[];
  text: string;
}

function groupTurns(old: readonly Message[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  for (const message of old) {
    if (parseCondensed(message) || isAck(message)) continue;
    if (isUserTurn(message)) {
      current = { prompt: stripHostText(message.text).trim(), reply: '', tools: new Map(), reads: [], text: '' };
      turns.push(current);
    } else if (!current) {
      current = { prompt: '', reply: '', tools: new Map(), reads: [], text: '' };
      turns.push(current);
    }
    if (message.role === 'assistant') {
      if (message.text.trim()) current.reply = message.text.trim();
      for (const use of message.toolUses) {
        current.tools.set(use.tool, (current.tools.get(use.tool) ?? 0) + 1);
        const path = use.tool === 'Read' ? use.input['file_path'] : undefined;
        if (typeof path === 'string' && path && !current.reads.includes(path)) current.reads.push(path);
        current.text += `\n${JSON.stringify(use.input).slice(0, 2000)}`;
      }
    }
    current.text += `\n${message.text}`;
  }
  return turns.filter((turn) => turn.prompt || turn.reply || turn.tools.size > 0);
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const REFERENCE_PATTERNS: readonly RegExp[] = [
  /https?:\/\/[^\s)"'<>\]]+/g,
  /(?:~|\.{0,2})\/?(?:[\w@.-]+\/)+[\w@.-]*\w\.\w{1,8}\b/g,
  /\b[A-Z][A-Z0-9]{0,9}-\d{1,6}\b/g,
  /(?<![\w&])#\d{2,6}\b/g,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g,
];

/** Paths, URLs, ticket ids, PR numbers and commit shas, most frequent first. */
export function collectReferences(text: string, limit = MAX_REFERENCES): string[] {
  const counts = new Map<string, number>();
  for (const pattern of REFERENCE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].replace(/[.,;:]+$/, '');
      if (value.length > MAX_REFERENCE_CHARS) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value]) => value);
}

function entryOf(turn: Turn, first: boolean): string {
  const lines = [
    `• ${first ? 'first prompt' : 'user'}: ${truncate(oneLine(turn.prompt), first ? FIRST_PROMPT_CHARS : PROMPT_CHARS) || '(none)'}`,
  ];
  if (turn.reply) lines.push(`  assistant: ${truncate(oneLine(turn.reply), REPLY_CHARS)}`);
  if (turn.tools.size > 0) {
    lines.push(
      `  tools: ${[...turn.tools].map(([tool, n]) => (n > 1 ? `${tool}×${n}` : tool)).join(', ')}`,
    );
  }
  return lines.join('\n');
}

interface PriorDigest {
  entries: string[];
  omitted: number;
  references: string[];
  turns: number;
}

const OMITTED = /^\((\d+) older turns omitted\)$/;

/** Reads the entries, omission note and footer back out of a digest this module wrote. */
function parseDigestBody(body: string): Omit<PriorDigest, 'turns'> {
  const entries: string[] = [];
  let omitted = 0;
  let references: string[] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('• ')) entries.push(line);
    else if (line.startsWith('  ') && entries.length > 0) entries[entries.length - 1] += `\n${line}`;
    else if (line.startsWith(REFERENCED)) references = line.slice(REFERENCED.length).split(', ').filter(Boolean);
    else {
      const note = OMITTED.exec(line.trim());
      if (note) omitted += Number(note[1]);
    }
  }
  return { entries, omitted, references };
}

function priorOf(old: readonly Message[]): PriorDigest {
  const prior: PriorDigest = { entries: [], omitted: 0, references: [], turns: 0 };
  for (const message of old) {
    const marker = parseCondensed(message);
    if (!marker) continue;
    prior.turns += marker.turns;
    if (marker.kind === 'digest') {
      const parsed = parseDigestBody(marker.body);
      prior.entries.push(...parsed.entries);
      prior.omitted += parsed.omitted;
      prior.references.push(...parsed.references);
    } else {
      prior.entries.push(`• earlier summary: ${truncate(oneLine(marker.body), 4000)}`);
    }
  }
  return prior;
}

/** Ends a digest or summary header when the host offers the recall tool. */
const RECALL_HINT = '; the recall tool reads them back from the transcript (query, expand)';

export interface DigestOptions {
  maxChars?: number;
  /** Say in the header that the recall tool reads the dropped turns back. */
  recall?: boolean;
}

/**
 * A deterministic extractive digest of the old prefix: the first prompt, then
 * per turn the user's prompt (head) and the assistant's final reply (head),
 * tool names with counts, and a footer of the paths and ids mentioned. Tool
 * results and intermediate narration are dropped. A digest or summary left by
 * an earlier pass is folded in as the oldest entries and the footer is merged,
 * so repeated compactions stay under `maxChars` instead of chaining.
 */
export function buildDigest(old: readonly Message[], options: DigestOptions = {}): string {
  const maxChars = options.maxChars ?? DIGEST_MAX_CHARS;
  const prior = priorOf(old);
  const turns = groupTurns(old);
  const entries = [...prior.entries];
  turns.forEach((turn, index) => entries.push(entryOf(turn, prior.entries.length === 0 && index === 0)));
  const totalTurns = prior.turns + turns.length;
  const references = collectReferences(turns.map((turn) => turn.text).join('\n'));
  const merged = [...new Set([...references, ...prior.references])].slice(0, MAX_REFERENCES);
  const footer = merged.length > 0 ? `${REFERENCED}${merged.join(', ')}` : '';
  const header = marker(
    `digest of ${totalTurns} earlier turns; tool calls, results and intermediate narration were dropped${options.recall ? RECALL_HINT : ''}`,
  );

  const [first = '', ...rest] = entries;
  let omitted = prior.omitted;
  const budget = maxChars - header.length - footer.length - first.length - 80;
  let used = 0;
  const kept: string[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const entry = rest[i]!;
    if (used + entry.length + 1 > budget) {
      omitted += i + 1;
      break;
    }
    used += entry.length + 1;
    kept.unshift(entry);
  }
  return [
    header,
    first,
    omitted > 0 ? `(${omitted} older turns omitted)` : '',
    ...kept,
    footer,
  ]
    .filter(Boolean)
    .join('\n');
}

export const SUMMARY_SYSTEM =
  'You condense the older part of a coding-agent conversation so work can continue from it. ' +
  'Keep: the user\'s goals and standing instructions, decisions and why, constraints, ' +
  'file paths, identifiers, commands and their outcomes, open problems and next steps. ' +
  'Drop narration and anything reproducible from the repository. Plain text, no preamble.';

/** The prompt for a summary of the old prefix; an earlier digest or summary is passed as the previous one to merge. */
export function buildSummaryPrompt(old: readonly Message[]): string {
  const sections: string[] = [];
  for (const message of old) {
    const marker = parseCondensed(message);
    if (marker) sections.push(`## Previous ${marker.kind} (merge, do not repeat verbatim)\n${marker.body}`);
  }
  const lines: string[] = [];
  for (const turn of groupTurns(old)) {
    if (turn.prompt) lines.push(`USER: ${truncate(turn.prompt, 1500)}`);
    if (turn.tools.size > 0) {
      lines.push(`TOOLS: ${[...turn.tools].map(([tool, n]) => `${tool}×${n}`).join(', ')}`);
    }
    if (turn.reads.length > 0) lines.push(`READ: ${truncate(turn.reads.join(', '), 1500)}`);
    if (turn.reply) lines.push(`ASSISTANT: ${truncate(turn.reply, 1500)}`);
  }
  let transcript = lines.join('\n');
  if (transcript.length > SUMMARY_INPUT_CHARS) {
    transcript = `[… older lines omitted …]\n${sliceSurrogateSafe(transcript, transcript.length - SUMMARY_INPUT_CHARS, transcript.length)}`;
  }
  sections.push(`## Conversation to condense\n${transcript}`);
  sections.push(
    `Write one summary of at most ${Math.round(SUMMARY_MAX_TOKENS * 0.75)} words covering the previous summary (if any) and the conversation above.`,
  );
  return sections.join('\n\n');
}

export type ProseSummarizer = (request: {
  system: string;
  prompt: string;
  maxTokens: number;
}) => Promise<string>;

export interface OldProseOptions {
  oldProse: OldProseMode;
  recentTurns: number;
  /** The digest or summary header points at the recall tool. */
  recallNotes?: boolean;
}

export interface OldProseResult {
  messages: Message[];
  /** Which mechanism produced the replacement; `keep` when nothing was replaced. */
  applied: OldProseMode;
  /** Messages replaced, and the characters before and after. */
  replaced: number;
  charsBefore: number;
  charsAfter: number;
}

const chars = (messages: readonly Message[]): number =>
  messages.reduce((sum, m) => sum + m.text.length + JSON.stringify([m.toolUses, m.toolResults ?? []]).length, 0);

/**
 * Replaces the old prefix (see `splitOldProse`) with one user message holding
 * a digest or a summary, and a short assistant acknowledgement so roles keep
 * alternating. The recent suffix is returned as the input objects. Nothing
 * changes when the mode is `keep`, the history is short, or the replacement
 * would not be smaller. `summarize` falls back to the digest when no
 * summarizer is given or it fails.
 */
export async function condenseOldProse(
  messages: readonly Message[],
  options: OldProseOptions,
  summarize?: ProseSummarizer,
): Promise<OldProseResult> {
  const unchanged: OldProseResult = {
    messages: [...messages],
    applied: 'keep',
    replaced: 0,
    charsBefore: 0,
    charsAfter: 0,
  };
  if (options.oldProse === 'keep') return unchanged;
  const split = splitOldProse(messages, options.recentTurns);
  if (!split) return unchanged;

  let applied: OldProseMode = 'digest';
  let text = '';
  if (options.oldProse === 'summarize' && summarize) {
    try {
      const reply = (
        await summarize({
          system: SUMMARY_SYSTEM,
          prompt: buildSummaryPrompt(split.old),
          maxTokens: SUMMARY_MAX_TOKENS,
        })
      ).trim();
      if (reply) {
        const turns = priorOf(split.old).turns + groupTurns(split.old).length;
        text = `${marker(`summary of ${turns} earlier turns${options.recallNotes === true ? RECALL_HINT : ''}`)}\n${reply}`;
        applied = 'summarize';
      }
    } catch {
      text = '';
    }
  }
  if (!text) text = buildDigest(split.old, { recall: options.recallNotes === true });

  const kind = applied === 'summarize' ? 'summary' : 'digest';
  const condensed: Message[] = [
    { role: 'user', text, toolUses: [] },
    { role: 'assistant', text: `${ACK_PREFIX}${kind} above.`, toolUses: [] },
  ];
  const charsBefore = chars(split.old);
  const charsAfter = chars(condensed);
  if (charsAfter >= charsBefore) return unchanged;
  return {
    messages: [...condensed, ...split.recent],
    applied,
    replaced: split.old.length,
    charsBefore,
    charsAfter,
  };
}
