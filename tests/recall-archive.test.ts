import { describe, expect, it } from 'vitest';
import { callRow, resultRow, userRow } from './helpers/rows.js';
import { ARCHIVE_CHUNK_CHARS, archiveDir, archiveRows, loadArchive, pruneArchives } from '../src/recall/archive.js';
import { DAY, memoryFs } from './helpers/memory-fs.js';

const [user, call, result] = [userRow, (id: string) => callRow(id), resultRow];

describe('recall archive', () => {
  const dir = archiveDir('/cfg', 'sess-1');

  it('lives under the config dir, by session', () => {
    expect(dir).toBe('/cfg/fast-jev-compaction/recall/sess-1');
  });

  it('writes one group per compaction; a call archived before is kept only as its id', async () => {
    const { fs } = memoryFs();
    await archiveRows(fs, dir, [user('go'), callRow('t1', '', { file_path: 'a.ts' }), result('t1', 'full one')]);
    // The next compaction sees the kept copies again, cut, plus new rows.
    await archiveRows(fs, dir, [
      user('go'),
      callRow('t1', '', { file_path: 'a.ts' }),
      result('t1', 'cut'),
      user('next'),
      call('t2'),
      result('t2', 'two'),
    ]);
    const groups = await loadArchive(fs, dir);
    const shape = (r: (typeof groups)[0][0]) => r.text || r.toolResults?.[0]?.text || r.toolUses[0]?.tool_use_id;
    expect(groups.map((g) => g.map(shape))).toEqual([
      ['go', 't1', 'full one'],
      ['go', 't1', 'next', 't2', 'two'],
    ]);
    expect(groups[1]![1]!.toolUses[0]!.input).toEqual({});
  });

  it('never archives the recall tool\'s own calls', async () => {
    const { fs } = memoryFs();
    const recall = { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'r1', tool: 'mcp__fast-jev-compaction__recall', input: { query: 'x' } }] };
    await archiveRows(fs, dir, [user('go'), recall, result('r1', 'a 48k recall answer')]);
    expect((await loadArchive(fs, dir)).flat().map((r) => r.text)).toEqual(['go']);
  });

  it('splits a large compaction into chunks under the read limit', async () => {
    const { fs, files } = memoryFs();
    const big = 'x'.repeat(ARCHIVE_CHUNK_CHARS / 3);
    const rows = Array.from({ length: 8 }, (_, i) => [call(`t${i}`), result(`t${i}`, big)]).flat();
    await archiveRows(fs, dir, rows);
    const chunks = [...files.keys()].filter((k) => k.startsWith(dir));
    expect(chunks.length).toBeGreaterThan(2);
    for (const k of chunks) expect(files.get(k)!.text.length).toBeLessThanOrEqual(ARCHIVE_CHUNK_CHARS + big.length + 1_000);
    const groups = await loadArchive(fs, dir);
    expect(groups.flat()).toHaveLength(16);
  });

  it('keeps every chunk under the limit even for one row with many large parts', async () => {
    const { fs, files } = memoryFs();
    const big = 'é'.repeat(ARCHIVE_CHUNK_CHARS);
    const row = {
      role: 'user' as const,
      text: big,
      toolUses: [{ tool_use_id: 'w', tool: 'Write', input: { content: big } }],
      toolResults: [1, 2, 3].map((i) => ({ tool_use_id: `r${i}`, text: big, isError: false })),
    };
    await archiveRows(fs, dir, [row]);
    for (const [, file] of files) expect(file.text.length).toBeLessThanOrEqual(ARCHIVE_CHUNK_CHARS);
    const [stored] = (await loadArchive(fs, dir)).flat();
    expect(stored!.toolResults).toHaveLength(3);
    expect(stored!.toolResults![0]!.text.length).toBeGreaterThan(100_000);
  });

  it('reads nothing when there is no archive', async () => {
    expect(await loadArchive(memoryFs().fs, dir)).toEqual([]);
  });

  it('empties the chunks of sessions untouched for longer than the age limit', async () => {
    let now = 0;
    const { fs, files } = memoryFs(() => now);
    await archiveRows(fs, archiveDir('/cfg', 'old'), [user('old prompt')]);
    now = 40 * DAY;
    await archiveRows(fs, archiveDir('/cfg', 'new'), [user('new prompt')]);
    await pruneArchives(fs, '/cfg', now, 30 * DAY);
    const texts = [...files].map(([k, f]) => [k.includes('/old/') ? 'old' : 'new', f.text.length > 0]);
    expect(texts).toEqual([
      ['old', false],
      ['new', true],
    ]);
    expect(await loadArchive(fs, archiveDir('/cfg', 'old'))).toEqual([]);
  });

  it('never empties the archive of the session being resumed', async () => {
    let now = 0;
    const { fs } = memoryFs(() => now);
    await archiveRows(fs, archiveDir('/cfg', 'old'), [user('old prompt')]);
    now = 40 * DAY;
    await pruneArchives(fs, '/cfg', now, 30 * DAY, 'old');
    expect((await loadArchive(fs, archiveDir('/cfg', 'old'))).flat()).toHaveLength(1);
  });
});
