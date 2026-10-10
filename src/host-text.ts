import { PLUGIN_ID } from './brand.js';
import { sliceSurrogateSafe } from './state.js';
import type { Message, ResolvedCompactOptions } from './types.js';

export interface HostTextPattern {
  name: string;
  /** Global regex matching one whole block, from its opening to its closing delimiter. */
  pattern: RegExp;
  why: string;
}

const tagBlock = (tag: string): RegExp => new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g');

/**
 * Text the host, not the user, writes under the user role. Recognition is by
 * explicit delimiters only: a block is trimmed when it is a complete tag pair
 * or a hook-output header at the very start of a message, never by wording.
 */
export const HOST_TEXT_PATTERNS: readonly HostTextPattern[] = [
  { name: 'system-reminder', pattern: tagBlock('system-reminder'), why: 'reminders, memory, skill listings and hook context the harness injects into user turns' },
  { name: 'task-notification', pattern: tagBlock('task-notification'), why: 'background task and subagent completion notices' },
  { name: 'local-command-stdout', pattern: tagBlock('local-command-stdout'), why: 'output of a local slash command' },
  { name: 'local-command-stderr', pattern: tagBlock('local-command-stderr'), why: 'error output of a local slash command' },
  { name: 'local-command-caveat', pattern: tagBlock('local-command-caveat'), why: 'the "ignore these local command messages" caveat' },
  { name: 'command-message', pattern: tagBlock('command-message'), why: 'echo of a slash command the user ran' },
  { name: 'command-name', pattern: tagBlock('command-name'), why: 'echo of a slash command name (/compact, /clear ...)' },
  { name: 'command-args', pattern: tagBlock('command-args'), why: 'echo of slash command arguments' },
  { name: 'bash-input', pattern: tagBlock('bash-input'), why: 'echo of a "!" shell command' },
  { name: 'bash-stdout', pattern: tagBlock('bash-stdout'), why: 'stdout of a "!" shell command' },
  { name: 'bash-stderr', pattern: tagBlock('bash-stderr'), why: 'stderr of a "!" shell command' },
  {
    name: 'hook-output-header',
    pattern: /^[ \t]*(?:SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|SubagentStop|PreCompact) hook (?:additional context|success|error|blocking error)[\s\S]*$/g,
    why: 'untagged hook output; anchored to the start of the message and runs to its end',
  },
];

export const HOST_TEXT_MARKER_PREFIX = `[${PLUGIN_ID} trimmed `;

const markerOf = (chars: number): string => `${HOST_TEXT_MARKER_PREFIX}${chars} chars of host notice]`;

/** `[start, end)` ranges of recognized host blocks, sorted and non-overlapping. */
function hostRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const { pattern } of HOST_TEXT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] < last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** The text with every recognized host block removed. */
export function stripHostText(text: string): string {
  let out = '';
  let at = 0;
  for (const [start, end] of hostRanges(text)) {
    out += text.slice(at, start);
    at = end;
  }
  return out + text.slice(at);
}

/** Whether the text is made only of recognized host blocks (and whitespace). */
export function isHostText(text: string): boolean {
  return text.trim().length > 0 && stripHostText(text).trim().length === 0;
}

/** Children of a task-notification that are small pointers to recover the rest. */
const TASK_KEEP_TAGS = new Set(['task-id', 'status', 'summary', 'output-file', 'tool-use-id']);

/**
 * A task-notification keeps its pointer elements whole and the `<result>` (a
 * subagent's final report, not reproducible) up to `resultChars`; every other
 * child (`<event>`, `<usage>`, ...) is dropped into one marker.
 */
function trimTaskNotification(block: string, resultChars: number): string {
  const open = '<task-notification>';
  const close = '</task-notification>';
  const inner = block.slice(open.length, block.length - close.length);
  let kept = '';
  let cut = 0;
  let rest = inner;
  for (const match of inner.matchAll(/<([\w-]+)>([\s\S]*?)<\/\1>/g)) {
    const [element, tag, body] = [match[0], match[1]!, match[2]!];
    rest = rest.replace(element, '');
    if (TASK_KEEP_TAGS.has(tag)) {
      kept += `\n${element}`;
    } else if (tag === 'result') {
      if (body.length <= resultChars + 120) {
        kept += `\n${element}`;
      } else {
        const head = sliceSurrogateSafe(body, 0, resultChars);
        kept += `\n<result>${head}\n${markerOf(body.length - head.length)}</result>`;
      }
    } else {
      cut += element.length;
    }
  }
  cut += rest.trim().length;
  const marker = cut > 0 ? `\n${markerOf(cut)}` : '';
  return `${open}${kept}${marker}\n${close}`;
}

/**
 * Cuts each recognized host block longer than `headChars` + a margin to its
 * head and a marker. A block that already carries the marker is left alone,
 * which makes the pass idempotent. The closing tag is re-appended so the cut
 * block stays a closed pair and cannot swallow a later block.
 */
export function trimHostBlocks(text: string, headChars: number, taskResultHeadChars = 0): string {
  let out = '';
  let at = 0;
  for (const [start, end] of hostRanges(text)) {
    const block = text.slice(start, end);
    if (block.includes(HOST_TEXT_MARKER_PREFIX)) continue;
    if (taskResultHeadChars > 0 && block.startsWith('<task-notification>')) {
      const rebuilt = trimTaskNotification(block, taskResultHeadChars);
      if (rebuilt.length + 120 < block.length) {
        out += text.slice(at, start) + rebuilt;
        at = end;
        continue;
      }
    }
    if (block.length <= headChars + 120) continue;
    const close = block.startsWith('<') ? (/<\/[\w-]+>$/.exec(block)?.[0] ?? '') : '';
    const head = sliceSurrogateSafe(block, 0, headChars);
    out += `${text.slice(at, start)}${head}\n${markerOf(block.length - head.length - close.length)}${close}`;
    at = end;
  }
  return out + text.slice(at);
}

/**
 * Trims host text from user messages outside the pinned ones. The first
 * message is trimmed only when it is itself host text; the newest
 * `preserveRecentMessages` never are. Tool results are not touched.
 */
export function trimHostText(
  messages: readonly Message[],
  options: Pick<ResolvedCompactOptions, 'preserveRecentMessages' | 'hostTextHeadChars' | 'taskResultHeadChars'>,
): { messages: Message[]; trimmed: number; charsCut: number } {
  let trimmed = 0;
  let charsCut = 0;
  const out = messages.map((message, index) => {
    if (message.role !== 'user' || (message.toolResults ?? []).length > 0) return message;
    if (index >= messages.length - options.preserveRecentMessages) return message;
    if (index === 0 && !isHostText(message.text)) return message;
    const text = trimHostBlocks(message.text, options.hostTextHeadChars, options.taskResultHeadChars);
    if (text === message.text) return message;
    trimmed += 1;
    charsCut += message.text.length - text.length;
    return { ...message, text };
  });
  return { messages: out, trimmed, charsCut };
}
