import { describe, expect, it } from 'vitest';
import { entriesFromGroups, readTranscript } from '../src/recall/transcript.js';
import { callRow, resultRow, userRow } from './helpers/rows.js';

type Block = Record<string, unknown>;
const row = (type: string, content: string | Block[], extra: Block = {}) =>
  JSON.stringify({ type, uuid: Math.random().toString(36), message: { role: type, content }, ...extra });
const prompt = (text: string, extra: Block = {}) => row('user', text, extra);
const reply = (blocks: Block[]) => row('assistant', blocks);
const use = (id: string, name: string, input: Block) => ({ type: 'tool_use', id, name, input });
const answer = (id: string, content: unknown, isError = false) =>
  row('user', [{ type: 'tool_result', tool_use_id: id, content, ...(isError && { is_error: true }) }]);

const FULL = 'line\n'.repeat(50);
const SAVED = 'C:\\Users\\me\\.claude\\projects\\p\\s\\tool-results\\abc.txt';

function transcript(): string {
  return [
    JSON.stringify({ type: 'file-history-snapshot' }),
    prompt('Fix the bug in a.ts.'),
    reply([{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Reading it.' }, use('t1', 'Read', { file_path: 'a.ts' })]),
    answer('t1', [{ type: 'text', text: FULL }]),
    reply([use('t2', 'Bash', { command: 'npm test' })]),
    answer('t2', `<persisted-output>\nOutput too large (32.4KB). Full output saved to: ${SAVED}\n\nPreview (first 2KB):\nFAIL x\n</persisted-output>`, true),
    prompt('<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }),
    row('assistant', [{ type: 'text', text: 'subagent says hi' }], { isSidechain: true }),
    JSON.stringify({ type: 'attachment', attachment: { type: 'skill', content: 'body' } }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }),
    // What the compaction kept, written again after the boundary.
    prompt('Fix the bug in a.ts.'),
    reply([{ type: 'text', text: 'Reading it.' }, use('t1', 'Read', { file_path: 'a.ts' })]),
    answer('t1', 'line\n[fast-jev-compaction truncated 245 chars of this tool result]\n\n<system-reminder>\nnudge\n</system-reminder>'),
    prompt(`Now c.ts.\n\n<system-reminder>\nContents of c.ts\n</system-reminder>`),
    'not json',
  ].join('\n');
}

describe('readTranscript', () => {
  it('numbers prompts, replies and tool calls in order, once each, across compactions', () => {
    const entries = readTranscript(transcript());
    expect(entries.map((e) => [e.n, e.kind, e.kind === 'call' ? e.id : e.text])).toEqual([
      [1, 'prompt', 'Fix the bug in a.ts.'],
      [2, 'reply', 'Reading it.'],
      [3, 'call', 't1'],
      [4, 'call', 't2'],
      [5, 'prompt', 'Now c.ts.'],
    ]);
  });

  it('keeps the first, uncut result of a call and where a large output was saved', () => {
    const [, , read, bash] = readTranscript(transcript());
    expect(read).toMatchObject({ kind: 'call', tool: 'Read', input: { file_path: 'a.ts' }, result: FULL });
    expect(bash).toMatchObject({ kind: 'call', tool: 'Bash', isError: true, savedTo: SAVED });
    expect(bash!.kind === 'call' && bash!.result).toContain('Output too large');
  });

  it('records the transcript line each entry starts on', () => {
    const entries = readTranscript(transcript());
    expect(entries.map((e) => e.line)).toEqual([2, 3, 3, 5, 14]);
  });
});

describe('entriesFromGroups', () => {
  const user = userRow;
  const result = resultRow;
  const assistant = (text: string, id: string) => callRow(id, text, { file_path: `${id}.ts` });

  it('reads archived rows, then live rows, keeping the first result and counting a copied prompt once', () => {
    const archived = [user('go'), assistant('Reading.', 't1'), result('t1', FULL)];
    const live = [user('go'), assistant('Reading.', 't1'), result('t1', 'line\n[fast-jev-compaction truncated]'), user('next')];
    const entries = entriesFromGroups([archived, live]);
    expect(entries.map((e) => [e.n, e.kind, e.kind === 'call' ? e.id : e.text])).toEqual([
      [1, 'prompt', 'go'],
      [2, 'reply', 'Reading.'],
      [3, 'call', 't1'],
      [4, 'prompt', 'next'],
    ]);
    expect(entries[2]).toMatchObject({ result: FULL, input: { file_path: 't1.ts' } });
    expect(entries[0]!.line).toBeUndefined();
  });

  it('finds where a large output was saved', () => {
    const rows = [assistant('', 't2'), result('t2', `Output too large. Full output saved to: ${SAVED}\n\nPreview`)];
    expect(entriesFromGroups([rows])[0]).toMatchObject({ kind: 'call', savedTo: SAVED });
  });
});
