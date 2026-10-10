import type { Message } from '../types.js';

/**
 * The entries recall searches: the user's prompts, the assistant's replies and
 * each tool call with its result, numbered in order, read from groups of
 * session rows (the archive's groups, then the live rows).
 *
 * Each group starts at the beginning of the conversation as its compaction saw
 * it, so a kept message appears again in a later group. A tool call keeps the
 * first result read for its id (the uncut one). A prompt or reply counts once
 * per position: it is the same entry when the same text follows the same
 * entry, so a kept copy is skipped while the same words said again after other
 * work are not.
 */

export type Entry =
  | { n: number; kind: 'prompt' | 'reply'; text: string }
  | {
      n: number;
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

export function entriesFromGroups(groups: readonly (readonly Message[])[]): Entry[] {
  const entries: Entry[] = [];
  const calls = new Map<string, Call>();
  /** Each prompt or reply seen, keyed by its text and the entry before it, to an id. */
  const texts = new Map<string, string>();
  let previous = '';

  const text = (kind: 'prompt' | 'reply', raw: string): void => {
    const body = withoutReminders(raw).trim();
    if (!body) return;
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

  for (const rows of groups) {
    previous = '';
    for (const row of rows) {
      for (const result of row.toolResults ?? []) {
        const call = calls.get(result.tool_use_id);
        if (!call || call.result !== undefined) continue;
        call.result = withoutReminders(result.text);
        if (result.isError) call.isError = true;
        const saved = SAVED_TO.exec(result.text)?.[1];
        if (saved) call.savedTo = saved.trim();
      }
      if (row.role === 'user') {
        text('prompt', row.text);
        continue;
      }
      text('reply', row.text);
      for (const use of row.toolUses) {
        previous = `c${use.tool_use_id}`;
        if (calls.has(use.tool_use_id)) continue;
        const call: Call = {
          n: entries.length + 1,
          kind: 'call',
          id: use.tool_use_id,
          tool: use.tool,
          input: (use.input as Record<string, unknown>) ?? {},
        };
        calls.set(use.tool_use_id, call);
        entries.push(call);
      }
    }
  }
  return entries;
}
