import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exportSessions, indexedHits, qmdCommand, sessionMarkdown, sessionsDir } from '../src/recall/qmd.ts';
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

const qmd = qmdCommand();
const INDEX = `fjc-test-${process.pid}`;

describe.runIf(qmd)('with the installed qmd', () => {
  afterAll(() => {
    spawnSync(qmd![0]!, [...qmd!.slice(1), '--index', INDEX, 'collection', 'remove', 'sessions'], { encoding: 'utf8' });
    // qmd keeps an index in ~/.cache/qmd/<name>.sqlite and its collections in ~/.config/qmd/<name>.yml.
    const files = ['', '-wal', '-shm'].map((suffix) => join(homedir(), '.cache', 'qmd', `${INDEX}.sqlite${suffix}`));
    for (const file of [...files, join(homedir(), '.config', 'qmd', `${INDEX}.yml`)]) {
      if (existsSync(file)) rmSync(file);
    }
  });

  it('builds the index and answers a cross-project search from it', async () => {
    const dir = config();
    const index = qmdIndex(dir, { command: qmd!, name: INDEX, background: false });
    const current = join(dir, 'projects', 'c--work-billing-api', 'none.jsonl');
    const out = await searchSessions(dir, current, 'jscpd baseline', 'all', 1, { index });
    expect(out).toMatch(/\(session index\)/);
    expect(out).toContain(`[billing-api · 2026-10-08 · "Add duplicate code gate" · ${ID}]`);
  }, 120_000);
});
