import { describe, expect, it } from 'vitest';
import { readTranscript } from '../src/recall/transcript.ts';

type Block = Record<string, unknown>;
const row = (type: string, content: string | Block[], extra: Block = {}) =>
  JSON.stringify({ type, message: { role: type, content }, ...extra });
const prompt = (text: string) => row('user', text);
const reply = (text: string) => row('assistant', [{ type: 'text', text }]);
const call = (id: string, input: Block = { file_path: `${id}.ts` }) =>
  row('assistant', [{ type: 'tool_use', id, name: 'Read', input }]);
const result = (id: string, content: string | Block[], extra: Block = {}) =>
  row('user', [{ type: 'tool_result', tool_use_id: id, content, ...extra }]);
const boundary = () => JSON.stringify({ type: 'system', subtype: 'compact_boundary' });

const FULL = 'line\n'.repeat(50);
const CUT = 'line\n[jetcompact truncated 245 chars of this tool result; full text: recall expand ["t1"]]';

describe('readTranscript', () => {
  it('reads prompts, replies and calls with their results in order', () => {
    const entries = readTranscript(
      [prompt('Fix the bug.'), call('t1'), result('t1', FULL), reply('Fixed.'), row('attachment', 'x')].join('\n'),
    );
    expect(entries).toEqual([
      { n: 1, kind: 'prompt', text: 'Fix the bug.' },
      { n: 2, kind: 'call', id: 't1', tool: 'Read', input: { file_path: 't1.ts' }, result: FULL },
      { n: 3, kind: 'reply', text: 'Fixed.' },
    ]);
  });

  it('skips the copies a compaction writes after its boundary and keeps the uncut result', () => {
    const entries = readTranscript(
      [
        prompt('Fix the bug.'),
        call('t1'),
        result('t1', FULL),
        reply('Done.'),
        boundary(),
        row('user', 'This session is being continued from a previous conversation.', { isCompactSummary: true }),
        prompt('Fix the bug.'),
        call('t1'),
        result('t1', CUT),
        reply('Done.'),
        prompt('yes'),
        reply('Done.'),
      ].join('\n'),
    );
    expect(entries.map((e) => (e.kind === 'call' ? `call ${e.id}` : `${e.kind} ${e.text}`))).toEqual([
      'prompt Fix the bug.',
      'call t1',
      'reply Done.',
      'prompt yes',
      'reply Done.',
    ]);
    expect(entries[1]).toMatchObject({ result: FULL });
  });

  it('skips copies that keep only some messages, by their compaction-time timestamp', () => {
    const at = (time: string) => ({ timestamp: `2026-10-10T${time}Z` });
    const entries = readTranscript(
      [
        row('user', 'Fix the bug.', at('10:00:00')),
        row('assistant', [{ type: 'text', text: 'Looking.' }], at('10:00:01')),
        row('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], at('10:00:02')),
        row('user', [{ type: 'tool_result', tool_use_id: 't1', content: FULL }], at('10:00:03')),
        row('assistant', [{ type: 'text', text: 'Fixed it.' }], at('10:00:04')),
        JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-10T11:00:00.500Z' }),
        // The kept copies, stamped just before the boundary: the call was dropped.
        row('user', 'Fix the bug.', at('11:00:00.400')),
        row('assistant', [{ type: 'text', text: 'Fixed it.' }], at('11:00:00.400')),
        // Said again after the compaction: a new entry.
        row('user', 'Fix the bug.', at('11:05:00')),
      ].join('\n'),
    );
    expect(entries.map((e) => (e.kind === 'call' ? e.id : e.text))).toEqual([
      'Fix the bug.',
      'Looking.',
      't1',
      'Fixed it.',
      'Fix the bug.',
    ]);
  });

  it('skips copies by their order when the compaction boundary has no timestamp', () => {
    const at = (s: number) => `2026-10-10T10:00:${String(s).padStart(2, '0')}.000Z`;
    const entries = readTranscript(
      [
        { type: 'user', timestamp: at(1), message: { content: 'P1' } },
        { type: 'assistant', timestamp: at(2), message: { content: [{ type: 'text', text: 'R1' }] } },
        { type: 'system', subtype: 'compact_boundary' },
        { type: 'user', timestamp: at(3), message: { content: 'P1' } },
        { type: 'assistant', timestamp: at(3), message: { content: [{ type: 'text', text: 'R1' }] } },
        { type: 'user', timestamp: at(4), message: { content: 'P2' } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    expect(entries.map((e) => (e.kind === 'call' ? e.tool : e.text))).toEqual(['P1', 'R1', 'P2']);
  });

  it('reads a row once when the transcript holds it again under the same uuid', () => {
    const rows = [
      row('user', 'Fix the bug.', { uuid: 'u1', timestamp: '2026-10-10T10:00:00Z' }),
      row('assistant', [{ type: 'text', text: 'Fixed it.' }], { uuid: 'u2', timestamp: '2026-10-10T10:00:01Z' }),
    ];
    const entries = readTranscript([...rows, ...rows, row('user', 'Thanks.', { uuid: 'u3' })].join('\n'));
    expect(entries.map((e) => (e.kind === 'call' ? e.id : e.text))).toEqual(['Fix the bug.', 'Fixed it.', 'Thanks.']);
  });

  it('reads sidechain rows when asked, as a subagent transcript holds only those', () => {
    const lines = [row('user', 'Research it.', { isSidechain: true }), row('assistant', [{ type: 'text', text: 'Found it.' }], { isSidechain: true })];
    expect(readTranscript(lines.join('\n'))).toEqual([]);
    expect(readTranscript(lines.join('\n'), { sidechain: true }).map((e) => e.kind)).toEqual(['prompt', 'reply']);
  });

  it('keeps a short prompt said again later, after other work', () => {
    const entries = readTranscript(
      [prompt('yes'), reply('ok'), call('t1'), result('t1', 'x'), prompt('yes'), reply('ok')].join('\n'),
    );
    expect(entries.filter((e) => e.kind === 'prompt')).toHaveLength(2);
  });

  it('drops host reminders, meta and sidechain rows, and notes where a large output was saved', () => {
    const saved = 'Output too large (32.4KB). Full output saved to: /cfg/projects/p/s/tool-results/a.txt\n\nPreview…';
    const entries = readTranscript(
      [
        prompt('Look.\n\n<system-reminder>\nConcise output style is active.\n</system-reminder>'),
        row('user', 'skill body', { isMeta: true }),
        row('assistant', [{ type: 'text', text: 'subagent' }], { isSidechain: true }),
        call('t2'),
        result('t2', [{ type: 'text', text: saved }], { is_error: true }),
        'not json',
      ].join('\n'),
    );
    expect(entries).toEqual([
      { n: 1, kind: 'prompt', text: 'Look.' },
      {
        n: 2,
        kind: 'call',
        id: 't2',
        tool: 'Read',
        input: { file_path: 't2.ts' },
        result: saved,
        isError: true,
        savedTo: '/cfg/projects/p/s/tool-results/a.txt',
      },
    ]);
  });
});
