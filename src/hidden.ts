import { sliceSurrogateSafe } from './state.js';
import type { Message } from './types.js';

/**
 * Hidden content: what Claude Code keeps beside the rows `session.compact`
 * hands over. Each row carries a group of transcript entries the rows do not
 * show (a skill's body after its Skill result, a prompt the user typed while a
 * tool ran, file attachments, images and tool references inside results). A
 * row handed back without its engine handle loses its group, and the hook
 * strips every handle so `--resume` starts at the compaction (#89). The
 * Messages API form shows that content, so it is read from there and folded
 * back as text into the compacted rows.
 *
 * Not folded: the session context ahead of the first prompt (environment,
 * CLAUDE.md, skill and tool lists), which the host sends again after a
 * compaction, and the transient host reminders TRANSIENT names.
 */

export type ApiBlock = { type: string; [field: string]: unknown };

/** One message of the Messages API form. */
export type ApiMessage = { role: 'user' | 'assistant'; content: ApiBlock[] | string };

/** Where hidden content goes back: after a tool result, or after a prompt row. */
export type HiddenAnchor = { toolUseId: string } | { row: Message };

export type HiddenContent = { anchor: HiddenAnchor; text: string };

/**
 * Host reminders that are not folded back, by how their text starts: the host
 * sends a fresh one each step or after a compaction (token countdown, output
 * style, task-tool nudge, deferred tool list, MCP server instructions), or it
 * describes a moment that has passed (editor diagnostics, a file changed on
 * disk, a silence nudge). A user's mid-turn message and a background task's
 * result are kept: nothing else carries them.
 */
const TRANSIENT = [
  /^<total_tokens>(?:\d+|Infinite) tokens left<\/total_tokens>$/,
  /^[\w -]+ output style is active\./,
  /^The task tools haven't been used recently\./,
  /^<new-diagnostics>/,
  /^The user hasn't heard from you in a while\b/,
  /^Note: .+ changed on disk since you last read it\./,
  /^The following deferred tools are now available via ToolSearch\./,
  /^# MCP Server Instructions\b/,
];

const REMINDER = /^<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>$/;

/** The text the host adds after the results of a ToolSearch that loaded tools. */
const TOOL_LOADED = 'Tool loaded.';

const PIECE_SEPARATOR = '\n\n';

function isTransient(text: string): boolean {
  const inner = REMINDER.exec(text.trim())?.[1];
  return inner !== undefined && TRANSIENT.some((pattern) => pattern.test(inner));
}

/** Text blocks of a tool_result's content, joined as the host joins them. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: unknown } => (part as ApiBlock | null)?.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('\n');
}

/** Splits text into its <system-reminder> pieces and whatever lies between them. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (const reminder of text.match(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g) ?? []) {
    const at = rest.indexOf(reminder);
    const before = rest.slice(0, at).trim();
    if (before) out.push(before);
    out.push(reminder);
    rest = rest.slice(at + reminder.length);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/**
 * The end of the run of text blocks starting at `start` that joined make up
 * `text` (a row's text is its text blocks joined, the last perhaps followed by
 * a newline), or undefined.
 */
function ownBlocksAt(blocks: readonly ApiBlock[], start: number, text: string): number | undefined {
  let joined = '';
  for (let n = start; n < blocks.length; n += 1) {
    const block = blocks[n]!;
    if (block.type !== 'text') return undefined;
    joined += String(block['text'] ?? '');
    if (joined === text || joined === `${text}\n`) return n + 1;
    if (!text.startsWith(joined)) return undefined;
  }
  return undefined;
}

/** What a tool result holds beyond its row's text: folded reminders, images, tool references. */
function resultExtras(block: ApiBlock, own: string): string[] {
  const out: string[] = [];
  const content = block['content'];
  const text = contentText(content);
  if (text.startsWith(own)) {
    for (const piece of pieces(text.slice(own.length))) if (!isTransient(piece)) out.push(piece);
  }
  if (Array.isArray(content)) {
    const images = content.filter((part) => (part as ApiBlock | null)?.type === 'image').length;
    const tools = content
      .filter((part) => (part as ApiBlock | null)?.type === 'tool_reference')
      .map((part) => String((part as ApiBlock)['tool_name'] ?? '?'));
    if (tools.length > 0) {
      out.push(
        `[fast-jev-compaction: deferred tools ${tools.join(', ')} were loaded here; load them again with ToolSearch before use]`,
      );
    }
    if (images > 0) {
      out.push(`[fast-jev-compaction: ${images} image${images === 1 ? '' : 's'} omitted from this tool result]`);
    }
  }
  return out;
}

/**
 * The hidden content of `rows`, read from their API form `view`, in transcript
 * order, one entry per anchor. A block is anchored to the latest row before it:
 * the last tool result of its message, or the prompt row whose text precedes it.
 */
export function hiddenContent(rows: readonly Message[], view: readonly ApiMessage[]): HiddenContent[] {
  const resultText = new Map<string, string>();
  for (const row of rows) for (const result of row.toolResults ?? []) resultText.set(result.tool_use_id, result.text);
  // Prompt rows not yet found in the API form, in transcript order. A row is
  // looked for at every block, not in sequence, so one row the API form
  // renders differently does not turn the prompts after it into hidden content.
  const prompts = rows.filter((row) => row.role === 'user' && (row.toolResults ?? []).length === 0 && row.text);
  const promptAt = (blocks: readonly ApiBlock[], index: number): { row: Message; end: number } | undefined => {
    for (let p = 0; p < prompts.length; p += 1) {
      const end = ownBlocksAt(blocks, index, prompts[p]!.text);
      if (end !== undefined) return { row: prompts.splice(p, 1)[0]!, end };
    }
    return undefined;
  };

  // Text an earlier compaction folded in is in the rows already: never again.
  const inRows = rows
    .flatMap((row) => [row.text, ...(row.toolResults ?? []).map((result) => result.text)])
    .join('\n');
  const out: HiddenContent[] = [];
  const add = (anchor: HiddenAnchor | undefined, text: string): void => {
    if (!anchor || !text.trim() || inRows.includes(text)) return;
    const last = out.at(-1);
    if (last && sameAnchor(last.anchor, anchor)) last.text += `${PIECE_SEPARATOR}${text}`;
    else out.push({ anchor, text });
  };

  let anchor: HiddenAnchor | undefined;
  let first = true;
  for (const message of view) {
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    const blocks = message.content;
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue;
      const id = block['tool_use_id'];
      const own = typeof id === 'string' ? resultText.get(id) : undefined;
      if (own === undefined) continue;
      anchor = { toolUseId: id as string };
      for (const extra of resultExtras(block, own)) add(anchor, extra);
    }
    const others = blocks.filter((block) => block.type !== 'tool_result');
    const hasToolReference = blocks.some(
      (block) =>
        block.type === 'tool_result' &&
        Array.isArray(block['content']) &&
        block['content'].some((part) => (part as ApiBlock | null)?.type === 'tool_reference'),
    );
    let index = others.length === blocks.length ? sessionContextEnd(others) : 0;
    while (index < others.length) {
      const prompt = promptAt(others, index);
      if (prompt) {
        anchor = { row: prompt.row };
        index = prompt.end;
        continue;
      }
      const block = others[index]!;
      index += 1;
      // Ahead of the first prompt: the session context the host sends again.
      if (first && !anchor) continue;
      if (block.type === 'image') {
        add(anchor, '[fast-jev-compaction: 1 image omitted here]');
        continue;
      }
      if (block.type !== 'text') continue;
      const text = String(block['text'] ?? '').trim();
      if (isTransient(text) || (hasToolReference && text === TOOL_LOADED)) continue;
      add(anchor, text);
    }
    first = false;
  }
  return out;
}

const SESSION_CONTEXT = /^<system-reminder>\s*# Environment\b/;

/**
 * Where the session context ends in a message of text blocks: the leading
 * run of <system-reminder> blocks when it holds the environment reminder
 * (with CLAUDE.md, skill and tool lists, the date beside it), else 0. The
 * host sends that context ahead of the first prompt and again after each
 * compaction, so it is never folded back.
 */
function sessionContextEnd(blocks: readonly ApiBlock[]): number {
  let end = 0;
  while (end < blocks.length && blocks[end]!.type === 'text' && String(blocks[end]!['text']).startsWith('<system-reminder>')) {
    end += 1;
  }
  return blocks.slice(0, end).some((block) => SESSION_CONTEXT.test(String(block['text']))) ? end : 0;
}

function sameAnchor(a: HiddenAnchor, b: HiddenAnchor): boolean {
  return 'toolUseId' in a ? 'toolUseId' in b && a.toolUseId === b.toolUseId : 'row' in b && a.row === b.row;
}

/** `text` without its transient reminders (and the blank line before each). */
function withoutTransient(text: string): string {
  return text.replace(/(?:\n\n)?<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, (match) =>
    isTransient(match.replace(/^\n\n/, '')) ? '' : match,
  );
}

/**
 * Removes transient reminders from the rows' prompt and tool result texts,
 * where an earlier compaction folded them in. `chars` is how many characters
 * went. Rows that change are copies; the input is not modified.
 */
export function dropTransientReminders<M extends Message>(messages: readonly M[]): { messages: M[]; chars: number } {
  let chars = 0;
  const out = messages.map((message) => {
    const text = withoutTransient(message.text);
    let changed = text !== message.text;
    const toolResults = message.toolResults?.map((result) => {
      const cleaned = withoutTransient(result.text);
      if (cleaned === result.text) return result;
      changed = true;
      chars += result.text.length - cleaned.length;
      return { ...result, text: cleaned };
    });
    if (!changed) return message;
    chars += message.text.length - text.length;
    return { ...message, text, ...(toolResults ? { toolResults } : {}) };
  });
  return { messages: out, chars };
}

/**
 * Appends each piece of hidden content to its anchor in the compacted
 * `messages`: a tool result's text, or a prompt row's text. A prompt row is
 * found by identity, else by its text. Content whose anchor is gone goes to
 * the nearest earlier result that was placed; with none, it is counted lost.
 * Content after a result in `cutIds` keeps its first `headChars` and a note.
 * `chars` is what the fold added. Messages that change are copies; the input
 * is not modified.
 */
export function foldHiddenContent<M extends Message>(
  messages: readonly M[],
  hidden: readonly HiddenContent[],
  options: { cutIds?: ReadonlySet<string>; headChars?: number } = {},
): { messages: M[]; folded: number; lost: number; chars: number } {
  const out = [...messages];
  let chars = 0;
  // Content after a result the compaction cut is cut the same way.
  const pieceOf = (anchor: HiddenAnchor, text: string): string => {
    const head = options.headChars ?? 0;
    if (!('toolUseId' in anchor) || !options.cutIds?.has(anchor.toolUseId) || text.length <= head + 120) return text;
    const kept = sliceSurrogateSafe(text, 0, head);
    return `${kept}\n[fast-jev-compaction cut ${text.length - kept.length} chars of content attached here]`;
  };
  const where = new Map<string, number>();
  out.forEach((message, index) => {
    for (const result of message.toolResults ?? []) where.set(result.tool_use_id, index);
  });
  const usedRows = new Set<number>();
  const findRow = (row: Message): number => {
    let index = messages.findIndex((message, i) => !usedRows.has(i) && message === row);
    if (index < 0) {
      index = out.findIndex(
        (message, i) =>
          !usedRows.has(i) && message.role === 'user' && (message.toolResults ?? []).length === 0 && messages[i]!.text === row.text,
      );
    }
    return index;
  };
  const appendToResult = (index: number, id: string, text: string): void => {
    chars += PIECE_SEPARATOR.length + text.length;
    const message = out[index]!;
    out[index] = {
      ...message,
      toolResults: (message.toolResults ?? []).map((result) =>
        result.tool_use_id === id ? { ...result, text: `${result.text}${PIECE_SEPARATOR}${text}` } : result,
      ),
    };
  };

  let folded = 0;
  let lost = 0;
  let lastResult: { index: number; id: string } | undefined;
  for (const { anchor, text: whole } of hidden) {
    const text = pieceOf(anchor, whole);
    if ('toolUseId' in anchor && where.has(anchor.toolUseId)) {
      lastResult = { index: where.get(anchor.toolUseId)!, id: anchor.toolUseId };
      appendToResult(lastResult.index, lastResult.id, text);
      folded += 1;
      continue;
    }
    if ('row' in anchor) {
      const index = findRow(anchor.row);
      if (index >= 0) {
        usedRows.add(index);
        chars += PIECE_SEPARATOR.length + text.length;
        out[index] = { ...out[index]!, text: `${out[index]!.text}${PIECE_SEPARATOR}${text}` };
        folded += 1;
        continue;
      }
    }
    if (lastResult) {
      appendToResult(lastResult.index, lastResult.id, text);
      folded += 1;
    } else lost += 1;
  }
  return { messages: out, folded, lost, chars };
}
