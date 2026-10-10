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

  it('writes rows as chunks and reads them back in order, as one group per compaction', async () => {
    const { fs } = memoryFs();
    await archiveRows(fs, dir, [user('go'), call('t1'), result('t1', 'full one')]);
    // The next compaction sees the kept copies again, cut, plus new rows.
    await archiveRows(fs, dir, [user('go'), call('t1'), result('t1', 'cut'), user('next'), call('t2'), result('t2', 'two')]);
    const groups = await loadArchive(fs, dir);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.map((r) => r.text || r.toolResults?.[0]?.text || r.toolUses[0]?.tool_use_id)).toEqual(['go', 't1', 'full one']);
    expect(groups[1]!.map((r) => r.text || r.toolResults?.[0]?.text || r.toolUses[0]?.tool_use_id)).toEqual(['next', 't2', 'two']);
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
});
