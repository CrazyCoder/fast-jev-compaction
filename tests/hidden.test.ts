import { describe, expect, it } from 'vitest';
import { dropTransientReminders, foldHiddenContent, hiddenContent, type ApiMessage } from '../src/hidden.js';
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

describe('transient host reminders', () => {
  const reminder = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`;
  const transient = [
    'Concise output style is active. Be concise: lead with the result.',
    "The task tools haven't been used recently. If you're working on tasks...",
    '<new-diagnostics>The following new diagnostic issues were detected:\n\nx.ts: × error</new-diagnostics>',
    'The user hasn\'t heard from you in a while — say in a few words what you\'re doing, then continue.',
    'Note: C:\\x\\a.ts changed on disk since you last read it. That\'s usually deliberate.',
    'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded:\nTaskCreate',
    '# MCP Server Instructions\n\nThe following MCP servers have provided instructions',
  ];
  const kept = [
    'The user sent a new message while you were working:\nalso check b.ts',
    '[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>result</task-notification>',
    'Contents of b.ts: attached',
  ];

  it('folds back what the user or a task said, never what the host re-sends or what went stale', () => {
    const rows: Message[] = [user('go'), call('r1', 'Read'), result('r1', 'file a')];
    const api: ApiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'r1' }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'r1', content: ['file a', ...[...transient, ...kept].map(reminder)].join('\n\n') },
          ...transient.map((text) => ({ type: 'text', text: reminder(text) })),
        ],
      },
    ];
    // One result's extras go back as one piece.
    const [only, ...none] = hiddenContent(rows, api);
    expect(none).toEqual([]);
    expect(only).toEqual({ anchor: { toolUseId: 'r1' }, text: kept.map(reminder).join('\n\n') });
  });
});

describe('transient reminders already in the rows', () => {
  const stale = '<system-reminder>\nConcise output style is active. Be concise.\n</system-reminder>';
  const said = '<system-reminder>\nThe user sent a new message while you were working:\nstop\n</system-reminder>';

  it('removes them from tool results and prompts, keeps everything else, and counts the characters', () => {
    const rows: Message[] = [
      user(`go\n\n${stale}`),
      call('r1', 'Read'),
      result('r1', `file a\n\n${stale}\n\n${said}`),
      result('r2', 'file b'),
    ];
    const out = dropTransientReminders(rows);
    expect(out.messages[0]!.text).toBe('go');
    expect(out.messages[2]!.toolResults![0]!.text).toBe(`file a\n\n${said}`);
    expect(out.messages[3]).toBe(rows[3]);
    expect(out.chars).toBe(2 * (stale.length + 2));
    expect(rows[0]!.text).toContain(stale);
  });
});

describe('hidden content on a second compaction', () => {
  const context = [
    { type: 'text', text: '<system-reminder>\n# Environment\ncwd\n</system-reminder>' },
    { type: 'text', text: "<system-reminder>\nToday's date is 2026-10-10.\n</system-reminder>" },
    { type: 'text', text: '<system-reminder>\nThe following skills are available for use with the Skill tool:\n- x\n</system-reminder>' },
  ];

  it('skips the session context the host re-sends after a compaction, and what is already in the rows', () => {
    const folded = 'Base directory for this skill: /x\n\nThe skill body.';
    const rows: Message[] = [
      user('first prompt'),
      call('s1', 'Skill'),
      result('s1', `Launching skill: probe\n\n${folded}`),
      { role: 'assistant', text: 'ok', toolUses: [] },
      user('<command-name>/compact</command-name>'),
      user('second prompt'),
      { role: 'assistant', text: 'ok', toolUses: [] },
    ];
    const api: ApiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 's1' }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 's1', content: `Launching skill: probe\n\n${folded}` },
          { type: 'text', text: folded },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      {
        role: 'user',
        content: [
          ...context,
          { type: 'text', text: '<local-command-caveat>Caveat</local-command-caveat>' },
          { type: 'text', text: '<command-name>/compact</command-name>' },
          { type: 'text', text: 'second prompt' },
          { type: 'text', text: '<system-reminder>\nContents of b.ts\n</system-reminder>' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ];
    expect(hiddenContent(rows, api).map((h) => h.text)).toEqual([
      '<local-command-caveat>Caveat</local-command-caveat>',
      '<system-reminder>\nContents of b.ts\n</system-reminder>',
    ]);
  });
});

describe('hidden content after a compaction and with unmatched rows', () => {
  it('never takes a prompt row text for hidden content, even after a row it cannot find', () => {
    const rows: Message[] = [
      user('first prompt'),
      { role: 'assistant', text: 'ok', toolUses: [] },
      user('a row the API form renders differently'),
      { role: 'assistant', text: 'ok', toolUses: [] },
      user('<command-name>/compact</command-name>'),
      user('<local-command-stdout>Compacted</local-command-stdout>'),
      user('second prompt'),
      { role: 'assistant', text: 'ok', toolUses: [] },
    ];
    const api: ApiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>\ncontext\n</system-reminder>' }, { type: 'text', text: 'first prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'a row the API form renders DIFFERENTLY' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: '<local-command-caveat>Caveat</local-command-caveat>' },
          { type: 'text', text: '<command-name>/compact</command-name>' },
          { type: 'text', text: '<local-command-stdout>Compacted</local-command-stdout>' },
          { type: 'text', text: 'second prompt' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ];
    const hidden = hiddenContent(rows, api);
    const texts = hidden.map((h) => h.text).join('\n');
    expect(texts).not.toContain('second prompt');
    expect(texts).not.toContain('<command-name>');
    expect(texts).toContain('<local-command-caveat>');
  });
});

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

  it('cuts content attached to a result compaction cut, and reports the characters it adds', () => {
    const { rows, api } = session();
    const hidden = hiddenContent(rows, api);
    const long = { anchor: { toolUseId: 's1' }, text: 'x'.repeat(1000) };
    const out = foldHiddenContent(rows, [long, ...hidden.slice(1)], { cutIds: new Set(['s1']), headChars: 50 });
    const s1 = out.messages.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === 's1')!;
    expect(s1.text).toBe(
      `Launching skill: probe\n\n${'x'.repeat(50)}\n[fast-jev-compaction cut 950 chars of content attached here]`,
    );
    const before = rows.reduce((sum, m) => sum + m.text.length + (m.toolResults ?? []).reduce((s, r) => s + r.text.length, 0), 0);
    const after = out.messages.reduce((sum, m) => sum + m.text.length + (m.toolResults ?? []).reduce((s, r) => s + r.text.length, 0), 0);
    expect(out.chars).toBe(after - before);
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
