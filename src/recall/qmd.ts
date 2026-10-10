/**
 * A qmd index of past sessions, for the cross-session search when qmd is
 * installed. Each transcript of the projects the index covers (all, unless
 * `/recall-index` chose some) is exported as markdown to
 * `<config>/fast-jev-compaction/sessions/<project>/<session>.md` (prompts,
 * replies, and each call with the head of its result), and indexed in a qmd
 * index of its own, `fast-jev-sessions`, apart from the user's default one.
 *
 * The first search starts building the index in the background and is
 * answered by the transcript scan; later searches export the sessions that
 * changed, update the index, and search it. `/recall-index` builds it on
 * demand (index-command.ts).
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, join } from 'node:path';
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

/**
 * Writes the markdown of every session in the `scope` projects whose
 * transcript changed since, but the session `exclude` (the current one, which
 * changes on every call), and deletes the markdown of transcripts Claude Code
 * has deleted and of projects outside the scope. Exports are readable by
 * their owner only. Returns how many changed.
 */
export async function exportSessions(configDir: string, exclude?: string, scope: IndexScope = 'all'): Promise<number> {
  let changedCount = 0;
  const root = sessionsDir(configDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const live = new Set<string>();
  const covered = projects(configDir).filter((p) => scope === 'all' || scope.includes(p.slug));
  for (const project of covered) {
    for (const file of transcripts(project.dir)) {
      const id = basename(file, '.jsonl');
      const md = join(root, project.slug, `${id}.md`);
      live.add(md);
      if (id === exclude) continue;
      try {
        const changed = statSync(file).mtimeMs;
        if (existsSync(md) && statSync(md).mtimeMs >= changed) continue;
        const { entries, meta } = await readSession(file);
        const name = meta.cwd ? basename(meta.cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/')) : project.slug;
        mkdirSync(join(root, project.slug), { recursive: true, mode: 0o700 });
        writeFileSync(md, sessionMarkdown(sessionTitle(meta), `${name} · ${dateOf(changed)} · ${id}`, entries), { mode: 0o600 });
        changedCount += 1;
      } catch {
        // A transcript deleted or unreadable mid-export is left out this time.
      }
    }
  }
  for (const slug of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const name of readdirSync(join(root, slug.name)).filter((n) => n.endsWith('.md'))) {
      const md = join(root, slug.name, name);
      if (live.has(md)) continue;
      try {
        rmSync(md, { force: true });
        changedCount += 1;
      } catch {
        // Held open (qmd, on Windows): removed on a later export.
      }
    }
    try {
      if (readdirSync(join(root, slug.name)).length === 0) rmSync(join(root, slug.name), { recursive: true });
    } catch {
      // Removed on a later export.
    }
  }
  return changedCount;
}

/** The projects an index covers: all of them, or these project folders. */
export type IndexScope = 'all' | string[];

const scopeFile = (configDir: string, name: string) => join(sessionsDir(configDir), `.scope-${name}.json`);

/** The projects the index `name` covers; all when none were chosen. */
export function readScope(configDir: string, name: string): IndexScope {
  try {
    const projects = (JSON.parse(readFileSync(scopeFile(configDir, name), 'utf8')) as { projects?: unknown }).projects;
    if (Array.isArray(projects)) return projects.filter((p): p is string => typeof p === 'string');
  } catch {
    // No choice made: all projects.
  }
  return 'all';
}

/** Whether the projects the index `name` covers were chosen, rather than all by default. */
export const hasScope = (configDir: string, name: string) => existsSync(scopeFile(configDir, name));

export function writeScope(configDir: string, name: string, scope: IndexScope): void {
  mkdirSync(sessionsDir(configDir), { recursive: true, mode: 0o700 });
  writeFileSync(scopeFile(configDir, name), JSON.stringify({ projects: scope }), { mode: 0o600 });
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

type Env = NodeJS.ProcessEnv;

function runQmd(command: readonly string[], name: string, args: readonly string[], env: Env) {
  return spawnSync(command[0]!, [...command.slice(1), '--index', name, ...args], {
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: QMD_TIMEOUT_MS,
    windowsHide: true,
  });
}

const marker = (configDir: string, name: string) => join(sessionsDir(configDir), `.indexed-${name}`);
const building = (configDir: string, name: string) => join(sessionsDir(configDir), `.building-${name}`);

/** The index file qmd keeps for `name`, under XDG_CACHE_HOME or ~/.cache. */
export function indexFile(name: string, env: Env = process.env): string {
  const cache = env['XDG_CACHE_HOME'] || join(env['HOME'] || env['USERPROFILE'] || homedir(), '.cache');
  return join(cache, 'qmd', `${name}.sqlite`);
}

/** Makes the exports, their folders and the index file readable by their owner only, whenever they were written. */
function restrict(configDir: string, name: string, env: Env): void {
  const root = sessionsDir(configDir);
  const paths = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    paths.push(dir, ...readdirSync(dir).map((file) => join(dir, file)));
  }
  for (const path of [...paths, indexFile(name, env)]) {
    try {
      chmodSync(path, statSync(path).isDirectory() ? 0o700 : 0o600);
    } catch {
      // Gone, or not ours to change.
    }
  }
}

/** Where qmd keeps the collections of the index `name`, under XDG_CONFIG_HOME or ~/.config. */
function indexConfigFile(name: string, env: Env): string {
  const config = env['XDG_CONFIG_HOME'] || join(env['HOME'] || env['USERPROFILE'] || homedir(), '.config');
  return join(config, 'qmd', `${name}.yml`);
}

/** When the index `name` was last built, if it is ready. */
export function builtAt(configDir: string, name: string): Date | undefined {
  try {
    return statSync(marker(configDir, name)).mtime;
  } catch {
    return undefined;
  }
}

/** Deletes the exports, the index `name` and its qmd collection config. */
export function removeIndex(configDir: string, name: string, env: Env = process.env): void {
  rmSync(sessionsDir(configDir), { recursive: true, force: true });
  rmSync(indexFile(name, env), { force: true });
  rmSync(indexConfigFile(name, env), { force: true });
}

/** Exports the sessions of the projects the index covers and builds it; marks it ready when qmd succeeds. */
export async function buildIndex(configDir: string, command: readonly string[], name: string, env: Env = process.env): Promise<boolean> {
  await exportSessions(configDir, undefined, readScope(configDir, name));
  // A collection left from an earlier build may point elsewhere: add it afresh.
  runQmd(command, name, ['collection', 'remove', COLLECTION], env);
  runQmd(command, name, ['collection', 'add', sessionsDir(configDir), '--name', COLLECTION], env);
  const updated = runQmd(command, name, ['update'], env);
  restrict(configDir, name, env);
  if (updated.status !== 0) return false;
  writeFileSync(marker(configDir, name), new Date().toISOString());
  rmSync(building(configDir, name), { force: true });
  return true;
}

/** Takes the build lock of the index `name`, unless a build holds it. */
export function lockBuild(configDir: string, name: string): boolean {
  mkdirSync(sessionsDir(configDir), { recursive: true, mode: 0o700 });
  return takeBuildLock(building(configDir, name));
}

export const unlockBuild = (configDir: string, name: string) => rmSync(building(configDir, name), { force: true });

/** Takes the build lock, unless a build that is not stale holds it or has just let it go. */
function takeBuildLock(lock: string): boolean {
  try {
    writeFileSync(lock, String(Date.now()), { flag: 'wx' });
    return true;
  } catch {
    let since = 0;
    try {
      since = Number(readFileSync(lock, 'utf8'));
    } catch {
      return false;
    }
    if (since && Date.now() - since < BUILD_STALE_MS) return false;
    writeFileSync(lock, String(Date.now()));
    return true;
  }
}

/** Starts buildIndex in a process of its own that outlives this one, unless one is running. */
function buildInBackground(configDir: string, command: readonly string[], name: string): void {
  mkdirSync(sessionsDir(configDir), { recursive: true, mode: 0o700 });
  if (!takeBuildLock(building(configDir, name))) return;
  // cli.ts beside this file when run from source, cli.js in the built library.
  const self = fileURLToPath(import.meta.url);
  const cli = join(dirname(self), `cli${extname(self)}`);
  spawn(process.execPath, [cli, '--build-index', configDir, name, ...command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

export type QmdIndexOptions = { command: readonly string[]; name?: string; background?: boolean; env?: Env };

/**
 * The qmd session index as searchSessions takes it. It answers only with hits
 * in the asked projects; otherwise (no such hit, output that is not JSON, a
 * failed search) the scan answers. A failed search marks the index for a
 * rebuild only when its file is gone: a timeout or a busy database passes.
 */
export function qmdIndex(configDir: string, { command, name = QMD_INDEX, background = true, env = process.env }: QmdIndexOptions): SessionIndex {
  return async (query, slugs, exclude) => {
    if (!existsSync(marker(configDir, name))) {
      if (background) {
        buildInBackground(configDir, command, name);
        return undefined;
      }
      if (!(await buildIndex(configDir, command, name, env))) return undefined;
    } else if ((await exportSessions(configDir, exclude, readScope(configDir, name))) > 0) {
      runQmd(command, name, ['update'], env);
    }
    const found = runQmd(command, name, ['search', '-c', COLLECTION, '--format', 'json', '-n', String(SEARCH_HITS), '--', query], env);
    if (found.status !== 0) {
      if (!existsSync(indexFile(name, env))) rmSync(marker(configDir, name), { force: true });
      return undefined;
    }
    const hits = indexedHits(configDir, found.stdout, slugs, exclude);
    return hits.length > 0 ? hits : undefined;
  };
}
