/**
 * Reads a Claude Code session transcript (`<session>.jsonl`) into the entries
 * recall searches: the user's prompts, the assistant's replies and each tool
 * call with its result, numbered in order.
 *
 * A compaction deletes nothing from the file: it appends a `compact_boundary`
 * and writes the messages it kept again after it. So a tool call keeps the
 * first result the file holds for its id (the uncut one), and a prompt or reply
 * written again after a boundary is not counted twice.
 */

export type Entry =
  | { n: number; line: number; kind: 'prompt' | 'reply'; text: string }
  | {
      n: number;
      line: number;
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

type Block = { type?: string; [field: string]: unknown };
type Row = {
  type?: string;
  subtype?: string;
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

export function readTranscript(jsonl: string): Entry[] {
  const entries: Entry[] = [];
  const calls = new Map<string, Extract<Entry, { kind: 'call' }>>();
  /** Prompts and replies seen before the latest compact boundary. */
  const beforeBoundary = new Set<string>();
  const sinceBoundary = new Set<string>();
  let afterBoundary = false;

  const addText = (kind: 'prompt' | 'reply', text: string, line: number): void => {
    if (!text) return;
    const key = `${kind}\u0000${text}`;
    if (afterBoundary && beforeBoundary.has(key)) return;
    sinceBoundary.add(key);
    entries.push({ n: entries.length + 1, line, kind, text });
  };

  jsonl.split('\n').forEach((raw, index) => {
    const line = index + 1;
    let row: Row;
    try {
      row = JSON.parse(raw) as Row;
    } catch {
      return;
    }
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      for (const key of sinceBoundary) beforeBoundary.add(key);
      sinceBoundary.clear();
      afterBoundary = true;
      return;
    }
    if ((row.type !== 'user' && row.type !== 'assistant') || row.isMeta || row.isSidechain || row.isCompactSummary) return;
    const content = row.message?.content;
    const blocks: Block[] = Array.isArray(content) ? (content as Block[]) : [];

    if (row.type === 'user') {
      for (const block of blocks.filter((b) => b.type === 'tool_result')) {
        const call = calls.get(String(block['tool_use_id']));
        if (!call || call.result !== undefined) continue;
        const text = textOf(block['content']);
        call.result = withoutReminders(text);
        if (block['is_error'] === true) call.isError = true;
        const saved = SAVED_TO.exec(text)?.[1];
        if (saved) call.savedTo = saved.trim();
      }
      const typed = typeof content === 'string' ? content : textOf(blocks.filter((b) => b.type === 'text'));
      addText('prompt', withoutReminders(typed).trim(), line);
      return;
    }

    addText('reply', textOf(blocks.filter((b) => b.type === 'text')).trim(), line);
    for (const block of blocks.filter((b) => b.type === 'tool_use')) {
      const id = String(block['id']);
      if (calls.has(id)) continue;
      const call: Extract<Entry, { kind: 'call' }> = {
        n: entries.length + 1,
        line,
        kind: 'call',
        id,
        tool: String(block['name']),
        input: (block['input'] as Record<string, unknown>) ?? {},
      };
      calls.set(id, call);
      entries.push(call);
    }
  });
  return entries;
}
