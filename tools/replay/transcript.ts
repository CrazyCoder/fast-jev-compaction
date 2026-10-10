// Replay harness: parses Claude Code session transcripts (JSONL) into the library's Message[].
// Design after considerITman/fast-systemone-compaction `tools/replay/transcript.ts` (MIT);
// reimplemented here, with compact-boundary and recorded-decision extraction added.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { Message, ToolResult, ToolUse } from '../../src/index.js';

type Block = Record<string, unknown>;

/** One decision the hook logged (`t12:Read:drop_call/call=0.21/result=0.11`). */
export interface RecordedEntry {
  id: string;
  tool: string;
  action: string;
  keepCall: number;
  keepResult: number;
}

/** One logged compaction: the decisions that were made when `messages.length === messageIndex`. */
export interface RecordedEvent {
  messageIndex: number;
  entries: RecordedEntry[];
}

export interface ParsedTranscript {
  messages: Message[];
  malformedLines: number;
  /** Message indices at which a `compact_boundary` entry occurred (the segment starts there). */
  boundaries: number[];
  recorded: RecordedEvent[];
}

const ENTRY = /^(t\d+):(.+?):(\w+)\/call=([\d.]+)\/result=([\d.]+)$/;
const DECISIONS = /^jetcompact: decisions(?: \((\d+)\/(\d+)\))?: (.*)$/s;

function isRecord(value: unknown): value is Block {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinText(blocks: readonly Block[]): string {
  return blocks
    .map((block) => (block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : ''))
    .join('');
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? joinText(content.filter(isRecord)) : '';
}

function parseEntries(body: string): RecordedEntry[] {
  const entries: RecordedEntry[] = [];
  for (const word of body.split(' ')) {
    const match = ENTRY.exec(word);
    if (match) {
      entries.push({
        id: match[1]!,
        tool: match[2]!,
        action: match[3]!,
        keepCall: Number(match[4]),
        keepResult: Number(match[5]),
      });
    }
  }
  return entries;
}

/**
 * Incremental parser: feed it one line at a time. Sidechain (subagent) entries are ignored.
 * Consecutive assistant lines sharing a `message.id` (Claude Code writes one line per content
 * block) are merged into one message, as the hook sees them.
 */
export class TranscriptParser {
  readonly result: ParsedTranscript = { messages: [], malformedLines: 0, boundaries: [], recorded: [] };
  private lastAssistantId: string | undefined;
  private lastPart = 0;

  push(raw: string): void {
    if (raw.trim() === '') return;
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      this.result.malformedLines++;
      return;
    }
    if (!isRecord(entry) || entry['isSidechain'] === true) return;
    const { messages } = this.result;
    const type = entry['type'];

    if (type === 'system') {
      if (entry['subtype'] === 'compact_boundary') {
        this.result.boundaries.push(messages.length);
        return;
      }
      const content = entry['content'];
      const match = typeof content === 'string' ? DECISIONS.exec(content) : null;
      if (match) this.pushDecisions(match, messages.length);
      return;
    }

    const message = entry['message'];
    if ((type !== 'user' && type !== 'assistant') || !isRecord(message)) return;
    const content = message['content'];
    const blocks = Array.isArray(content) ? content.filter(isRecord) : [];

    if (type === 'assistant') {
      const toolUses: ToolUse[] = blocks
        .filter((block) => block['type'] === 'tool_use')
        .map((block) => ({
          tool_use_id: String(block['id']),
          tool: String(block['name']),
          input: isRecord(block['input']) ? block['input'] : {},
        }));
      const text = joinText(blocks);
      const id = typeof message['id'] === 'string' ? message['id'] : undefined;
      const previous = messages[messages.length - 1];
      if (id !== undefined && id === this.lastAssistantId && previous?.role === 'assistant') {
        previous.text += text;
        previous.toolUses.push(...toolUses);
      } else {
        messages.push({ role: 'assistant', text, toolUses });
      }
      this.lastAssistantId = id;
      return;
    }

    this.lastAssistantId = undefined;
    const toolResults: ToolResult[] = blocks
      .filter((block) => block['type'] === 'tool_result')
      .map((block) => ({
        tool_use_id: String(block['tool_use_id']),
        text: resultText(block['content']),
        isError: block['is_error'] === true,
      }));
    const text = typeof content === 'string' ? content : joinText(blocks);
    messages.push(
      toolResults.length > 0
        ? { role: 'user', text, toolUses: [], toolResults }
        : { role: 'user', text, toolUses: [] },
    );
  }

  private pushDecisions(match: RegExpExecArray, messageIndex: number): void {
    const part = match[1] === undefined ? 1 : Number(match[1]);
    const entries = parseEntries(match[3]!);
    const last = this.result.recorded[this.result.recorded.length - 1];
    if (part > 1 && last && this.lastPart === part - 1) last.entries.push(...entries);
    else if (entries.length > 0) this.result.recorded.push({ messageIndex, entries });
    this.lastPart = part;
  }
}

/** Parses the text of a session file (one JSON entry per line). Malformed lines are counted. */
export function parseTranscript(jsonlText: string): ParsedTranscript {
  const parser = new TranscriptParser();
  for (const line of jsonlText.split('\n')) parser.push(line);
  return parser.result;
}

/** Streams a session file; transcripts reach tens of MB. */
export async function parseTranscriptFile(path: string): Promise<ParsedTranscript> {
  const parser = new TranscriptParser();
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) parser.push(line);
  return parser.result;
}

export interface Segment {
  /** Inclusive start index into the transcript's messages. */
  start: number;
  /** Exclusive end index. */
  end: number;
}

/**
 * Splits at compact boundaries. Choice: every segment is replayed on its own, starting
 * from the boundary (where Claude Code's own summary message sits as message 0), because the
 * model never saw the pre-boundary messages again. Empty segments are dropped.
 */
export function segmentsOf(parsed: Pick<ParsedTranscript, 'messages' | 'boundaries'>): Segment[] {
  const cuts = [0, ...parsed.boundaries, parsed.messages.length];
  const segments: Segment[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i]!;
    const end = cuts[i + 1]!;
    if (end > start) segments.push({ start, end });
  }
  return segments;
}
