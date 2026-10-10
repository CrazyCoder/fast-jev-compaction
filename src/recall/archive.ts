import type { Message } from '../types.js';

/**
 * The recall archive: what each compaction is about to cut, saved first.
 *
 * Plugin hooks cannot read the session transcript itself (`$.fs.read` stops at
 * 4 MiB, and transcripts run to hundreds of MB), so the compaction hook saves
 * the rows it receives, with their full tool results, under
 * `<config>/fast-jev-compaction/recall/<session>/`. Each compaction adds one
 * group of chunk files, `<group>-<part>.json`, holding only rows no earlier
 * group has. `$.fs` cannot delete, so pruning empties old chunks.
 */

/** The `$.fs` calls the archive uses. */
export type ArchiveFs = {
  list: (path: string) => Promise<readonly { name: string; kind: string; mtimeMs: number }[]>;
  read: (path: string) => Promise<string>;
  write: (path: string, text: string) => Promise<void>;
};

/**
 * The most characters one chunk holds: at most 3 bytes each in UTF-8, so a
 * chunk stays under `$.fs.read`'s 4 MiB.
 */
export const ARCHIVE_CHUNK_CHARS = 1_300_000;

const CHUNK = /^(\d{6})-(\d{3})\.json$/;

export function archiveRoot(configDir: string): string {
  return `${configDir.replace(/[\\/]+$/, '')}/fast-jev-compaction/recall`;
}

export function archiveDir(configDir: string, sessionId: string): string {
  return `${archiveRoot(configDir)}/${sessionId}`;
}

async function listOrNone(fs: ArchiveFs, path: string) {
  try {
    return await fs.list(path);
  } catch {
    return [];
  }
}

/** The archive's groups, oldest first; an emptied or unreadable chunk is skipped. */
export async function loadArchive(fs: ArchiveFs, dir: string): Promise<Message[][]> {
  const names = (await listOrNone(fs, dir))
    .filter((e) => e.kind === 'file' && CHUNK.test(e.name))
    .map((e) => e.name)
    .sort();
  const groups = new Map<string, Message[]>();
  for (const name of names) {
    let rows: Message[];
    try {
      const text = await fs.read(`${dir}/${name}`);
      if (!text) continue;
      rows = JSON.parse(text) as Message[];
    } catch {
      continue;
    }
    const group = CHUNK.exec(name)![1]!;
    groups.set(group, [...(groups.get(group) ?? []), ...rows]);
  }
  return [...groups.values()];
}

/** The parts of a row recall reads, each text cut to fit one chunk. */
function slim(row: Message): Message {
  const cut = (text: string) => (text.length <= ARCHIVE_CHUNK_CHARS / 2 ? text : text.slice(0, ARCHIVE_CHUNK_CHARS / 2));
  return {
    role: row.role,
    text: cut(row.text),
    toolUses: row.toolUses.map(({ tool_use_id, tool, input }) => ({ tool_use_id, tool, input })),
    ...(row.toolResults && {
      toolResults: row.toolResults.map(({ tool_use_id, text, isError }) => ({ tool_use_id, text: cut(text), isError })),
    }),
  };
}

/** What a row adds: the keys of its calls, results and text. */
function keysOf(row: Message): string[] {
  return [
    ...row.toolUses.map((u) => `call\u0000${u.tool_use_id}`),
    ...(row.toolResults ?? []).map((r) => `result\u0000${r.tool_use_id}`),
    ...(row.text ? [`${row.role}\u0000${row.text}`] : []),
  ];
}

/**
 * Saves the rows no earlier group has as a new group. Returns how many rows
 * and chunk files were written.
 */
export async function archiveRows(fs: ArchiveFs, dir: string, rows: readonly Message[]): Promise<{ rows: number; files: number }> {
  const groups = await loadArchive(fs, dir);
  const seen = new Set(groups.flat().flatMap(keysOf));
  const fresh = rows.filter((row) => keysOf(row).some((key) => !seen.has(key))).map(slim);
  if (fresh.length === 0) return { rows: 0, files: 0 };

  const chunks: Message[][] = [[]];
  let size = 0;
  for (const row of fresh) {
    const length = JSON.stringify(row).length;
    if (size + length > ARCHIVE_CHUNK_CHARS && chunks.at(-1)!.length > 0) {
      chunks.push([]);
      size = 0;
    }
    chunks.at(-1)!.push(row);
    size += length;
  }
  const names = (await listOrNone(fs, dir)).map((e) => CHUNK.exec(e.name)?.[1]).filter((g): g is string => !!g);
  const group = String(Math.max(0, ...names.map(Number)) + 1).padStart(6, '0');
  for (const [part, chunk] of chunks.entries()) {
    await fs.write(`${dir}/${group}-${String(part + 1).padStart(3, '0')}.json`, JSON.stringify(chunk));
  }
  return { rows: fresh.length, files: chunks.length };
}

/** Empties the chunks of every session whose newest chunk is older than `maxAgeMs`. */
export async function pruneArchives(fs: ArchiveFs, configDir: string, now: number, maxAgeMs: number): Promise<number> {
  const root = archiveRoot(configDir);
  let emptied = 0;
  for (const session of await listOrNone(fs, root)) {
    if (session.kind !== 'dir') continue;
    const dir = `${root}/${session.name}`;
    const chunks = (await listOrNone(fs, dir)).filter((e) => e.kind === 'file' && CHUNK.test(e.name));
    if (chunks.length === 0 || now - Math.max(...chunks.map((c) => c.mtimeMs)) <= maxAgeMs) continue;
    for (const chunk of chunks) {
      if ((await fs.read(`${dir}/${chunk.name}`).catch(() => '')) === '') continue;
      await fs.write(`${dir}/${chunk.name}`, '');
      emptied += 1;
    }
  }
  return emptied;
}
