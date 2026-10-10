import type { Message } from '../types.js';
import { RECALL_TOOL } from './recall.js';

/**
 * The recall archive: what each compaction is about to cut, saved first.
 *
 * Plugin hooks cannot read the session transcript itself (`$.fs.read` stops at
 * 4 MiB, and transcripts run to hundreds of MB), so the compaction hook saves
 * the rows it receives, with their full tool results, under
 * `<config>/fast-jev-compaction/recall/<session>/`. Each compaction adds one
 * group of chunk files, `<group>-<part>.json` (archiveRows says what a group
 * holds). `$.fs` cannot delete, so pruning empties old chunks.
 */

/** The `$.fs` calls the archive uses. */
export type ArchiveFs = {
  list: (path: string) => Promise<readonly { name: string; kind: string; size: number; mtimeMs: number }[]>;
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

/**
 * The parts of a row recall reads, cut so the row fits one chunk: its text,
 * each call's input and each result share the chunk evenly, with room for the
 * JSON around them (escaping counted, as the share is of the JSON form).
 */
function slim(row: Message): Message {
  const results = row.toolResults ?? [];
  const share = Math.floor((ARCHIVE_CHUNK_CHARS * 0.9) / (1 + row.toolUses.length + results.length));
  const cut = (text: string): string => {
    if (JSON.stringify(text).length <= share) return text;
    let head = text.slice(0, share);
    while (head && JSON.stringify(head).length > share) head = head.slice(0, Math.floor(head.length * 0.9));
    return head;
  };
  const input = (value: Record<string, unknown>): Record<string, unknown> => {
    const json = JSON.stringify(value);
    return json.length <= share ? value : { input_head: cut(json) };
  };
  return {
    role: row.role,
    text: cut(row.text),
    toolUses: row.toolUses.map(({ tool_use_id, tool, input: value }) => ({ tool_use_id, tool, input: input(value) })),
    ...(row.toolResults && {
      toolResults: results.map(({ tool_use_id, text, isError }) => ({ tool_use_id, text: cut(text), isError })),
    }),
  };
}

/**
 * Saves a compaction's rows as a new group. Prompts and replies are saved each
 * time (they are short, and recall needs them in order to tell a kept copy from
 * the same words said again); a call an earlier group holds is saved as its id
 * only, and its result not at all. Recall's own calls and results are left out:
 * they hold nothing new. Returns how many rows and chunk files were written.
 */
export async function archiveRows(fs: ArchiveFs, dir: string, rows: readonly Message[]): Promise<{ rows: number; files: number }> {
  const archived = (await loadArchive(fs, dir)).flat();
  const calls = new Set(archived.flatMap((r) => r.toolUses.map((u) => u.tool_use_id)));
  const results = new Set(archived.flatMap((r) => (r.toolResults ?? []).map((t) => t.tool_use_id)));
  const recall = new Set(rows.flatMap((r) => r.toolUses.filter((u) => u.tool === RECALL_TOOL).map((u) => u.tool_use_id)));
  const fresh = rows
    .map((row): Message => {
      const toolUses = row.toolUses
        .filter((u) => !recall.has(u.tool_use_id))
        .map((u) => (calls.has(u.tool_use_id) ? { ...u, input: {} } : u));
      const toolResults = (row.toolResults ?? []).filter((t) => !recall.has(t.tool_use_id) && !results.has(t.tool_use_id));
      return { role: row.role, text: row.text, toolUses, ...(toolResults.length > 0 && { toolResults }) };
    })
    .filter((row) => row.text || row.toolUses.length > 0 || row.toolResults)
    .map(slim);
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

/**
 * Empties the chunks of every session whose newest chunk is older than
 * `maxAgeMs`, except `keep` (the session starting, which may be a resumed one).
 */
export async function pruneArchives(
  fs: ArchiveFs,
  configDir: string,
  now: number,
  maxAgeMs: number,
  keep?: string,
): Promise<number> {
  const root = archiveRoot(configDir);
  let emptied = 0;
  for (const session of await listOrNone(fs, root)) {
    if (session.kind !== 'dir' || session.name === keep) continue;
    const dir = `${root}/${session.name}`;
    const chunks = (await listOrNone(fs, dir)).filter((e) => e.kind === 'file' && CHUNK.test(e.name));
    if (chunks.length === 0 || now - Math.max(...chunks.map((c) => c.mtimeMs)) <= maxAgeMs) continue;
    for (const chunk of chunks.filter((c) => c.size > 0)) {
      await fs.write(`${dir}/${chunk.name}`, '');
      emptied += 1;
    }
  }
  return emptied;
}
