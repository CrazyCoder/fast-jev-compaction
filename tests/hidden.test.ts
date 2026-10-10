import { describe, expect, it } from 'vitest';
import { foldHiddenContent, hiddenContent, type ApiMessage } from '../src/hidden.js';
import type { Message } from '../src/index.js';

const countdown = (n: number) => `<system-reminder>\n<total_tokens>${n} tokens left</total_tokens>\n</system-reminder>`;
const queued = (text: string) =>
  `<system-reminder>\nThe user sent a new message while you were working:\n${text}\n\nThis is how Claude Code surfaces messages the user sends mid-turn.\n</system-reminder>`;

function user(text: string): Message {
  return { role: 'user', text, toolUses: [] };
}
function call(id: string, tool: string): Message {
  return { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input: {} }] };
}
function result(id: string, text: string): Message {
  return { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError: false }] };
}

/** Rows and their API view, shaped as Claude Code 2.1.296 renders them (probe of 2026-10-10). */
function session() {
  const rows: Message[] = [
    user('Use the skill, read a.ts, look at the screenshot.'),
    call('s1', 'Skill'),
    result('s1', 'Launching skill: probe'),
    call('r1', 'Read'),
    result('r1', 'file a'),
    call('q1', 'ToolSearch'),
    result('q1', ''),
    call('i1', 'Read'),
    result('i1', 'image file'),
    { role: 'assistant', text: 'Done.', toolUses: [] },
    user('next prompt'),
  ];
  const api: ApiMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>\n# Environment\ncwd\n</system-reminder>' },
        { type: 'text', text: countdown(15_000_000) },
        { type: 'text', text: 'Use the skill, read a.ts, look at the screenshot.' },
      ],
    },
    { role: 'assistant', content: [{ type: 'tool_use', id: 's1' }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 's1', content: `Launching skill: probe\n\n${countdown(14_000_000)}` },
        { type: 'text', text: 'Base directory for this skill: /x\n\nThe skill body.' },
      ],
    },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r1' }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'r1', content: `file a\n\n${queued('also check b.ts')}` }],
    },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'q1' }] },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'q1',
          content: [
            { type: 'tool_reference', tool_name: 'mcp__x__search' },
            { type: 'tool_reference', tool_name: 'mcp__x__fetch' },
          ],
        },
        { type: 'text', text: 'Tool loaded.' },
      ],
    },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'i1' }] },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'i1',
          content: [
            { type: 'text', text: 'image file' },
            { type: 'image', source: { type: 'base64', data: 'AAAA' } },
          ],
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'next prompt' },
        { type: 'text', text: '<system-reminder>\nContents of b.ts: attached\n</system-reminder>' },
      ],
    },
  ];
  return { rows, api };
}

describe('hidden content', () => {
  it('finds what each row group holds beyond the rows, without countdowns or the session context', () => {
    const { rows, api } = session();
    const hidden = hiddenContent(rows, api);
    expect(hidden).toEqual([
      { anchor: { toolUseId: 's1' }, text: 'Base directory for this skill: /x\n\nThe skill body.' },
      { anchor: { toolUseId: 'r1' }, text: queued('also check b.ts') },
      {
        anchor: { toolUseId: 'q1' },
        text: '[fast-jev-compaction: deferred tools mcp__x__search, mcp__x__fetch were loaded here; load them again with ToolSearch before use]',
      },
      { anchor: { toolUseId: 'i1' }, text: '[fast-jev-compaction: 1 image omitted from this tool result]' },
      { anchor: { row: rows[10] }, text: '<system-reminder>\nContents of b.ts: attached\n</system-reminder>' },
    ]);
  });

  it('folds it into the compacted rows: after the anchor result, or after the anchor prompt', () => {
    const { rows, api } = session();
    const hidden = hiddenContent(rows, api);
    // Compaction truncated r1's result and kept the rest; rows are matched by tool_use_id and text.
    const compacted = rows.map((row) =>
      row.toolResults?.[0]?.tool_use_id === 'r1'
        ? result('r1', 'file a [truncated]')
        : row,
    );
    const { messages, folded, lost } = foldHiddenContent(compacted, hidden);
    expect(lost).toBe(0);
    expect(folded).toBe(5);
    const textOf = (id: string) => messages.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === id)!.text;
    expect(textOf('s1')).toBe('Launching skill: probe\n\nBase directory for this skill: /x\n\nThe skill body.');
    expect(textOf('r1')).toBe(`file a [truncated]\n\n${queued('also check b.ts')}`);
    expect(textOf('i1')).toMatch(/^image file\n\n\[fast-jev-compaction: 1 image omitted/);
    expect(messages.at(-1)!.text).toBe('next prompt\n\n<system-reminder>\nContents of b.ts: attached\n</system-reminder>');
    // The input rows are left alone.
    expect(rows[2]!.toolResults![0]!.text).toBe('Launching skill: probe');
  });

  it('moves content whose result was removed to the nearest earlier kept result, and counts what has nowhere to go', () => {
    const { rows, api } = session();
    const hidden = hiddenContent(rows, api);
    const withoutR1 = rows.filter((row) => row.toolUses[0]?.tool_use_id !== 'r1' && row.toolResults?.[0]?.tool_use_id !== 'r1');
    const out = foldHiddenContent(withoutR1, hidden);
    const s1 = out.messages.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === 's1')!;
    expect(s1.text).toContain('also check b.ts');
    expect(out.lost).toBe(0);

    const none = foldHiddenContent([user('only a prompt')], hidden);
    expect(none.lost).toBe(5);
  });
});
