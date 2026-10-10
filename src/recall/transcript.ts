import type { Message } from '../types.js';

/**
 * The entries recall searches: the user's prompts, the assistant's replies and
 * each tool call with its result, numbered in order. They are read from a
 * session transcript (`<session>.jsonl`, readTranscript) or from groups of
 * session rows (entriesFromGroups).
 *
 * A compaction keeps messages by writing them again after its boundary, cut or
 * not. So a tool call keeps the first result read for its id (the uncut one),
 * and a prompt or reply copied after a boundary is not counted twice.
 */

export type Entry =
  | { n: number; line?: number; kind: 'prompt' | 'reply'; text: string }
  | {
      n: number;
      line?: number;
      kind: 'call';
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

const SAVED_TO = /Full output saved to: (.+?)\r?\n/;
const REMINDER = /\s*<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g;

/** Text without its `<system-reminder>` blocks, which the host adds and re-sends. */
function withoutReminders(text: string): string {
  return text.replace(REMINDER, '');
}

/** Builds the entry list; `boundary()` marks where a compaction wrote kept messages again. */
function collector() {
  const entries: Entry[] = [];
  const calls = new Map<string, Call>();
  const beforeBoundary = new Set<string>();
  const sinceBoundary = new Set<string>();
  let afterBoundary = false;

  return {
    entries,
    boundary(): void {
      for (const key of sinceBoundary) beforeBoundary.add(key);
      sinceBoundary.clear();
      afterBoundary = true;
    },
    text(kind: 'prompt' | 'reply', raw: string, line?: number): void {
      const text = withoutReminders(raw).trim();
      if (!text) return;
      const key = `${kind}\u0000${text}`;
      if (afterBoundary && beforeBoundary.has(key)) return;
      sinceBoundary.add(key);
      entries.push({ n: entries.length + 1, ...(line !== undefined && { line }), kind, text });
    },
    call(id: string, tool: string, input: Record<string, unknown>, line?: number): void {
      if (calls.has(id)) return;
      const call: Call = { n: entries.length + 1, ...(line !== undefined && { line }), kind: 'call', id, tool, input };
      calls.set(id, call);
      entries.push(call);
    },
    result(id: string, text: string, isError: boolean): void {
      const call = calls.get(id);
      if (!call || call.result !== undefined) return;
      call.result = withoutReminders(text);
      if (isError) call.isError = true;
      const saved = SAVED_TO.exec(text)?.[1];
      if (saved) call.savedTo = saved.trim();
    },
  };
}

type Block = { type?: string; [field: string]: unknown };
type Row = {
  type?: string;
  subtype?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
};

/** The text of a message or tool result content: a string, or text blocks joined. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .map((block) => (block.type === 'text' ? String(block['text'] ?? '') : block.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/** Entries from a transcript file's text. */
export function readTranscript(jsonl: string): Entry[] {
  const c = collector();
  jsonl.split('\n').forEach((raw, index) => {
    const line = index + 1;
    let row: Row;
    try {
      row = JSON.parse(raw) as Row;
    } catch {
      return;
    }
    if (row.type === 'system' && row.subtype === 'compact_boundary') return c.boundary();
    if ((row.type !== 'user' && row.type !== 'assistant') || row.isMeta || row.isSidechain || row.isCompactSummary) return;
    const content = row.message?.content;
    const blocks: Block[] = Array.isArray(content) ? (content as Block[]) : [];
    if (row.type === 'user') {
      for (const block of blocks.filter((b) => b.type === 'tool_result')) {
        c.result(String(block['tool_use_id']), textOf(block['content']), block['is_error'] === true);
      }
      c.text('prompt', typeof content === 'string' ? content : textOf(blocks.filter((b) => b.type === 'text')), line);
      return;
    }
    c.text('reply', textOf(blocks.filter((b) => b.type === 'text')), line);
    for (const block of blocks.filter((b) => b.type === 'tool_use')) {
      c.call(String(block['id']), String(block['name']), (block['input'] as Record<string, unknown>) ?? {}, line);
    }
  });
  return c.entries;
}

/** Entries from groups of session rows, each group read after a compaction boundary. */
export function entriesFromGroups(groups: readonly (readonly Message[])[]): Entry[] {
  const c = collector();
  groups.forEach((rows, index) => {
    if (index > 0) c.boundary();
    for (const row of rows) {
      for (const result of row.toolResults ?? []) c.result(result.tool_use_id, result.text, result.isError === true);
      if (row.role === 'user') {
        c.text('prompt', row.text);
        continue;
      }
      c.text('reply', row.text);
      for (const use of row.toolUses) c.call(use.tool_use_id, use.tool, (use.input as Record<string, unknown>) ?? {});
    }
  });
  return c.entries;
}
