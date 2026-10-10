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
 * Not folded: the token countdowns (the host sends a fresh one every step) and
 * the session context ahead of the first prompt (environment, CLAUDE.md, skill
 * and tool lists), which the host sends again after a compaction.
 */

export type ApiBlock = { type: string; [field: string]: unknown };

/** One message of the Messages API form. */
export type ApiMessage = { role: 'user' | 'assistant'; content: ApiBlock[] | string };

/** Where hidden content goes back: after a tool result, or after a prompt row. */
export type HiddenAnchor = { toolUseId: string } | { row: Message };

export type HiddenContent = { anchor: HiddenAnchor; text: string };

const TOKEN_COUNT =
  /^<system-reminder>\s*<total_tokens>(?:\d+|Infinite) tokens left<\/total_tokens>\s*<\/system-reminder>$/;

/** The text the host adds after the results of a ToolSearch that loaded tools. */
const TOOL_LOADED = 'Tool loaded.';

const PIECE_SEPARATOR = '\n\n';

function isCountdown(text: string): boolean {
  return TOKEN_COUNT.test(text.trim());
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

/** The range of text blocks, from `from` on, that joined make up `text`, or undefined. */
function ownBlocks(blocks: readonly ApiBlock[], from: number, text: string): [number, number] | undefined {
  if (!text) return undefined;
  for (let start = from; start < blocks.length; start += 1) {
    let joined = '';
    for (let n = start; n < blocks.length; n += 1) {
      const block = blocks[n]!;
      if (block.type !== 'text') break;
      joined += String(block['text'] ?? '');
      if (joined === text || joined === `${text}\n`) return [start, n + 1];
      if (!text.startsWith(joined)) break;
    }
  }
  return undefined;
}

/** What a tool result holds beyond its row's text: folded reminders, images, tool references. */
function resultExtras(block: ApiBlock, own: string): string[] {
  const out: string[] = [];
  const content = block['content'];
  const text = contentText(content);
  if (text.startsWith(own)) {
    for (const piece of pieces(text.slice(own.length))) if (!isCountdown(piece)) out.push(piece);
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
  const prompts = rows.filter((row) => row.role === 'user' && (row.toolResults ?? []).length === 0 && row.text);

  const out: HiddenContent[] = [];
  const add = (anchor: HiddenAnchor | undefined, text: string): void => {
    if (!anchor || !text.trim()) return;
    const last = out.at(-1);
    if (last && sameAnchor(last.anchor, anchor)) last.text += `${PIECE_SEPARATOR}${text}`;
    else out.push({ anchor, text });
  };

  let anchor: HiddenAnchor | undefined;
  let nextPrompt = 0;
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
    let index = 0;
    while (index < others.length) {
      const prompt = prompts[nextPrompt];
      const range = prompt ? ownBlocks(others, index, prompt.text) : undefined;
      const end = range ? range[0] : others.length;
      for (const block of others.slice(index, end)) {
        // Ahead of the first prompt: the session context the host sends again.
        if (first && !anchor) continue;
        if (block.type === 'image') {
          add(anchor, '[fast-jev-compaction: 1 image omitted here]');
          continue;
        }
        if (block.type !== 'text') continue;
        const text = String(block['text'] ?? '').trim();
        if (isCountdown(text) || (hasToolReference && text === TOOL_LOADED)) continue;
        add(anchor, text);
      }
      if (!range) break;
      anchor = { row: prompt! };
      nextPrompt += 1;
      first = false;
      index = range[1];
    }
    first = false;
  }
  return out;
}

function sameAnchor(a: HiddenAnchor, b: HiddenAnchor): boolean {
  return 'toolUseId' in a ? 'toolUseId' in b && a.toolUseId === b.toolUseId : 'row' in b && a.row === b.row;
}

/**
 * Appends each piece of hidden content to its anchor in the compacted
 * `messages`: a tool result's text, or a prompt row's text. A prompt row is
 * found by identity, else by its text. Content whose anchor is gone goes to
 * the nearest earlier result that was placed; with none, it is counted lost.
 * Messages that change are copies; the input is not modified.
 */
export function foldHiddenContent<M extends Message>(
  messages: readonly M[],
  hidden: readonly HiddenContent[],
): { messages: M[]; folded: number; lost: number } {
  const out = [...messages];
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
  for (const { anchor, text } of hidden) {
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
  return { messages: out, folded, lost };
}
