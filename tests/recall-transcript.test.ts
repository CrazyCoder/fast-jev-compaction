import { describe, expect, it } from 'vitest';
import { entriesFromGroups } from '../src/recall/transcript.js';
import { callRow, resultRow, userRow } from './helpers/rows.js';

const FULL = 'line\n'.repeat(50);
const SAVED = 'C:\\Users\\me\\.claude\\projects\\p\\s\\tool-results\\abc.txt';
const user = userRow;
const result = resultRow;
const assistant = (text: string, id: string) => callRow(id, text, { file_path: `${id}.ts` });
const reply = (text: string) => ({ role: 'assistant' as const, text, toolUses: [] });
const shape = (groups: Parameters<typeof entriesFromGroups>[0]) =>
  entriesFromGroups(groups).map((e) => [e.n, e.kind, e.kind === 'call' ? e.id : e.text]);

describe('entriesFromGroups', () => {
  it('reads archived rows, then live rows, keeping the first result and counting a copied prompt once', () => {
    const archived = [user('go'), assistant('Reading.', 't1'), result('t1', FULL)];
    const live = [user('go'), assistant('Reading.', 't1'), result('t1', 'line\n[fast-jev-compaction truncated]'), user('next')];
    expect(shape([archived, live])).toEqual([
      [1, 'prompt', 'go'],
      [2, 'reply', 'Reading.'],
      [3, 'call', 't1'],
      [4, 'prompt', 'next'],
    ]);
    expect(entriesFromGroups([archived, live])[2]).toMatchObject({ result: FULL, input: { file_path: 't1.ts' } });
  });

  it('keeps a short prompt or reply said again later, after other work', () => {
    const first = [user('yes'), reply('Done.')];
    const later = [user('yes'), reply('Done.'), assistant('', 't1'), result('t1', 'ok'), user('yes'), reply('Done.')];
    expect(shape([first, later])).toEqual([
      [1, 'prompt', 'yes'],
      [2, 'reply', 'Done.'],
      [3, 'call', 't1'],
      [4, 'prompt', 'yes'],
      [5, 'reply', 'Done.'],
    ]);
  });

  it('finds where a large output was saved', () => {
    const rows = [assistant('', 't2'), result('t2', `Output too large. Full output saved to: ${SAVED}\n\nPreview`)];
    expect(entriesFromGroups([rows])[0]).toMatchObject({ kind: 'call', savedTo: SAVED });
  });

  it('leaves out the reminders the host adds to a prompt or result', () => {
    const rows = [user('Now c.ts.\n\n<system-reminder>\nContents of c.ts\n</system-reminder>')];
    expect(shape([rows])).toEqual([[1, 'prompt', 'Now c.ts.']]);
  });
});
