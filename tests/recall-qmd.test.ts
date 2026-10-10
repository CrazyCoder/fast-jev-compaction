import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildIndex, exportSessions, indexedHits, qmdCommand, sessionMarkdown, sessionsDir } from '../src/recall/qmd.ts';
import { searchSessions } from '../src/recall/sessions.ts';
import { qmdIndex } from '../src/recall/qmd.ts';

const ID = '33333333-3333-4333-8333-333333333333';

function config(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recall-qmd-'));
  const project = join(dir, 'projects', 'c--work-billing-api');
  mkdirSync(project, { recursive: true });
  const rows = [
    { type: 'custom-title', customTitle: 'Add duplicate code gate' },
    { type: 'user', cwd: 'C:\\work\\billing-api', message: { content: 'Add a jscpd duplicate code gate.' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_j', name: 'Bash', input: { command: 'cat .jscpd.json' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_j', content: '{ "baseline": ".jscpd-baseline.json" }' }] } },
  ];
  const file = join(project, `${ID}.jsonl`);
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  utimesSync(file, new Date('2026-10-08T12:00:00Z'), new Date('2026-10-08T12:00:00Z'));
  return dir;
}

describe('qmdCommand', () => {
  it('runs an npm shim on Windows as its script under the shim\'s Node', () => {
    const bin = mkdtempSync(join(tmpdir(), 'qmd-bin-'));
    writeFileSync(
      join(bin, 'qmd.cmd'),
      '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@tobilu\\qmd\\bin\\qmd" %*\r\n',
    );
    expect(qmdCommand({ PATH: bin }, 'win32')).toEqual(['node', join(bin, 'node_modules\\@tobilu\\qmd\\bin\\qmd')]);
    writeFileSync(join(bin, 'node.exe'), '');
    expect(qmdCommand({ PATH: bin }, 'win32')![0]).toBe(join(bin, 'node.exe'));
  });

  it('runs qmd itself elsewhere, and finds none when it is not installed', () => {
    const bin = mkdtempSync(join(tmpdir(), 'qmd-bin-'));
    expect(qmdCommand({ PATH: bin }, 'linux')).toBeUndefined();
    writeFileSync(join(bin, 'qmd'), '#!/bin/sh\n');
    expect(qmdCommand({ PATH: bin }, 'linux')).toEqual([join(bin, 'qmd')]);
  });
});

describe('session export', () => {
  it('writes one markdown file per session, its header naming the session, and only again when it changed', async () => {
    const dir = config();
    expect(await exportSessions(dir)).toBe(1);
    const md = readFileSync(join(sessionsDir(dir), 'c--work-billing-api', `${ID}.md`), 'utf8');
    expect(md.split('\n').slice(0, 3)).toEqual(['# Add duplicate code gate', '', `billing-api · 2026-10-08 · ${ID}`]);
    expect(md).toContain('## #2 call Bash (toolu_j)');
    expect(md).toContain('    { "baseline": ".jscpd-baseline.json" }');
    expect(await exportSessions(dir)).toBe(0);
  });

  it('indents every body line so tool output cannot add headings', () => {
    const md = sessionMarkdown('t', 'p · d · id', [{ n: 1, kind: 'reply', text: 'ok\n## #9 call Fake (x)' }]);
    expect(md).toContain('    ## #9 call Fake (x)');
    expect(md.match(/^## /gm)).toHaveLength(1);
  });

  it('maps qmd hits to sessions, the entry heading above the hit, and the scope', async () => {
    const dir = config();
    await exportSessions(dir);
    const json = JSON.stringify([
      { file: `qmd://sessions/c--work-billing-api/${ID}.md?index=x`, line: 9, snippet: '@@ -8,2 @@ (1 before, 0 after)\ncat .jscpd.json\n' },
      { file: 'qmd://sessions/c--other/44444444-4444-4444-8444-444444444444.md', line: 3, snippet: 'x' },
    ]);
    expect(indexedHits(dir, json, new Set(['c--work-billing-api']), 'none')).toEqual([
      {
        sessionId: ID,
        where: `billing-api · 2026-10-08 · "Add duplicate code gate" · ${ID}`,
        heading: 'call Bash (toolu_j)',
        snippet: '  cat .jscpd.json',
      },
    ]);
    expect(indexedHits(dir, json, new Set(['c--work-billing-api']), ID)).toEqual([]);
  });
});

/**
 * A stand-in for qmd: logs its arguments, answers `search` with FAKE_SEARCH
 * and FAKE_STATUS, and succeeds at everything else.
 */
function fakeQmd(): { command: string[]; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-qmd-'));
  const script = join(dir, 'qmd.cjs');
  const log = join(dir, 'args.log');
  writeFileSync(
    script,
    [
      "const fs = require('fs');",
      'const args = process.argv.slice(2);',
      'fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n");',
      "if (args.includes('search')) { process.stdout.write(process.env.FAKE_SEARCH ?? '[]'); process.exit(Number(process.env.FAKE_STATUS ?? 0)); }",
    ].join('\n'),
  );
  return { command: [process.execPath, script], log };
}

describe('the session index', () => {
  const ask = async (dir: string, query: string, project: string, env: Record<string, string>) => {
    const fake = fakeQmd();
    const index = qmdIndex(dir, { command: fake.command, name: 'fake', background: false, env: { ...process.env, FAKE_LOG: fake.log, ...env } });
    const hits = await index(query, new Set([project]), 'none');
    const calls = readFileSync(fake.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    return { hits, calls };
  };
  const hitIn = (slug: string, id: string) => JSON.stringify([{ file: `qmd://sessions/${slug}/${id}.md`, line: 1, snippet: 'x' }]);

  it('ends the options before the query, so a query starting with "-" is searched', async () => {
    const { calls } = await ask(config(), '-jscpd', 'c--work-billing-api', { FAKE_SEARCH: hitIn('c--work-billing-api', ID) });
    expect(calls.find((c) => c.includes('search'))!.slice(-2)).toEqual(['--', '-jscpd']);
  });

  it('leaves the search to the scan when qmd finds nothing in the asked projects, or does not answer JSON', async () => {
    const dir = config();
    expect((await ask(dir, 'jscpd', 'c--work-billing-api', { FAKE_SEARCH: hitIn('c--other', ID) })).hits).toBeUndefined();
    expect((await ask(dir, 'jscpd', 'c--work-billing-api', { FAKE_SEARCH: 'No results found.' })).hits).toBeUndefined();
    expect((await ask(dir, 'jscpd', 'c--work-billing-api', { FAKE_SEARCH: hitIn('c--work-billing-api', ID) })).hits).toHaveLength(1);
  });

  it('rebuilds the index after a search fails because its file is gone, not on a passing failure', async () => {
    const dir = config();
    const cache = mkdtempSync(join(tmpdir(), 'qmd-cache-'));
    const env = { XDG_CACHE_HOME: cache };
    await ask(dir, 'jscpd', 'c--work-billing-api', { ...env, FAKE_SEARCH: '[]' });
    expect(readdirSync(sessionsDir(dir))).toContain('.indexed-fake');
    mkdirSync(join(cache, 'qmd'));
    writeFileSync(join(cache, 'qmd', 'fake.sqlite'), '');
    await ask(dir, 'jscpd', 'c--work-billing-api', { ...env, FAKE_STATUS: '1' });
    expect(readdirSync(sessionsDir(dir))).toContain('.indexed-fake');
    rmSync(join(cache, 'qmd', 'fake.sqlite'));
    await ask(dir, 'jscpd', 'c--work-billing-api', { ...env, FAKE_STATUS: '1' });
    expect(readdirSync(sessionsDir(dir))).not.toContain('.indexed-fake');
    const { calls } = await ask(dir, 'jscpd', 'c--work-billing-api', { ...env, FAKE_SEARCH: '[]' });
    expect(calls.some((c) => c.includes('update'))).toBe(true);
  });
});

describe('session export upkeep', () => {
  it('skips the current session, drops exports whose transcript is gone, and survives an unreadable transcript', async () => {
    const dir = config();
    const project = join(dir, 'projects', 'c--work-billing-api');
    const other = '55555555-5555-4555-8555-555555555555';
    writeFileSync(join(project, `${other}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'gone soon' } }));
    mkdirSync(join(project, '66666666-6666-4666-8666-666666666666.jsonl'));
    expect(await exportSessions(dir, ID)).toBe(1);
    const exported = join(sessionsDir(dir), 'c--work-billing-api');
    expect(readdirSync(exported)).toEqual([`${other}.md`]);
    rmSync(join(project, `${other}.jsonl`));
    await exportSessions(dir, ID);
    expect(readdirSync(exported)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('writes exports readable by their owner only', async () => {
    const dir = config();
    await exportSessions(dir);
    expect(statSync(join(sessionsDir(dir), 'c--work-billing-api', `${ID}.md`)).mode & 0o777).toBe(0o600);
    expect(statSync(sessionsDir(dir)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === 'win32')('makes exports and the index written before readable by their owner only', async () => {
    const dir = config();
    await exportSessions(dir);
    const md = join(sessionsDir(dir), 'c--work-billing-api', `${ID}.md`);
    chmodSync(md, 0o644);
    chmodSync(join(sessionsDir(dir), 'c--work-billing-api'), 0o755);
    const cache = mkdtempSync(join(tmpdir(), 'qmd-cache-'));
    mkdirSync(join(cache, 'qmd'));
    const sqlite = join(cache, 'qmd', 'fake.sqlite');
    writeFileSync(sqlite, '', { mode: 0o644 });
    const fake = fakeQmd();
    await buildIndex(dir, fake.command, 'fake', { ...process.env, FAKE_LOG: fake.log, XDG_CACHE_HOME: cache });
    expect(statSync(md).mode & 0o777).toBe(0o600);
    expect(statSync(join(sessionsDir(dir), 'c--work-billing-api')).mode & 0o777).toBe(0o700);
    expect(statSync(sqlite).mode & 0o777).toBe(0o600);
  });
});

const qmd = qmdCommand();

describe.runIf(qmd)('with the installed qmd', () => {
  // qmd keeps its index and collections under XDG_CACHE_HOME and XDG_CONFIG_HOME: a temp dir, never the user's.
  const xdg = mkdtempSync(join(tmpdir(), 'qmd-xdg-'));
  const env = { ...process.env, XDG_CACHE_HOME: join(xdg, 'cache'), XDG_CONFIG_HOME: join(xdg, 'config') };
  const INDEX = `fjc-test-${process.pid}`;
  afterAll(() => rmSync(xdg, { recursive: true, force: true }));

  it('builds the index and answers a cross-project search from it', async () => {
    const dir = config();
    const index = qmdIndex(dir, { command: qmd!, name: INDEX, background: false, env });
    const current = join(dir, 'projects', 'c--work-billing-api', 'none.jsonl');
    const out = await searchSessions(dir, current, 'jscpd baseline', 'all', 1, { index });
    expect(out).toMatch(/\(session index\)/);
    expect(out).toContain(`[billing-api · 2026-10-08 · "Add duplicate code gate" · ${ID}]`);
    expect(existsSync(join(xdg, 'cache', 'qmd', `${INDEX}.sqlite`))).toBe(true);
    expect(existsSync(join(homedir(), '.cache', 'qmd', `${INDEX}.sqlite`))).toBe(false);
  }, 120_000);
});
