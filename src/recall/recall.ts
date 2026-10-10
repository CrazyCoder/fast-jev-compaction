/**
 * The recall tool's engine: search, expand and list a session's entries
 * (src/recall/transcript.ts), within a fixed answer size.
 *
 * Adapted from pi-vcc (MIT, Copyright (c) 2026 sting8k): the BM25-lite ranking,
 * the stopwords and the regex mode. The answer budget and its per-entry share
 * follow pi-blackhole (MIT, Copyright (c) 2026 k0valik).
 */
import type { Entry } from './transcript.ts';

/** The most one recall answer holds, in characters. */
export const RECALL_MAX_CHARS = 48_000;

/** The recall tool as the model calls it; its calls are not listed. */
export const RECALL_TOOL = 'mcp__fast-jev-compaction__recall';

export type RecallRequest = {
  /** Keywords, ranked by BM25; or a regex when it holds regex characters. */
  query?: string;
  /** Entries in full: `#N`, `N` or a tool_use_id. */
  expand?: readonly (string | number)[];
  /** Entries `from`..`to`, one short line each. */
  range?: readonly [number, number];
  /** 1-based page of query or range results. */
  page?: number;
  /** For expand: where in a long text to start, from a previous answer's footer. */
  offset?: number;
  /** true: the files changed, by which calls; a path part: every call on the files it matches. */
  touched?: boolean | string;
  /** Subagent transcripts: "list", "all" (with the session's own), or a part of an agent's id or name. */
  agent?: string;
};

export type RecallDeps = {
  /** Reads a file Claude Code saved a large output to; undefined when it cannot. */
  readFile?: (path: string) => string | undefined;
};

const QUERY_PAGE = 5;
const RANGE_PAGE = 20;
const SNIPPET_LINE_CHARS = 200;
const PREVIEW_CHARS = 200;
const INPUT_CHARS = 2_000;
/** The most entries one expand answer shows; the rest are named for another call. */
const EXPAND_MAX = 10;
/** Room kept for the "not shown" and "not found" notes. */
const NOTES_CHARS = 3_000;
/** Room for a cut note: "[cut at N of M chars; continue: expand: [\"<id>\"], offset: N]". */
const CUT_NOTE_CHARS = 200;
const QUERY_ECHO_CHARS = 100;
const SEARCH_BUDGET_MS = 3_000;

const USAGE = [
  'Give one of:',
  '- query: keywords (ranked) or a regex, e.g. "redis timeout"; 5 hits per page.',
  '- expand: ["#N" or a tool_use_id, ...]: those entries in full.',
  '- range: [from, to]: entries #from..#to in order, one line each, 20 per page.',
  'Add page: N for the next page of a query or range.',
].join('\n');

// ── regex safety (pi-vcc) ──

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function quantifierAt(pattern: string, i: number): { len: number; unbounded: boolean } {
  const c = pattern[i];
  if (c === '+' || c === '*') return { len: 1, unbounded: true };
  if (c === '{') {
    const end = pattern.indexOf('}', i);
    const body = end === -1 ? '' : pattern.slice(i + 1, end);
    if (/^\d+(,\d*)?$/.test(body)) return { len: end - i + 1, unbounded: body.endsWith(',') };
  }
  return { len: 0, unbounded: false };
}

/**
 * Whether the pattern can backtrack without end. A running `RegExp.test` cannot
 * be stopped, so anything that might is matched as literal text: a quantified
 * group (`(a|a)*`, `(.*a){12}`, `(a+)+`), a back reference, or more than two
 * unbounded quantifiers (`a*a*a*b`). What is left (literals, classes, a `.*` or
 * two, groups without a quantifier) runs in polynomial time.
 */
function isRisky(pattern: string): boolean {
  let inClass = false;
  let unbounded = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') {
      if (/[1-9k]/.test(pattern[i + 1] ?? '')) return true;
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    const q = quantifierAt(pattern, i);
    if (q.unbounded && ++unbounded > 2) return true;
    if (c === ')' && (quantifierAt(pattern, i + 1).len > 0 || pattern[i + 1] === '?')) return true;
  }
  return false;
}

/** The pattern as a case-insensitive regex, or as literal text when it is risky or invalid. */
function safeRegex(pattern: string, flags = 'i'): RegExp {
  if (!isRisky(pattern)) {
    try {
      return new RegExp(pattern, flags);
    } catch {
      // Invalid: matched as literal text below.
    }
  }
  return new RegExp(escapeRegex(pattern), flags);
}

// ── ranking (pi-vcc BM25-lite) ──

const STOPWORDS = new Set(
  ('the a an is are was were be been being have has had do does did will would could should may might can shall ' +
    'of in to for with on at from by as into through during before after above below between out off over under ' +
    'again further then once here there when where why how all both each few more most other some such no nor not ' +
    'only own same so than too very just about it its that this what which who whom these those').split(' '),
);
const BM25_K = 1.2;
const BM25_B = 0.75;

/** The searchable text of an entry. */
function docOf(entry: Entry): string {
  return entry.kind === 'call' ? `${entry.tool} ${JSON.stringify(entry.input)}\n${entry.result ?? ''}` : entry.text;
}

function deadline(): () => void {
  const end = Date.now() + SEARCH_BUDGET_MS;
  return () => {
    if (Date.now() > end) throw new Error(`search took over ${SEARCH_BUDGET_MS} ms: use fewer or more specific words`);
  };
}

/**
 * The entries matching `query`, best first, with the regex that finds each
 * hit's snippet. A query with regex characters is tried as a regex first; when
 * that finds nothing, its words are ranked instead (`fix?`, `$HOME`).
 */
function search(entries: readonly Entry[], query: string): { hits: Entry[]; marker: RegExp } {
  const check = deadline();
  const docs = entries.map(docOf);
  if (/[|*+?{}()[\]\\^$]/.test(query)) {
    const re = safeRegex(query);
    const hits: Entry[] = [];
    docs.forEach((doc, i) => {
      check();
      if (re.test(doc)) hits.push(entries[i]!);
    });
    if (hits.length > 0) return { hits: hits.reverse(), marker: re };
    query = query.replace(/[|*+?{}()[\]\\^$]/g, ' ');
  }
  const words = query.split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !STOPWORDS.has(w.toLowerCase()) && w.length > 1);
  const terms = (meaningful.length > 0 ? meaningful : words).map((w) => new RegExp(escapeRegex(w), 'gi'));
  const lengths = docs.map((doc) => doc.split(/\s+/).length);
  const avg = lengths.reduce((a, b) => a + b, 0) / Math.max(docs.length, 1);
  const df = terms.map((term) => docs.filter((doc) => doc.search(term) !== -1).length);
  const scored = docs
    .map((doc, i) => {
      check();
      let score = 0;
      terms.forEach((term, t) => {
        const tf = doc.match(term)?.length ?? 0;
        if (tf === 0) return;
        const idf = Math.log((docs.length - df[t]! + 0.5) / (df[t]! + 0.5) + 1);
        score += (idf * (tf * (BM25_K + 1))) / (tf + BM25_K * (1 - BM25_B + (BM25_B * lengths[i]!) / avg));
      });
      return { entry: entries[i]!, score };
    })
    .filter((s) => s.score > 0)
    // Best first; on a tie the later entry, as it is closer to the current work.
    .sort((a, b) => b.score - a.score || b.entry.n - a.entry.n);
  return { hits: scored.map((s) => s.entry), marker: new RegExp(terms.map((t) => t.source).join('|'), 'i') };
}

// ── rendering ──

const clip = (text: string, chars: number): string => (text.length <= chars ? text : `${text.slice(0, chars)}…`);
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

function heading(entry: Entry): string {
  const where = entry.agent ? ` [${entry.agent}]` : '';
  if (entry.kind !== 'call') return `#${entry.n}${where} ${entry.kind}`;
  const started = entry.agentId ? ` [started agent ${entry.agentId}]` : '';
  return `#${entry.n}${where} call ${entry.tool} (${entry.id})${started}`;
}

/** The input field that says most about a call, for one-line listings. */
function gist(entry: Extract<Entry, { kind: 'call' }>): string {
  for (const key of ['command', 'file_path', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const value = entry.input[key];
    if (typeof value === 'string' && value) return value;
  }
  return JSON.stringify(entry.input);
}

/** A long line cut to the part around its first match. */
function around(line: string, marker: RegExp): string {
  if (line.length <= SNIPPET_LINE_CHARS) return line;
  const at = Math.max(0, line.search(marker));
  const start = Math.max(0, Math.min(at - SNIPPET_LINE_CHARS / 4, line.length - SNIPPET_LINE_CHARS));
  return `${start > 0 ? '…' : ''}${line.slice(start, start + SNIPPET_LINE_CHARS)}${start + SNIPPET_LINE_CHARS < line.length ? '…' : ''}`;
}

/** Up to two lines either side of the first line `marker` matches. */
function snippet(text: string, marker: RegExp): string {
  const lines = text.split('\n');
  const at = Math.max(0, lines.findIndex((line) => marker.test(line)));
  return lines
    .slice(Math.max(0, at - 2), at + 3)
    .map((line) => `  ${around(line, marker)}`)
    .join('\n');
}

function pager(total: number, size: number, page: number): { from: number; pages: number; page: number } {
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page)), pages);
  return { from: (current - 1) * size, pages, page: current };
}

function runQuery(entries: readonly Entry[], query: string, page: number): string {
  const { hits, marker } = search(entries, query);
  const echo = clip(query, QUERY_ECHO_CHARS);
  if (hits.length === 0) return `No match for "${echo}".`;
  const p = pager(hits.length, QUERY_PAGE, page);
  const blocks = hits
    .slice(p.from, p.from + QUERY_PAGE)
    .map((entry) => `${heading(entry)}\n${snippet(docOf(entry), marker)}`);
  const next = p.page < p.pages ? ` Next: page: ${p.page + 1}.` : '';
  return [
    `${hits.length} match(es) for "${echo}", page ${p.page}/${p.pages}:`,
    ...blocks,
    `Full text: expand: ["#N"] or a tool_use_id.${next}`,
  ].join('\n\n');
}

function runRange(entries: readonly Entry[], [from, to]: readonly [number, number], page: number): string {
  const picked = entries.filter((e) => e.n >= Math.min(from, to) && e.n <= Math.max(from, to));
  if (picked.length === 0) return `No entries in #${from}..#${to} (the session has ${entries.length}).`;
  const p = pager(picked.length, RANGE_PAGE, page);
  const lines = picked
    .slice(p.from, p.from + RANGE_PAGE)
    .map((entry) => `${heading(entry)}${entry.kind === 'call' ? ':' : ''} ${clip(oneLine(entry.kind === 'call' ? gist(entry) : entry.text), PREVIEW_CHARS)}`);
  const next = p.page < p.pages ? `\nNext: page: ${p.page + 1}.` : '';
  return `Entries #${from}..#${to}, page ${p.page}/${p.pages}:\n${lines.join('\n')}${next}`;
}

const CHANGING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TOUCHED_PAGE = 50;

type Call = Extract<Entry, { kind: 'call' }>;

/** The file a call works on, from its input. */
function fileOf(call: Call): string | undefined {
  for (const field of ['file_path', 'notebook_path', 'path']) {
    const value = call.input[field];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function callRef(call: Call): string {
  return `${call.id}${call.isError ? ', failed' : ''}`;
}

function paged(lines: readonly string[], page: number, head: string, tail: string): string {
  const p = pager(lines.length, TOUCHED_PAGE, page);
  const next = p.page < p.pages ? `\nNext: page: ${p.page + 1}.` : '';
  const pages = p.pages > 1 ? `, page ${p.page}/${p.pages}` : '';
  return `${head} (${lines.length}${pages}):\n${lines.slice(p.from, p.from + TOUCHED_PAGE).join('\n')}\n${tail}${next}`;
}

/** The files changed, newest change first, or every call on the files `part` matches. */
function runTouched(entries: readonly Entry[], touched: true | string, page: number): string {
  const calls = entries.filter((e): e is Call => e.kind === 'call' && fileOf(e) !== undefined);
  if (typeof touched === 'string') {
    const part = touched.toLowerCase();
    const lines = calls
      .filter((c) => fileOf(c)!.toLowerCase().includes(part))
      .map((c) => `#${c.n} ${c.tool} ${fileOf(c)} (${callRef(c)})`);
    if (lines.length === 0) return `No calls on files matching "${clip(touched, QUERY_ECHO_CHARS)}".`;
    return paged(lines, page, `Calls on files matching "${clip(touched, QUERY_ECHO_CHARS)}"`, 'Expand a call by its id for its input and result.');
  }
  const byFile = new Map<string, Call[]>();
  for (const call of calls.filter((c) => CHANGING_TOOLS.has(c.tool))) {
    const file = fileOf(call)!;
    byFile.set(file, [...(byFile.get(file) ?? []), call]);
  }
  if (byFile.size === 0) return 'No files changed in this session.';
  const lines = [...byFile]
    .sort(([, a], [, b]) => b.at(-1)!.n - a.at(-1)!.n)
    .map(([file, changes]) => {
      const shown = changes.slice(-5).map((c) => `${c.tool} #${c.n} ${c.id}${c.isError ? ' (failed)' : ''}`);
      const more = changes.length > 5 ? `${changes.length - 5} earlier, ` : '';
      return `${file}: ${more}${shown.join(', ')}`;
    });
  return paged(lines, page, 'Files changed in this session', 'For every call on a file, reads included: touched: "<part of the path>".');
}

/**
 * What each of `count` expanded entries may take of the budget: an even share
 * of it after room for the notes on refs not found or not shown (pi-blackhole
 * splits its budget the same way). With at most EXPAND_MAX entries, a share is
 * never under 4,000 characters.
 */
function share(count: number): number {
  return Math.floor((RECALL_MAX_CHARS - NOTES_CHARS) / count);
}

/**
 * `text` from `offset`, cut at a line end within `room` (never below zero);
 * the cut note, at most CUT_NOTE_CHARS, says where to go on.
 */
function window(text: string, offset: number, available: number, ref: string): string {
  const room = Math.max(0, available);
  const rest = text.slice(offset);
  if (rest.length <= room) return rest;
  const newline = rest.lastIndexOf('\n', room - 1);
  const end = newline > 0 ? newline + 1 : room;
  const next = offset + end;
  return `${rest.slice(0, end)}[cut at ${next} of ${text.length} chars; continue: expand: ["${ref}"], offset: ${next}]`;
}

/** The entries `refs` name (`#N`, `N` or a tool_use_id), once each, and the refs that name none. */
export function resolveRefs(
  entries: readonly Entry[],
  refs: readonly (string | number)[],
): { found: Entry[]; missing: string[] } {
  const found: Entry[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const text = String(ref).trim();
    const number = /^#?(\d+)$/.exec(text)?.[1];
    const entry = number
      ? entries.find((e) => e.n === Number(number))
      : entries.find((e) => e.kind === 'call' && e.id === text);
    if (entry && !found.includes(entry)) found.push(entry);
    else if (!entry) missing.push(text);
  }
  return { found, missing };
}

/** Refs for a note, the list and each ref bounded. */
function refList(refs: readonly string[]): string {
  const shown = refs.slice(0, 20).map((ref) => clip(ref, 60));
  return `${shown.join(', ')}${refs.length > shown.length ? `, and ${refs.length - shown.length} more` : ''}`;
}

function runExpand(entries: readonly Entry[], refs: readonly (string | number)[], offset: number, deps: RecallDeps): string {
  const { found, missing } = resolveRefs(entries, refs);
  const shown = found.slice(0, EXPAND_MAX);
  const room = shown.length > 0 ? share(shown.length) : 0;
  const blocks = shown.map((entry) => {
    const head = `${heading(entry)}\n`;
    if (entry.kind !== 'call') return head + window(entry.text, offset, room - head.length - CUT_NOTE_CHARS, `#${entry.n}`);
    const saved = entry.savedTo ? deps.readFile?.(entry.savedTo) : undefined;
    const result = saved ?? entry.result ?? '(no result)';
    const inputChars = Math.min(INPUT_CHARS, Math.floor(room / 3));
    const input = offset === 0 ? `input:\n${clip(JSON.stringify(entry.input, null, 2), inputChars)}\n` : '';
    const from = saved ? `, from ${clip(entry.savedTo!, 160)}` : entry.savedTo ? ' (a preview; the saved full output could not be read)' : '';
    const label = `result${entry.isError ? ' (error)' : ''}${from}:\n`;
    const left = room - head.length - input.length - label.length - CUT_NOTE_CHARS;
    return `${head}${input}${label}${window(result, offset, left, entry.id)}`;
  });
  const rest = found.slice(EXPAND_MAX).map((e) => (e.kind === 'call' ? e.id : `#${e.n}`));
  if (rest.length > 0) blocks.push(`Not shown, ${EXPAND_MAX} per answer: ${refList(rest)}. Expand them in another call.`);
  if (missing.length > 0) blocks.push(`Not found: ${refList(missing)}.`);
  return blocks.join('\n\n');
}

/**
 * Answers one recall request over a session's entries. Recall's own calls are
 * left out: a query would always find itself.
 */
export function runRecall(all: readonly Entry[], request: RecallRequest, deps: RecallDeps = {}): string {
  const entries = all.filter((e) => !(e.kind === 'call' && e.tool === RECALL_TOOL));
  const page = request.page ?? 1;
  try {
    if (request.expand && request.expand.length > 0) {
      return runExpand(entries, request.expand, Math.max(0, Math.floor(request.offset ?? 0)), deps);
    }
    if (request.range) return runRange(entries, request.range, page);
    if (request.touched === true || (typeof request.touched === 'string' && request.touched.trim())) {
      return runTouched(entries, request.touched === true ? true : request.touched.trim(), page);
    }
    if (request.query?.trim()) return runQuery(entries, request.query.trim(), page);
  } catch (error) {
    return `Recall failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return USAGE;
}
