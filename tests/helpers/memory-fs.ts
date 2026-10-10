import type { ArchiveFs } from '../../src/recall/archive.js';

export const DAY = 86_400_000;

/** An in-memory `$.fs` (list, read, write, exists) with file times from `now`. */
export function memoryFs(now = () => 1_000 * DAY) {
  const files = new Map<string, { text: string; mtimeMs: number }>();
  const fs: ArchiveFs & { exists: (path: string) => Promise<boolean> } = {
    async list(path) {
      const prefix = `${path.replace(/\/$/, '')}/`;
      const names = new Map<string, 'file' | 'dir'>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const [name, ...rest] = key.slice(prefix.length).split('/');
        names.set(name!, rest.length > 0 ? 'dir' : 'file');
      }
      if (names.size === 0) throw new Error(`ENOENT: ${path}`);
      return [...names].map(([name, kind]) => ({
        name,
        kind,
        size: kind === 'file' ? files.get(prefix + name)!.text.length : 0,
        mtimeMs: kind === 'file' ? files.get(prefix + name)!.mtimeMs : 0,
        isLink: false,
      }));
    },
    async read(path) {
      const file = files.get(path);
      if (!file) throw new Error(`ENOENT: ${path}`);
      return file.text;
    },
    async write(path, text) {
      files.set(path, { text, mtimeMs: now() });
    },
    async exists(path) {
      return files.has(path);
    },
  };
  return { fs, files };
}
