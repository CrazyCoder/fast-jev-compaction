/**
 * The entries recall searches: the user's prompts, the assistant's replies and
 * each tool call with its result, numbered in order, read from a session
 * transcript (`<config>/projects/<project>/<session>.jsonl`).
 *
 * A compaction keeps the transcript and appends a `compact_boundary` row, then
 * writes the messages it kept again, so the history after a boundary starts
 * with copies. The copies carry the compaction's time, no later than the
 * boundary's; their prompts and replies are skipped, and a tool call keeps the
 * first result read for its id (the uncut one). A transcript without
 * timestamps falls back on position: the same text after the same entry within
 * a stretch between boundaries is the same entry. Claude Code can also append
 * rows again under their own uuid; a uuid is read once.
 */

export type Entry =
  | { n: number; kind: 'prompt' | 'reply'; text: string; where?: string }
  | {
      n: number;
      kind: 'call';
      /** The transcript that holds it when not the session's own: a subagent, or another session. */
      where?: string;
      /** For an Agent call: the subagent it started. */
      agentId?: string;
      id: string;
      tool: string;
      input: Record<string, unknown>;
      /** The result as the model read it; absent while the call is unanswered. */
      result?: string;
      isError?: boolean;
      /** Where Claude Code saved an output too large for the transcript. */
      savedTo?: string;
    };

type Call = Extract<Entry, { kind: 'call' }>;
type Block = { type?: string; [field: string]: unknown };
type Row = {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
};

const SAVED_TO = /Full output saved to: (.+?)\r?\n/;
const REMINDER = /\s*<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g;

/** Text without its `<system-reminder>` blocks, which the host adds and re-sends. */
function withoutReminders(text: string): string {
  return text.replace(REMINDER, '');
}

/** The text of a message or tool result content: a string, or text blocks joined. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .map((block) => (block.type === 'text' ? String(block['text'] ?? '') : block.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Reads transcript lines one at a time; `entries` grows as they come. A
 * subagent's transcript holds only sidechain rows, so `sidechain` takes them;
 * the session's own transcript skips them. A search fed only the lines that
 * match can see a result without its call: `orphanResults` keeps those as a
 * call of tool `result`.
 */
export function transcriptReader({ sidechain = false, orphanResults = false } = {}): {
  line: (raw: string) => void;
  entries: Entry[];
} {
  const entries: Entry[] = [];
  const calls = new Map<string, Call>();
  /** Each prompt or reply seen, keyed by its text and the entry before it, to an id. */
  const texts = new Map<string, string>();
  let previous = '';
  /** The last boundary's time: rows stamped no later are its copies. */
  let boundaryAt = Number.NEGATIVE_INFINITY;
  let copy = false;
  let timed = false;
  const uuids = new Set<string>();

  const text = (kind: 'prompt' | 'reply', raw: string): void => {
    const body = withoutReminders(raw).trim();
    if (!body || copy) return;
    if (timed) {
      entries.push({ n: entries.length + 1, kind, text: body });
      return;
    }
    const key = `${kind}\u0000${body}\u0000${previous}`;
    const seen = texts.get(key);
    if (seen !== undefined) {
      previous = seen;
      return;
    }
    previous = `t${texts.size}`;
    texts.set(key, previous);
    entries.push({ n: entries.length + 1, kind, text: body });
  };

  const result = (id: string, raw: string, isError: boolean): void => {
    if (orphanResults && !calls.has(id)) toolUse(id, 'result', {});
    const call = calls.get(id);
    if (!call || call.result !== undefined) return;
    call.result = withoutReminders(raw);
    if (isError) call.isError = true;
    const saved = SAVED_TO.exec(raw)?.[1];
    if (saved) call.savedTo = saved.trim();
  };

  const toolUse = (id: string, tool: string, input: Record<string, unknown>): void => {
    previous = `c${id}`;
    if (calls.has(id)) return;
    const call: Call = { n: entries.length + 1, kind: 'call', id, tool, input };
    calls.set(id, call);
    entries.push(call);
  };

  const line = (raw: string): void => {
    let row: Row;
    try {
      row = JSON.parse(raw) as Row;
    } catch {
      return;
    }
    if (row.uuid) {
      if (uuids.has(row.uuid)) return;
      uuids.add(row.uuid);
    }
    const at = row.timestamp ? Date.parse(row.timestamp) : Number.NaN;
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      previous = '';
      if (!Number.isNaN(at)) boundaryAt = at;
      return;
    }
    if ((row.type !== 'user' && row.type !== 'assistant') || row.isMeta || row.isCompactSummary) return;
    if (row.isSidechain && !sidechain) return;
    timed = !Number.isNaN(at);
    copy = at <= boundaryAt;
    const content = row.message?.content;
    const blocks: Block[] = Array.isArray(content) ? (content as Block[]) : [];
    if (row.type === 'user') {
      for (const block of blocks.filter((b) => b.type === 'tool_result')) {
        result(String(block['tool_use_id']), textOf(block['content']), block['is_error'] === true);
      }
      text('prompt', typeof content === 'string' ? content : textOf(blocks.filter((b) => b.type === 'text')));
      return;
    }
    text('reply', textOf(blocks.filter((b) => b.type === 'text')));
    for (const block of blocks.filter((b) => b.type === 'tool_use')) {
      toolUse(String(block['id']), String(block['name']), (block['input'] as Record<string, unknown>) ?? {});
    }
  };

  return { line, entries };
}

/** Entries from a whole transcript's text. */
export function readTranscript(jsonl: string, options: { sidechain?: boolean } = {}): Entry[] {
  const reader = transcriptReader(options);
  for (const raw of jsonl.split('\n')) reader.line(raw);
  return reader.entries;
}
