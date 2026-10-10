/**
 * Recall across sessions: a keyword search over the transcripts of other
 * sessions, of this project or any other, and finding a session by its id to
 * run a request on it. Projects are the folders under `<config>/projects/`,
 * one per working directory.
 *
 * Only lines that hold a keyword are parsed: ripgrep picks the transcripts
 * that hold one when it is installed (a fraction of a second over gigabytes),
 * and each candidate is then read line by line.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { keywords, runQuery } from './recall.ts';
import { transcriptReader, type Entry } from './transcript.ts';

const TITLE_CHARS = 60;

type Project = { dir: string; slug: string; cwd?: string };

function projects(configDir: string): Project[] {
  const root = join(configDir, 'projects');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ dir: join(root, d.name), slug: d.name }));
}

function transcripts(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name));
}

/** The working directory a project's newest transcript names first. */
async function projectCwd(project: Project): Promise<string | undefined> {
  const newest = transcripts(project.dir).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!newest) return undefined;
  const lines = createInterface({ input: createReadStream(newest, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"cwd"')) continue;
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
      if (typeof cwd === 'string') {
        lines.close();
        return cwd;
      }
    } catch {
      // A line that is not JSON names nothing.
    }
  }
  return undefined;
}

const nameOf = (project: Project) => (project.cwd ? basename(project.cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/')) : project.slug);

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

type SessionHits = { entries: Entry[]; seen: Set<string>; title?: string; firstPrompt?: string };

/** The entries of one transcript's lines that hold any term, with the terms seen and the session's title. */
async function scan(file: string, terms: readonly string[]): Promise<SessionHits> {
  const reader = transcriptReader({ orphanResults: true });
  const lower = terms.map((t) => t.toLowerCase());
  const found: SessionHits = { entries: reader.entries, seen: new Set() };
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.includes('"compact_boundary"')) {
      reader.line(line);
      continue;
    }
    if (line.includes('"custom-title"')) {
      try {
        const title = (JSON.parse(line) as { customTitle?: unknown }).customTitle;
        if (typeof title === 'string' && title.trim()) found.title = title.trim();
      } catch {
        // Not a title row after all.
      }
    }
    if (found.firstPrompt === undefined && line.includes('"type":"user"')) {
      try {
        const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
        if (typeof content === 'string' && content.trim()) found.firstPrompt = content.trim();
      } catch {
        // A line that is not JSON names nothing.
      }
    }
    const text = line.toLowerCase();
    const hits = lower.filter((t) => text.includes(t));
    if (hits.length === 0) continue;
    for (const t of hits) found.seen.add(t);
    reader.line(line);
  }
  return found;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

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
  rg = 'rg',
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
  for (const p of picked) if (!p.cwd) {
    const cwd = await projectCwd(p);
    if (cwd) p.cwd = cwd;
  }
  const terms = keywords(query);
  const current = currentFile.replace(/\\/g, '/').toLowerCase();
  const files = candidateFiles(
    picked.map((p) => p.dir),
    terms,
    rg,
  ).filter((f) => f.replace(/\\/g, '/').toLowerCase() !== current);
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
    const title = hits.title ?? oneLine(hits.firstPrompt ?? 'untitled', TITLE_CHARS);
    const date = new Date(statSync(file).mtimeMs).toISOString().slice(0, 10);
    const where = `${owner ? nameOf(owner) : '?'} · ${date} · "${oneLine(title, TITLE_CHARS)}" · ${basename(file, '.jsonl')}`;
    for (const entry of hits.entries) entries.push({ ...entry, n: entries.length + 1, where });
  }
  const sessionsIn = (hits: readonly Entry[]) => new Set(hits.map((h) => h.where)).size;
  return runQuery(entries, query, page, {
    scope: (hits) => `in ${sessionsIn(hits)} session(s) ${scope}`,
    footer: 'Open one with session: "<id>" and query, expand, range or touched.',
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
