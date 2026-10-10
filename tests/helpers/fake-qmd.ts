import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in for qmd: logs each call's arguments to `log` (one JSON array per
 * line), answers `search` with FAKE_SEARCH (default `[]`) and exits with
 * FAKE_STATUS (default 0). `env` routes the log there.
 */
export function fakeQmd(): { command: string[]; log: string; env: Record<string, string>; calls: () => string[][] } {
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
  writeFileSync(log, '');
  const calls = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  return { command: [process.execPath, script], log, env: { FAKE_LOG: log }, calls };
}
