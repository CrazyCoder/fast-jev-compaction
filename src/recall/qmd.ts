/**
 * A qmd index of past sessions, for the cross-session search when qmd is
 * installed. Each transcript is exported as markdown to
 * `<config>/fast-jev-compaction/sessions/<project>/<session>.md` (prompts,
 * replies, and each call with the head of its result), and indexed in a qmd
 * index of its own, `fast-jev-sessions`, apart from the user's default one.
 *
 * The first search starts building the index in the background and is
 * answered by the transcript scan; later searches export the sessions that
 * changed, update the index, and search it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projects, readSession, transcripts } from './files.ts';
import { dateOf, sessionLabel, sessionTitle, type IndexedHit, type SessionIndex } from './sessions.ts';
import type { Entry } from './transcript.ts';

export const QMD_INDEX = 'fast-jev-sessions';
const COLLECTION = 'sessions';
const TEXT_CHARS = 4_000;
const INPUT_CHARS = 500;
const RESULT_CHARS = 1_500;
const SEARCH_HITS = 100;
const QMD_TIMEOUT_MS = 120_000;
/** A build marked as running longer ago than this is taken as dead. */
const BUILD_STALE_MS = 3_600_000;

export const sessionsDir = (configDir: string) => join(configDir, 'fast-jev-compaction', 'sessions');

/**
 * How to run the installed qmd, or undefined when none is on the PATH. On
 * Windows npm installs a `qmd.cmd` shim, which Node cannot start without a
 * shell (and a shell would read the query's quotes and `&`): the shim's
 * script runs under the shim's own Node, the one qmd's native modules match.
 */
export function qmdCommand(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string[] | undefined {
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (platform !== 'win32') {
      if (existsSync(join(dir, 'qmd'))) return [join(dir, 'qmd')];
      continue;
    }
    if (existsSync(join(dir, 'qmd.exe'))) return [join(dir, 'qmd.exe')];
    const shim = join(dir, 'qmd.cmd');
    if (!existsSync(shim)) continue;
    const script = /"%dp0%\\([^"]+)"\s+%\*/.exec(readFileSync(shim, 'utf8'))?.[1];
    if (!script) continue;
    const node = join(dir, 'node.exe');
    return [existsSync(node) ? node : 'node', join(dir, script)];
  }
  return undefined;
}

const indent = (text: string) => text.replace(/^/gm, '    ');
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A session as markdown: its title, its label line, then one `## #N` heading per entry, bodies indented. */
export function sessionMarkdown(title: string, label: string, entries: readonly Entry[]): string {
  const blocks = entries.map((entry) => {
    if (entry.kind !== 'call') return `## #${entry.n} ${entry.kind}\n\n${indent(clip(entry.text, TEXT_CHARS))}`;
    const input = clip(JSON.stringify(entry.input), INPUT_CHARS);
    const result = entry.result === undefined ? '' : `\n\n${indent(clip(entry.result, RESULT_CHARS))}`;
    return `## #${entry.n} call ${entry.tool} (${entry.id})\n\n${indent(input)}${result}`;
  });
  return [`# ${title}`, '', label, '', ...blocks.flatMap((b) => [b, ''])].join('\n');
}

/** Writes the markdown of every session whose transcript changed since; returns how many. */
export async function exportSessions(configDir: string): Promise<number> {
  let written = 0;
  for (const project of projects(configDir)) {
    for (const file of transcripts(project.dir)) {
      const id = basename(file, '.jsonl');
      const md = join(sessionsDir(configDir), project.slug, `${id}.md`);
      const changed = statSync(file).mtimeMs;
      if (existsSync(md) && statSync(md).mtimeMs >= changed) continue;
      const { entries, meta } = await readSession(file);
      const name = meta.cwd ? basename(meta.cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/')) : project.slug;
      mkdirSync(join(sessionsDir(configDir), project.slug), { recursive: true });
      writeFileSync(md, sessionMarkdown(sessionTitle(meta), `${name} · ${dateOf(changed)} · ${id}`, entries));
      written += 1;
    }
  }
  return written;
}

type QmdResult = { file?: unknown; line?: unknown; snippet?: unknown };

/** The hits of qmd's JSON in the projects `slugs`, without the session `exclude`. */
export function indexedHits(configDir: string, json: string, slugs: ReadonlySet<string>, exclude: string): IndexedHit[] {
  let results: QmdResult[];
  try {
    results = JSON.parse(json) as QmdResult[];
  } catch {
    return [];
  }
  const hits: IndexedHit[] = [];
  for (const result of Array.isArray(results) ? results : []) {
    const where = /^qmd:\/\/[^/]+\/([^/]+)\/([\w-]+)\.md/.exec(String(result.file ?? ''));
    if (!where) continue;
    const [, slug, id] = where as unknown as [string, string, string];
    if (!slugs.has(slug) || id === exclude) continue;
    const md = join(sessionsDir(configDir), slug, `${id}.md`);
    if (!existsSync(md)) continue;
    const mdLines = readFileSync(md, 'utf8').split('\n');
    const title = (mdLines[0] ?? '').replace(/^# /, '');
    const [project = slug, date = '?'] = (mdLines[2] ?? '').split(' · ');
    const line = typeof result.line === 'number' ? result.line : 1;
    let heading = '';
    for (let i = Math.min(line, mdLines.length) - 1; i >= 0 && !heading; i--) {
      heading = /^## #\d+ (.+)$/.exec(mdLines[i]!)?.[1] ?? '';
    }
    const snippet = String(result.snippet ?? '')
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('@@'))
      .map((l) => `  ${l.trim()}`)
      .join('\n');
    hits.push({ sessionId: id, where: sessionLabel(project, date, title, id), heading, snippet });
  }
  return hits;
}

function runQmd(command: readonly string[], name: string, args: readonly string[]) {
  return spawnSync(command[0]!, [...command.slice(1), '--index', name, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: QMD_TIMEOUT_MS,
    windowsHide: true,
  });
}

const marker = (configDir: string, name: string) => join(sessionsDir(configDir), `.indexed-${name}`);
const building = (configDir: string, name: string) => join(sessionsDir(configDir), `.building-${name}`);

/** Exports every session and builds the index; marks it ready when qmd succeeds. */
export async function buildIndex(configDir: string, command: readonly string[], name: string): Promise<boolean> {
  mkdirSync(sessionsDir(configDir), { recursive: true });
  writeFileSync(building(configDir, name), String(Date.now()));
  await exportSessions(configDir);
  // A collection left from an earlier build may point elsewhere: add it afresh.
  runQmd(command, name, ['collection', 'remove', COLLECTION]);
  runQmd(command, name, ['collection', 'add', sessionsDir(configDir), '--name', COLLECTION]);
  const updated = runQmd(command, name, ['update']);
  if (updated.status !== 0) return false;
  writeFileSync(marker(configDir, name), new Date().toISOString());
  writeFileSync(building(configDir, name), '');
  return true;
}

/** Starts buildIndex in a process of its own that outlives this one, unless one is running. */
function buildInBackground(configDir: string, command: readonly string[], name: string): void {
  const lock = building(configDir, name);
  if (existsSync(lock)) {
    const since = Number(readFileSync(lock, 'utf8'));
    if (since && Date.now() - since < BUILD_STALE_MS) return;
  }
  mkdirSync(sessionsDir(configDir), { recursive: true });
  writeFileSync(lock, String(Date.now()));
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  spawn(process.execPath, [cli, '--build-index', configDir, name, ...command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

export type QmdIndexOptions = { command: readonly string[]; name?: string; background?: boolean };

/** The qmd session index as searchSessions takes it. */
export function qmdIndex(configDir: string, { command, name = QMD_INDEX, background = true }: QmdIndexOptions): SessionIndex {
  return async (query, slugs, exclude) => {
    if (!existsSync(marker(configDir, name))) {
      if (background) {
        buildInBackground(configDir, command, name);
        return undefined;
      }
      if (!(await buildIndex(configDir, command, name))) return undefined;
    } else if ((await exportSessions(configDir)) > 0) {
      runQmd(command, name, ['update']);
    }
    const found = runQmd(command, name, ['search', query, '-c', COLLECTION, '--format', 'json', '-n', String(SEARCH_HITS)]);
    if (found.status !== 0) return undefined;
    return indexedHits(configDir, found.stdout, slugs, exclude);
  };
}
