import { describe, expect, it } from 'vitest';
import { appendCompactionLog, COMPACTION_LOG_LINES, compactionLogPath, register } from '../hooks/fast-jev.ts';

const LOG = '/home/me/.claude/fast-jev-compaction/compactions.log';

function fsHost(files: Map<string, string>, env: Record<string, string> = { HOME: '/home/me' }) {
  const debug: string[] = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  let unreadable = false;
  const $ = {
    env: { get: async (name: string) => env[name] },
    ui: { log: (text: string) => debug.push(text), toast: () => {} },
    fs: {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => {
        await tick();
        if (unreadable) throw new Error('EACCES: permission denied');
        return files.get(path)!;
      },
      write: async (path: string, text: string) => {
        await tick();
        files.set(path, text);
      },
    },
  };
  return { $, debug, makeUnreadable: () => (unreadable = true) };
}

const linesOf = (files: Map<string, string>) => files.get(LOG)!.split('\n').filter(Boolean);

describe('compaction log file', () => {
  it('lives under CLAUDE_CONFIG_DIR, else HOME or USERPROFILE /.claude', async () => {
    const at = (env: Record<string, string>) => compactionLogPath({ env: { get: async (name: string) => env[name] } });
    expect(await at({ HOME: '/home/me' })).toBe(LOG);
    expect(await at({ USERPROFILE: 'C:\\Users\\me' })).toBe('C:/Users/me/.claude/fast-jev-compaction/compactions.log');
    expect(await at({ HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg/' })).toBe('/cfg/fast-jev-compaction/compactions.log');
    expect(await at({})).toBeUndefined();
  });

  it('appends one timestamped line at a time and keeps the newest lines', async () => {
    const files = new Map([[LOG, Array.from({ length: COMPACTION_LOG_LINES }, (_, i) => `old ${i}`).join('\n')]]);
    const { $ } = fsHost(files);
    await Promise.all([appendCompactionLog($, 'manual A'), appendCompactionLog($, 'auto B\nsecond line')]);
    const lines = linesOf(files);
    expect(lines).toHaveLength(COMPACTION_LOG_LINES);
    expect(lines[0]).toBe('old 2');
    expect(lines.slice(-2).map((l) => l.replace(/^\S+Z /, ''))).toEqual(['manual A', 'auto B second line']);
  });

  it('never replaces a log it cannot read', async () => {
    const files = new Map([[LOG, 'kept\n']]);
    const { $, debug, makeUnreadable } = fsHost(files);
    makeUnreadable();
    await appendCompactionLog($, 'manual C');
    expect(files.get(LOG)).toBe('kept\n');
    expect(debug).toEqual(['compaction log not written (EACCES: permission denied)']);
  });

  it('records each compaction outcome as one line', async () => {
    const files = new Map<string, string>();
    const { $ } = fsHost(files, { HOME: '/home/me', TYPESAFE_API_KEY: '' });
    const hooks: Record<string, (host: unknown, event: unknown, next: (e: unknown) => unknown) => Promise<unknown>> = {};
    (register as unknown as (on: unknown, options: unknown) => void)(
      (event: string, hook: (typeof hooks)[string]) => (hooks[event] = hook),
      {},
    );
    const host = { ...$, settings: { read: async () => ({}) }, clock: { sleep: () => new Promise<void>(() => {}) } };
    await hooks['session.compact']!(host, { trigger: 'auto', messages: [] }, async () => ({ messages: [] }));
    const lines = linesOf(files);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\S+Z auto fallback to built-in summary \(TYPESAFE_API_KEY is not configured\)$/);
  });
});
