/**
 * Claude Code's transcript files: one folder per project (working directory)
 * under `<config>/projects/`, one `<session>.jsonl` per session in it.
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { transcriptReader, type Entry } from './transcript.ts';

export type Project = { dir: string; slug: string; cwd?: string };

export function projects(configDir: string): Project[] {
  const root = join(configDir, 'projects');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ dir: join(root, d.name), slug: d.name }));
}

export function transcripts(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name));
}

export function lines(file: string) {
  return createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
}

/** What a transcript says about its session besides the conversation. */
export type SessionMeta = { title?: string; firstPrompt?: string; cwd?: string };

/** Notes the title, first prompt and working directory a line holds; parses only lines that can. */
export function noteMeta(line: string, meta: SessionMeta): void {
  const wants =
    line.includes('"custom-title"') ||
    (meta.firstPrompt === undefined && line.includes('"type":"user"')) ||
    (meta.cwd === undefined && line.includes('"cwd"'));
  if (!wants) return;
  let row: { type?: unknown; customTitle?: unknown; cwd?: unknown; message?: { content?: unknown } };
  try {
    row = JSON.parse(line) as typeof row;
  } catch {
    return;
  }
  if (row.type === 'custom-title' && typeof row.customTitle === 'string' && row.customTitle.trim()) {
    meta.title = row.customTitle.trim();
  }
  if (meta.cwd === undefined && typeof row.cwd === 'string') meta.cwd = row.cwd;
  const content = row.message?.content;
  // A prompt that opens with a tag is a host block (a command caveat, a slash command), not typed words.
  const typed = typeof content === 'string' ? content.trim() : '';
  if (meta.firstPrompt === undefined && row.type === 'user' && typed && !typed.startsWith('<')) {
    meta.firstPrompt = typed;
  }
}

/** The working directory a project's newest transcript names first. */
export async function projectCwd(project: Project): Promise<string | undefined> {
  const newest = transcripts(project.dir).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!newest) return undefined;
  const meta: SessionMeta = {};
  const reader = lines(newest);
  for await (const line of reader) {
    noteMeta(line, meta);
    if (meta.cwd !== undefined) {
      reader.close();
      break;
    }
  }
  return meta.cwd;
}

/** A project's short name: the last folder of its working directory, else its folder under projects/. */
export function projectName(project: Project): string {
  return project.cwd ? basename(project.cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/')) : project.slug;
}

/** A transcript's entries and meta, in one read. */
export async function readSession(file: string, sidechain = false): Promise<{ entries: Entry[]; meta: SessionMeta }> {
  const reader = transcriptReader({ sidechain });
  const meta: SessionMeta = {};
  for await (const line of lines(file)) {
    noteMeta(line, meta);
    reader.line(line);
  }
  return { entries: reader.entries, meta };
}

export async function readEntries(file: string, sidechain = false): Promise<Entry[]> {
  return (await readSession(file, sidechain)).entries;
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
