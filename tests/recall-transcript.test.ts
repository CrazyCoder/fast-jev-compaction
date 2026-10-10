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
const CUT = 'line\n[fast-jev-compaction truncated 245 chars of this tool result; full text: recall expand ["t1"]]';

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
