// Replay harness CLI. Usage: npm run replay -- --root <dir> --limit 30 --asker size --policy rank --out out.json
// Prior art: considerITman/fast-systemone-compaction `tools/replay` (MIT). See README.md.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { ASKER_NAMES, askerFor, type AskerName } from './askers.js';
import { aggregate, formatTable, type Aggregate } from './report.js';
import { DEFAULT_REPLAY_CONFIG, replaySession, type PointsMode, type ReplayConfig, type SessionResult } from './replay.js';
import { parseTranscriptFile } from './transcript.js';

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    limit: { type: 'string', default: '30' },
    pick: { type: 'string', default: 'recent' },
    'max-bytes': { type: 'string', default: '60000000' },
    asker: { type: 'string', default: 'size' },
    policy: { type: 'string', default: 'rank' },
    points: { type: 'string' },
    'trim-host-text': { type: 'string' },
    threshold: { type: 'string', default: String(DEFAULT_REPLAY_CONFIG.thresholdTokens) },
    'min-growth': { type: 'string', default: String(DEFAULT_REPLAY_CONFIG.minGrowthTokens) },
    'max-points': { type: 'string', default: String(DEFAULT_REPLAY_CONFIG.maxPointsPerSegment) },
    window: { type: 'string', default: String(DEFAULT_REPLAY_CONFIG.windowTurns) },
    out: { type: 'string' },
    options: { type: 'string' },
    'allow-network': { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const list = (value: string | undefined, fallback: string): string[] => (value ?? fallback).split(',').filter(Boolean);
const root = (values.root ?? '').replace(/^~/, homedir());
if (!root) fail('--root <dir with *.jsonl transcripts> is required');

const askers = list(values.asker, 'size') as AskerName[];
for (const name of askers) if (!ASKER_NAMES.includes(name)) fail(`unknown asker ${name}`);
const policies = list(values.policy, 'rank');
for (const policy of policies) if (policy !== 'threshold' && policy !== 'rank') fail(`unknown policy ${policy}`);

const libSource = ['types.ts', 'compact.ts']
  .map((file) => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8'))
  .join('\n');
const trimSupported = /trimHostText/.test(libSource);
const trims = list(values['trim-host-text'], 'off');
const trimModes = trims.map((mode) => {
  if (mode !== 'on' && mode !== 'off') fail(`--trim-host-text takes on|off, got ${mode}`);
  return mode;
});
if (trimModes.includes('on') && !trimSupported) {
  console.error('note: this branch has no trimHostText option; --trim-host-text on is skipped');
}

interface Run {
  label: { asker: string; policy: string; pointsMode: string; trim: string };
  config: ReplayConfig;
  asker: AskerName;
  results: SessionResult[];
}

const runs: Run[] = [];
for (const asker of askers) {
  const pointsMode = (values.points ?? (asker === 'recorded' ? 'recorded' : 'threshold')) as PointsMode;
  if (asker === 'recorded' && pointsMode !== 'recorded') fail('--asker recorded needs --points recorded');
  for (const policy of policies) {
    for (const trim of trimModes) {
      if (trim === 'on' && !trimSupported) continue;
      runs.push({
        label: { asker, policy, pointsMode, trim: trimSupported ? trim : 'n/a' },
        asker,
        results: [],
        config: {
          ...DEFAULT_REPLAY_CONFIG,
          points: pointsMode,
          policy: policy as ReplayConfig['policy'],
          ...(trimSupported ? { trimHostText: trim === 'on' } : {}),
          thresholdTokens: Number(values.threshold),
          minGrowthTokens: Number(values['min-growth']),
          maxPointsPerSegment: Number(values['max-points']),
          windowTurns: Number(values.window),
          options: values.options ? (JSON.parse(values.options) as ReplayConfig['options']) : undefined,
        },
      });
    }
  }
}
const factories = new Map(askers.map((name) => [name, askerFor(name, values['allow-network'] ?? false)]));
const recordedOnly = runs.every((run) => run.config.points === 'recorded');

const maxBytes = Number(values['max-bytes']);
const files = readdirSync(root)
  .filter((name) => name.endsWith('.jsonl'))
  .map((name) => ({ name, path: join(root, name), stat: statSync(join(root, name)) }))
  .filter((file) => file.stat.size <= maxBytes)
  .sort((a, b) => (values.pick === 'largest' ? b.stat.size - a.stat.size : b.stat.mtimeMs - a.stat.mtimeMs));

const limit = Number(values.limit);
let replayed = 0;
let skipped = 0;
for (const file of files) {
  if (replayed >= limit) break;
  const parsed = await parseTranscriptFile(file.path);
  if (recordedOnly && parsed.recorded.length === 0) {
    skipped++;
    continue;
  }
  const session = file.name.replace(/\.jsonl$/, '');
  const started = Date.now();
  let points = 0;
  for (const run of runs) {
    const result = await replaySession(session, parsed, run.config, factories.get(run.asker)!);
    run.results.push(result);
    points += result.segments.reduce((t, seg) => t + seg.points.length, 0);
  }
  if (points === 0) {
    for (const run of runs) run.results.pop();
    skipped++;
    continue;
  }
  replayed++;
  console.error(`[${replayed}/${limit}] ${session.slice(0, 8)} ${parsed.messages.length} msgs, ${points} points, ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

const aggregates: Aggregate[] = runs.map((run) => aggregate(run.label, run.results));
console.log(formatTable(aggregates));
console.log(`\nsessions replayed: ${replayed}, skipped (no point / over --max-bytes ${maxBytes}): ${skipped}`);

if (values.out) {
  writeFileSync(
    values.out,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        options: { threshold: values.threshold, minGrowth: values['min-growth'], window: values.window, maxPoints: values['max-points'], pick: values.pick, limit },
        sessionsReplayed: replayed,
        aggregates,
        runs: runs.map((run) => ({ ...run.label, sessions: run.results })),
      },
      null,
      1,
    ),
  );
}
