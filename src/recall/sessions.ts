/**
 * Recall across sessions: a keyword search over the transcripts of other
 * sessions, of this project or any other, and finding a session by its id to
 * run a request on it.
 *
 * A session index (qmd, see qmd.ts) answers when it is ready. Otherwise the
 * transcripts are scanned: ripgrep picks those that hold the keywords when it
 * is installed (a fraction of a second over gigabytes), and only their
 * matching lines are parsed.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { keywords, runQuery } from './recall.ts';
import {
  lines,
  noteMeta,
  oneLine,
  projectCwd,
  projectName,
  projects,
  transcripts,
  type Project,
  type SessionMeta,
} from './files.ts';
import { transcriptReader, type Entry } from './transcript.ts';

const TITLE_CHARS = 60;
const PAGE = 5;
const FOOTER = 'Open one with session: "<id>" and query, expand, range or touched.';

/** A hit a session index found: where it is and the lines around it. */
export type IndexedHit = { sessionId: string; where: string; heading: string; snippet: string };

/** A ready index answers with hits in the sessions of `slugs`; undefined while it is not ready. */
export type SessionIndex = (query: string, slugs: ReadonlySet<string>, exclude: string) => IndexedHit[] | undefined;

/** The label of a session's hits: project, date, title and id. */
export function sessionLabel(project: string, mtimeMs: number, meta: SessionMeta, id: string): string {
  const title = meta.title ?? oneLine(meta.firstPrompt ?? 'untitled', TITLE_CHARS);
  const date = new Date(mtimeMs).toISOString().slice(0, 10);
  return `${project} · ${date} · "${oneLine(title, TITLE_CHARS)}" · ${id}`;
}

/** The transcripts in `dirs` that ripgrep finds `term` in; undefined when ripgrep does not run. */
function filesWith(rg: string, dirs: readonly string[], term: string): string[] | undefined {
  const run = spawnSync(rg, ['-l', '-i', '-F', '--max-depth', '1', '-g', '*.jsonl', '-e', term, '--', ...dirs], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error || (run.status !== 0 && run.status !== 1)) return undefined;
  return run.stdout.split(/\r?\n/).filter(Boolean);
}

/**
 * The transcripts in `dirs` that hold every one of `terms` (case-insensitive),
 * or any of them when none holds all. ripgrep (`rg`) picks them when it runs;
 * otherwise every transcript is a candidate and the line scan decides.
 */
export function candidateFiles(dirs: readonly string[], terms: readonly string[], rg = 'rg'): string[] {
  if (dirs.length === 0) return [];
  const lists: string[][] = [];
  for (const term of terms) {
    const files = filesWith(rg, dirs, term);
    if (!files) return dirs.flatMap(transcripts);
    lists.push(files);
  }
  const every = lists.reduce((kept, files) => kept.filter((f) => files.includes(f)));
  return every.length > 0 ? every : [...new Set(lists.flat())];
}

type SessionHits = { entries: Entry[]; seen: Set<string>; meta: SessionMeta };

/** The entries of one transcript's lines that hold any term, with the terms seen and the session's meta. */
async function scan(file: string, terms: readonly string[]): Promise<SessionHits> {
  const reader = transcriptReader({ orphanResults: true });
  const lower = terms.map((t) => t.toLowerCase());
  const found: SessionHits = { entries: reader.entries, seen: new Set(), meta: {} };
  for await (const line of lines(file)) {
    if (line.includes('"compact_boundary"')) {
      reader.line(line);
      continue;
    }
    noteMeta(line, found.meta);
    const text = line.toLowerCase();
    const hits = lower.filter((t) => text.includes(t));
    if (hits.length === 0) continue;
    for (const t of hits) found.seen.add(t);
    reader.line(line);
  }
  return found;
}

/** Ranked hits a session index found, a page at a time. */
function indexedAnswer(hits: readonly IndexedHit[], query: string, page: number, scope: string): string {
  const echo = oneLine(query, 100);
  if (hits.length === 0) return `No match for "${echo}" in the other sessions ${scope}.`;
  const pages = Math.ceil(hits.length / PAGE);
  const current = Math.min(Math.max(1, Math.floor(page)), pages);
  const shown = hits.slice((current - 1) * PAGE, current * PAGE);
  const sessions = new Set(hits.map((h) => h.sessionId)).size;
  const next = current < pages ? ` Next: page: ${current + 1}.` : '';
  return [
    `${hits.length} match(es) in ${sessions} session(s) ${scope} for "${echo}" (session index), page ${current}/${pages}:`,
    ...shown.map((h, i) => `#${(current - 1) * PAGE + i + 1} [${h.where}] ${h.heading}\n${h.snippet}`),
    `${FOOTER}${next}`,
  ].join('\n\n');
}

export type SearchOptions = { rg?: string; index?: SessionIndex };

/**
 * Ranked hits for `query` in other sessions: of the project holding
 * `currentFile` by default, of the projects whose folder or working directory
 * holds `project`, or of all projects for `project: "all"`.
 */
export async function searchSessions(
  configDir: string,
  currentFile: string,
  query: string,
  project: string | undefined,
  page: number,
  { rg = 'rg', index }: SearchOptions = {},
): Promise<string> {
  const all = projects(configDir);
  const part = project?.trim().toLowerCase();
  let picked: Project[];
  let scope: string;
  if (!part) {
    picked = all.filter((p) => p.dir === join(currentFile, '..'));
    scope = 'of this project';
  } else if (part === 'all') {
    picked = all;
    scope = 'of all projects';
  } else {
    for (const p of all) {
      const cwd = await projectCwd(p);
      if (cwd) p.cwd = cwd;
    }
    picked = all.filter((p) => `${p.slug} ${p.cwd ?? ''}`.toLowerCase().includes(part));
    scope = `of projects matching "${oneLine(project!, 60)}"`;
    if (picked.length === 0) return `No project matches "${oneLine(project!, 60)}".`;
  }
  const exclude = basename(currentFile, '.jsonl');
  const indexed = index?.(query, new Set(picked.map((p) => p.slug)), exclude);
  if (indexed) return indexedAnswer(indexed, query, page, scope);

  for (const p of picked) {
    if (p.cwd) continue;
    const cwd = await projectCwd(p);
    if (cwd) p.cwd = cwd;
  }
  const terms = keywords(query);
  const files = candidateFiles(
    picked.map((p) => p.dir),
    terms,
    rg,
  ).filter((f) => basename(f, '.jsonl') !== exclude);
  const scanned: { file: string; hits: SessionHits }[] = [];
  for (const file of files) {
    const hits = await scan(file, terms);
    if (hits.entries.length > 0) scanned.push({ file, hits });
  }
  // The sessions that hold every keyword, or those holding any when none does.
  const complete = scanned.filter((s) => s.hits.seen.size === terms.length);
  const entries: Entry[] = [];
  for (const { file, hits } of complete.length > 0 ? complete : scanned) {
    const owner = picked.find((p) => file.startsWith(p.dir));
    const where = sessionLabel(owner ? projectName(owner) : '?', statSync(file).mtimeMs, hits.meta, basename(file, '.jsonl'));
    for (const entry of hits.entries) entries.push({ ...entry, n: entries.length + 1, where });
  }
  const sessionsIn = (hits: readonly Entry[]) => new Set(hits.map((h) => h.where)).size;
  return runQuery(entries, query, page, {
    scope: (hits) => `in ${sessionsIn(hits)} session(s) ${scope}`,
    footer: FOOTER,
    none: (echo) => `No match for "${echo}" in the other sessions ${scope}.`,
  });
}

/** The transcript of the session whose id starts with `id` (8 characters at least), in any project. */
export function findSession(configDir: string, id: string): string | undefined {
  if (!/^[\w-]{8,}$/.test(id)) return undefined;
  for (const project of projects(configDir)) {
    const match = readdirSync(project.dir).find((name) => name.endsWith('.jsonl') && name.startsWith(id));
    if (match) return join(project.dir, match);
  }
  return undefined;
}
