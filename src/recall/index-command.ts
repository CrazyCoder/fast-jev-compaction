/**
 * `/recall-index`: shows, builds or removes the qmd index that recall searches
 * past sessions with. Projects are named by a part of their name, by a path
 * (`~`, any slash style or case, a folder taking every project under it), by
 * `.` for the current one, or `all`.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { projectCwd, projectName, projects, type Project } from './files.ts';
import {
  builtAt,
  buildIndex,
  hasScope,
  indexFile,
  lockBuild,
  QMD_INDEX,
  readScope,
  removeIndex,
  sessionsDir,
  unlockBuild,
  writeScope,
  type IndexScope,
} from './qmd.ts';

const USAGE =
  'Usage: /recall-index [status] | all | <project name or path>… | remove [<project name or path>…]. ' +
  'Names and paths can be separated by spaces or commas; quote a path with spaces; "." is this project.';
const INSTALL = 'qmd is not installed, so recall searches past sessions by scanning their transcripts. To index them, install it with `npm install -g @tobilu/qmd`, then run /recall-index again.';

export type IndexArgs = { action: 'status' | 'build' | 'remove'; targets: string[] };

/** Splits the command's arguments: words and quoted paths, separated by spaces or commas. */
export function parseIndexArgs(args: string): IndexArgs {
  const tokens = [...args.matchAll(/"([^"]*)"|'([^']*)'|([^\s,]+)/g)]
    .map((m) => (m[1] ?? m[2] ?? m[3] ?? '').trim())
    .filter(Boolean);
  const first = tokens[0]?.toLowerCase();
  if (!first || first === 'status') return { action: 'status', targets: [] };
  if (first === 'remove' || first === 'delete') return { action: 'remove', targets: tokens.slice(1) };
  return { action: 'build', targets: tokens };
}

const looksLikePath = (target: string) =>
  target === '.' || target === '..' || target.startsWith('~') || /[\\/]/.test(target) || /^[a-z]:/i.test(target);
const normal = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * The projects each target names: "." the current one; a path the project
 * there and every project under it; anything else the projects whose folder
 * or name contains it. Targets that name none are listed in `unmatched`.
 */
export function matchProjects(
  all: readonly Project[],
  targets: readonly string[],
  currentSlug: string | undefined,
  home = homedir(),
): { matched: Project[]; unmatched: string[] } {
  const picked = new Set<Project>();
  const unmatched: string[] = [];
  const current = all.find((p) => p.slug === currentSlug);
  for (const target of targets) {
    let found: Project[];
    if (target === '.') {
      found = current ? [current] : [];
    } else if (looksLikePath(target)) {
      let path = target.startsWith('~') ? join(home, target.slice(1)) : target;
      if (!isAbsolute(path) && !/^[a-z]:/i.test(path) && current?.cwd) path = resolve(current.cwd, path);
      const wanted = normal(path);
      found = all.filter((p) => p.cwd && (normal(p.cwd) === wanted || normal(p.cwd).startsWith(`${wanted}/`)));
    } else {
      const part = target.toLowerCase();
      found = all.filter((p) => p.slug.toLowerCase().includes(part) || projectName(p).toLowerCase().includes(part));
    }
    if (found.length === 0) unmatched.push(target);
    for (const project of found) picked.add(project);
  }
  return { matched: all.filter((p) => picked.has(p)), unmatched };
}

export type IndexCommandInput = {
  configDir: string;
  sessionId: string;
  args: string;
  /** How to run qmd; undefined when it is not installed. */
  command: readonly string[] | undefined;
  name?: string;
  env?: NodeJS.ProcessEnv;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const names = (list: readonly Project[]) => list.map(projectName).sort((a, b) => a.localeCompare(b)).join(', ');

function size(path: string): string {
  try {
    const bytes = statSync(path).size;
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  } catch {
    return 'none';
  }
}

/** Sessions exported per covered project. */
function exportedSessions(configDir: string): number {
  const root = sessionsDir(configDir);
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (dir.isDirectory()) count += readdirSync(join(root, dir.name)).filter((n) => n.endsWith('.md')).length;
  }
  return count;
}

function covers(scope: IndexScope, all: readonly Project[]): string {
  if (scope === 'all') return 'Covers all projects.';
  const list = all.filter((p) => scope.includes(p.slug));
  return `Covers ${plural(list.length, 'project')}: ${names(list)}.`;
}

/** Runs `/recall-index <args>` and answers with what it did or found. */
export async function runIndexCommand({ configDir, sessionId, args, command, name = QMD_INDEX, env = process.env }: IndexCommandInput): Promise<string> {
  const { action, targets } = parseIndexArgs(args);
  const all = projects(configDir);
  for (const project of all) {
    const cwd = await projectCwd(project);
    if (cwd) project.cwd = cwd;
  }
  const currentSlug = all.find((p) => existsSync(join(p.dir, `${sessionId}.jsonl`)))?.slug;
  const built = builtAt(configDir, name);
  const chosen = hasScope(configDir, name);
  const scope = readScope(configDir, name);
  const qmdNote = command ? '' : `\n${INSTALL}`;

  if (action === 'status') {
    if (!built && !chosen) {
      return `No session index yet. Build it with /recall-index all, or /recall-index <project name or path> for some projects.${qmdNote}\n${USAGE}`;
    }
    const when = built ? `last built ${built.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'not built yet';
    return [
      `Session index "${name}": ${covers(scope, all)}`,
      `${plural(exportedSessions(configDir), 'session')} exported; index ${size(indexFile(name, env))}; ${when}.`,
      'Recall searches the covered projects through the index, any other through their transcripts.',
    ].join('\n') + qmdNote;
  }

  if (action === 'remove' && targets.length === 0) {
    removeIndex(configDir, name, env);
    return `Removed the session index: the exported sessions, the "${name}" qmd index and its collection. A cross-session search builds it again for all projects, unless you run /recall-index first.`;
  }

  const { matched, unmatched } = targets.some((t) => t.toLowerCase() === 'all')
    ? { matched: [...all], unmatched: [] as string[] }
    : matchProjects(all, targets, currentSlug);
  const missed = unmatched.length > 0 ? `No project matches ${unmatched.map((t) => `"${t}"`).join(', ')}.` : '';
  if (matched.length === 0) return `${missed}\n${USAGE}`.trim();

  if (action === 'remove') {
    const before = scope === 'all' ? all.map((p) => p.slug) : scope;
    const kept = before.filter((slug) => !matched.some((p) => p.slug === slug));
    writeScope(configDir, name, kept);
    if (command && lockBuild(configDir, name)) {
      try {
        await buildIndex(configDir, command, name, env);
      } finally {
        unlockBuild(configDir, name);
      }
    }
    return [`Removed ${names(matched)} from the session index. ${covers(kept, all)}`, missed].filter(Boolean).join('\n');
  }

  if (!command) return INSTALL;
  const every = targets.some((t) => t.toLowerCase() === 'all');
  // An index that covers all projects, chosen or built that way by a search, keeps covering all of them.
  const coversAll = scope === 'all' && (chosen || built !== undefined);
  const next: IndexScope =
    every || coversAll ? 'all' : [...new Set([...(scope === 'all' ? [] : scope), ...matched.map((p) => p.slug)])];
  if (!lockBuild(configDir, name)) return 'An index build is already running; try again when it is done.';
  const started = Date.now();
  let ok: boolean;
  try {
    writeScope(configDir, name, next);
    ok = await buildIndex(configDir, command, name, env);
  } finally {
    unlockBuild(configDir, name);
  }
  if (!ok) return `qmd could not build the index; recall keeps scanning transcripts. Run /recall-index status to see what is there.${missed ? `\n${missed}` : ''}`;
  const coveredProjects = next === 'all' ? all : all.filter((p) => next.includes(p.slug));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  return [
    `Indexed ${plural(exportedSessions(configDir), 'session')} in ${plural(coveredProjects.length, 'project')} (${names(coveredProjects)}) in ${seconds} s; index ${size(indexFile(name, env))}.`,
    'Recall searches these projects through the index from now on, and keeps it up to date.',
    missed,
  ]
    .filter(Boolean)
    .join('\n');
}
