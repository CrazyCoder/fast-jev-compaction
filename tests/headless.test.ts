import { describe, expect, it } from 'vitest';
import { register } from '../hooks/jetcompact.ts';

describe('turn.complete in a headless session', () => {
  it('stops retrying after the host says compact is unavailable', async () => {
    const handlers: Record<string, Function> = {};
    register(((name: string, h: Function) => { handlers[name] = h; return { catch: () => undefined }; }) as never, {} as never);
    const logs: string[] = [];
    let compacts = 0;
    let queued = 0;
    const $ = {
      session: {
        usage: async () => ({ context: { percent: 70 } }),
        compact: async () => {
          compacts++;
          throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet');
        },
      },
      command: { run: async () => { queued++; } },
      ui: { log: (t: string) => logs.push(t), toast: () => {} },
      env: { get: async (name: string) => (name === 'HOME' ? '/home/me' : undefined) },
      fs: {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => files.get(path)!,
        write: async (path: string, text: string) => { files.set(path, text); },
      },
    };
    const files = new Map<string, string>();
    for (let i = 0; i < 3; i++) await handlers['turn.complete']($, { reason: 'answer' }, async () => undefined);
    expect(compacts).toBe(1);
    expect(queued).toBe(1);
    expect(logs).toEqual([]);
    expect(files.get('/home/me/.claude/jetcompact/compactions.log')).toMatch(
      /^\S+Z auto-compact at 70%: headless session, queued \/compact\n$/,
    );
  });
});
