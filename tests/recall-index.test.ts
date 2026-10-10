import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchProjects, parseIndexArgs, runIndexCommand } from '../src/recall/index-command.ts';
import { sessionsDir } from '../src/recall/qmd.ts';
import { fakeQmd } from './helpers/fake-qmd.ts';

const CURRENT = '11111111-1111-4111-8111-111111111111';
const PROJECTS = [
  { slug: 'C--work-app', cwd: 'C:\\work\\app', id: CURRENT },
  { slug: 'C--work-billing-api', cwd: 'C:\\work\\billing-api', id: '22222222-2222-4222-8222-222222222222' },
  { slug: 'C--other-tool', cwd: 'C:\\other\\tool', id: '33333333-3333-4333-8333-333333333333' },
  { slug: '-home-me-notes', cwd: '/home/me/notes', id: '44444444-4444-4444-8444-444444444444' },
];

function config(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recall-index-'));
  for (const p of PROJECTS) {
    mkdirSync(join(dir, 'projects', p.slug), { recursive: true });
    const row = { type: 'user', cwd: p.cwd, message: { content: `Work on ${p.slug}.` } };
    writeFileSync(join(dir, 'projects', p.slug, `${p.id}.jsonl`), JSON.stringify(row));
  }
  return dir;
}

describe('parseIndexArgs', () => {
  it('reads status, all, remove and a list of names or paths', () => {
    expect(parseIndexArgs('')).toEqual({ action: 'status', targets: [] });
    expect(parseIndexArgs('  status ')).toEqual({ action: 'status', targets: [] });
    expect(parseIndexArgs('all')).toEqual({ action: 'build', targets: ['all'] });
    expect(parseIndexArgs('billing-api, "C:\\My Work\\app" ~/notes')).toEqual({
      action: 'build',
      targets: ['billing-api', 'C:\\My Work\\app', '~/notes'],
    });
    expect(parseIndexArgs('remove')).toEqual({ action: 'remove', targets: [] });
    expect(parseIndexArgs('remove billing-api,tool')).toEqual({ action: 'remove', targets: ['billing-api', 'tool'] });
  });
});

describe('matchProjects', () => {
  const all = PROJECTS.map((p) => ({ dir: `/x/${p.slug}`, slug: p.slug, cwd: p.cwd }));
  const slugs = (targets: string[], current = 'C--work-app') => {
    const { matched, unmatched } = matchProjects(all, targets, current, '/home/me');
    return { matched: matched.map((p) => p.slug), unmatched };
  };

  it('takes "." for this project, a name part, or a path in any case and slash style', () => {
    expect(slugs(['.'])).toEqual({ matched: ['C--work-app'], unmatched: [] });
    expect(slugs(['billing'])).toEqual({ matched: ['C--work-billing-api'], unmatched: [] });
    expect(slugs(['c:/WORK/app/'])).toEqual({ matched: ['C--work-app'], unmatched: [] });
    expect(slugs(['~/notes'])).toEqual({ matched: ['-home-me-notes'], unmatched: [] });
    expect(slugs(['C--other-tool'])).toEqual({ matched: ['C--other-tool'], unmatched: [] });
  });

  it('takes a folder for every project under it, and reports what matched nothing', () => {
    expect(slugs(['C:\\work', 'nothing-here'])).toEqual({
      matched: ['C--work-app', 'C--work-billing-api'],
      unmatched: ['nothing-here'],
    });
    // A folder name is a path part, not any substring: C:\work does not take C:\workshop.
    expect(slugs(['C:\\wor']).matched).toEqual([]);
  });
});

describe('runIndexCommand', () => {
  const run = (dir: string, args: string, qmd = fakeQmd()) =>
    runIndexCommand({
      configDir: dir,
      sessionId: CURRENT,
      args,
      command: qmd.command,
      name: 'fake',
      env: { ...process.env, ...qmd.env, XDG_CACHE_HOME: join(dir, 'cache'), XDG_CONFIG_HOME: join(dir, 'conf') },
    });
  const exported = (dir: string) =>
    existsSync(sessionsDir(dir)) ? readdirSync(sessionsDir(dir), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];

  it('indexes the named projects, adds more, and keeps searches to them', async () => {
    const dir = config();
    const qmd = fakeQmd();
    const out = await run(dir, 'billing', qmd);
    expect(out).toMatch(/^Indexed 1 session in 1 project \(billing-api\)/);
    expect(exported(dir)).toEqual(['C--work-billing-api']);
    expect(qmd.calls().some((c) => c.includes('update'))).toBe(true);
    await run(dir, '.');
    expect(exported(dir)).toEqual(['C--work-app', 'C--work-billing-api']);
    expect(await run(dir, '')).toMatch(/Covers 2 projects: app, billing-api\./);
    expect(JSON.parse(readFileSync(join(sessionsDir(dir), '.scope-fake.json'), 'utf8'))).toEqual({
      projects: ['C--work-billing-api', 'C--work-app'],
    });
  });

  it('keeps covering all projects when the index was built for all of them', async () => {
    const dir = config();
    await run(dir, 'all');
    await run(dir, 'billing');
    expect(await run(dir, '')).toMatch(/Covers all projects/);
  });

  it('indexes every project with all', async () => {
    const dir = config();
    expect(await run(dir, 'all')).toMatch(/^Indexed 4 sessions in 4 projects/);
    expect(exported(dir)).toHaveLength(4);
    expect(await run(dir, 'status')).toMatch(/Covers all projects/);
  });

  it('removes named projects, or the whole index', async () => {
    const dir = config();
    await run(dir, 'all');
    expect(await run(dir, 'remove tool')).toMatch(/Removed tool/);
    expect(exported(dir)).toEqual(['-home-me-notes', 'C--work-app', 'C--work-billing-api']);
    expect(await run(dir, 'remove')).toMatch(/Removed the session index/);
    expect(existsSync(sessionsDir(dir))).toBe(false);
    expect(await run(dir, '')).toMatch(/No session index yet/);
  });

  it('removes the whole index with remove all', async () => {
    const dir = config();
    await run(dir, 'all');
    expect(await run(dir, 'remove all')).toMatch(/Removed the session index/);
    expect(existsSync(sessionsDir(dir))).toBe(false);
  });

  it('drops a removed project\'s exports even when it cannot rebuild the index', async () => {
    const dir = config();
    await run(dir, 'all');
    const out = await runIndexCommand({ configDir: dir, sessionId: CURRENT, args: 'remove tool', command: undefined, name: 'fake', env: process.env });
    expect(out).toMatch(/Removed tool/);
    expect(exported(dir)).toEqual(['-home-me-notes', 'C--work-app', 'C--work-billing-api']);
  });

  it('names what matched nothing and builds nothing for it', async () => {
    const dir = config();
    expect(await run(dir, 'nothing-here')).toMatch(/No project matches "nothing-here"/);
    expect(exported(dir)).toEqual([]);
  });

  it('says how to install qmd when it is not there', async () => {
    const dir = config();
    const out = await runIndexCommand({ configDir: dir, sessionId: CURRENT, args: 'all', command: undefined, name: 'fake', env: process.env });
    expect(out).toMatch(/npm install -g @tobilu\/qmd/);
  });
});
