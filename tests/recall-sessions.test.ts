import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { answer } from '../src/recall/cli.ts';
import { noteMeta, type SessionMeta } from '../src/recall/files.ts';
import { candidateFiles, searchSessions } from '../src/recall/sessions.ts';

const CURRENT = '11111111-1111-4111-8111-111111111111';
const SAME_PROJECT = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT = '33333333-3333-4333-8333-333333333333';

type Row = Record<string, unknown>;
const prompt = (text: string, cwd: string): Row => ({ type: 'user', cwd, message: { content: text } });
const call = (id: string, command: string): Row => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
});
const result = (id: string, text: string): Row => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

function write(dir: string, project: string, session: string, rows: Row[], day: string): void {
  mkdirSync(join(dir, 'projects', project), { recursive: true });
  const file = join(dir, 'projects', project, `${session}.jsonl`);
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  const time = new Date(`${day}T12:00:00Z`);
  utimesSync(file, time, time);
}

/** Three sessions: this one and another in C:\work\app, one in C:\work\billing-api. */
function config(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recall-sessions-'));
  write(dir, 'C--work-app', CURRENT, [prompt('Set up jscpd here like billing-api did.', 'C:\\work\\app')], '2026-10-10');
  write(
    dir,
    'C--work-app',
    SAME_PROJECT,
    [prompt('Why is the build slow?', 'C:\\work\\app'), call('toolu_a', 'npx jscpd src'), result('toolu_a', 'Found 3 clones.')],
    '2026-10-01',
  );
  write(
    dir,
    'c--work-billing-api',
    OTHER_PROJECT,
    [
      { type: 'custom-title', customTitle: 'Add duplicate code gate' },
      prompt('Add a jscpd duplicate code gate.', 'C:\\work\\billing-api'),
      call('toolu_j', 'cat .jscpd.json'),
      result('toolu_j', '{ "minTokens": 50, "minLines": 5, "baseline": ".jscpd-baseline.json" }'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'The gate is in test/jscpd.test.ts.' }] } },
    ],
    '2026-10-08',
  );
  return dir;
}

// The transcript scan; with qmd installed, "auto" would build the user's real session index.
const ask = (dir: string, request: Record<string, unknown>) =>
  answer({ configDir: dir, sessionId: CURRENT, request, sessionIndex: 'off' });

describe('session meta', () => {
  it('takes the first prompt the user typed, not a host block such as a command caveat', () => {
    const meta: SessionMeta = {};
    for (const content of ['<local-command-caveat>Caveat: run directly.</local-command-caveat>', '<command-name>/compact</command-name>', 'Fix the build.']) {
      noteMeta(JSON.stringify({ type: 'user', message: { content } }), meta);
    }
    expect(meta.firstPrompt).toBe('Fix the build.');
  });
});

describe('recall across sessions', () => {
  it('searches the other sessions of this project by default', async () => {
    const out = await ask(config(), { sessions: 'jscpd' });
    expect(out).toMatch(/^1 match\(es\) in 1 session\(s\) of this project for "jscpd", page 1\/1:/);
    expect(out).toContain(`[app · 2026-10-01 · "Why is the build slow?" · ${SAME_PROJECT}] call Bash (toolu_a)`);
    expect(out).not.toContain(CURRENT);
    expect(out).toContain('Open one with session: "<id>" and query, expand, range or touched.');
  });

  it('searches another project by a part of its path, or all projects', async () => {
    const dir = config();
    const jet = await ask(dir, { sessions: 'jscpd baseline', project: 'billing-api' });
    expect(jet).toMatch(/in 1 session\(s\) of projects matching "billing-api"/);
    // Ranked, not #N: a hit's number in its own session is unknown to the scan.
    expect(jet).toMatch(new RegExp(`^1\\. \\[billing-api · 2026-10-08 · "Add duplicate code gate" · ${OTHER_PROJECT}\\] call Bash \\(toolu_j\\)`, 'm'));
    expect(jet).not.toMatch(/^#\d/m);
    const all = await ask(dir, { sessions: 'jscpd', project: 'all' });
    expect(all).toMatch(/in 2 session\(s\) of all projects/);
    expect(await ask(dir, { sessions: 'jscpd', project: 'nope' })).toBe('No project matches "nope".');
    expect(await ask(dir, { sessions: 'kubernetes' })).toBe('No match for "kubernetes" in the other sessions of this project.');
  });

  it('keeps the sessions that hold every keyword, or any when none holds them all', async () => {
    const dir = config();
    const both = await ask(dir, { sessions: 'jscpd baseline', project: 'all' });
    expect(both).toMatch(/in 1 session\(s\) of all projects/);
    expect(both).not.toContain(SAME_PROJECT);
    const either = await ask(dir, { sessions: 'clones duplicate', project: 'all' });
    expect(either).toMatch(/in 2 session\(s\) of all projects/);
  });

  it('asks for real keywords instead of scanning every line for "the" or "a"', async () => {
    const dir = config();
    for (const sessions of ['the', 'a', 'of the']) {
      expect(await ask(dir, { sessions, project: 'all' })).toMatch(/^Too broad: give a word that says what to find/);
    }
  });

  it('answers with what it read when the scan runs out of time', async () => {
    const dir = config();
    const out = await answer({ configDir: dir, sessionId: CURRENT, request: { sessions: 'jscpd', project: 'all' }, sessionIndex: 'off', scanBudgetMs: 0 });
    expect(out).toMatch(/Read 1 of 2 matching sessions before the time ran out/);
  });

  it('answers from the scan when the session index throws', async () => {
    const dir = config();
    const current = join(dir, 'projects', 'C--work-app', `${CURRENT}.jsonl`);
    const broken = async () => {
      throw new Error('EBUSY: resource busy or locked');
    };
    const out = await searchSessions(dir, current, 'jscpd', 'all', 1, { index: broken });
    expect(out).toMatch(/match\(es\) in \d+ session\(s\) of all projects/);
  });

  it('labels a hit with its own project when one project folder name starts another', async () => {
    const dir = config();
    write(dir, 'C--work-app-admin', '44444444-4444-4444-8444-444444444444', [prompt('Add jscpd to admin.', 'C:\\work\\app-admin')], '2026-10-09');
    expect(await ask(dir, { sessions: 'admin', project: 'all' })).toContain('[app-admin · 2026-10-09');
  });

  it('runs any request on another session by its id or the first 8 characters of it', async () => {
    const dir = config();
    const out = await ask(dir, { session: OTHER_PROJECT.slice(0, 8), expand: ['toolu_j'] });
    expect(out).toContain('"baseline": ".jscpd-baseline.json"');
    expect(await ask(dir, { session: 'deadbeef', query: 'x' })).toBe('No session matches "deadbeef".');
  });

  it('finds the same candidate files with or without ripgrep', () => {
    const dir = config();
    const dirs = [join(dir, 'projects', 'C--work-app'), join(dir, 'projects', 'c--work-billing-api')];
    const sorted = (files: string[]) => files.map((f) => f.replace(/\\/g, '/')).sort();
    const withRg = candidateFiles(dirs, ['jscpd', 'baseline'], 'rg');
    expect(withRg.map((f) => f.includes(OTHER_PROJECT))).toEqual([true]);
    // Without ripgrep every transcript is a candidate; the line scan then decides.
    expect(sorted(candidateFiles(dirs, ['jscpd', 'baseline'], 'no-such-ripgrep'))).toHaveLength(3);
    const ask3 = (rg: string) =>
      answer({ configDir: dir, sessionId: CURRENT, request: { sessions: 'jscpd baseline', project: 'all' }, sessionIndex: 'off', rg });
    return Promise.all([ask3('rg'), ask3('no-such-ripgrep')]).then(([a, b]) => expect(b).toBe(a));
  });
});
