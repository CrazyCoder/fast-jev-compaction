# Replay harness

Dev tooling (not shipped): replays real Claude Code transcripts through
`compact()` and measures what each keep policy costs and what it loses. Offline
by default; nothing here calls the network unless you pass
`--asker jev --allow-network` with `TYPESAFE_API_KEY` set.

```bash
npm run replay -- --root ~/.claude/projects/<dir> --limit 30 --asker size --policy rank --out out.json
npm run replay -- --root <dir> --asker recorded --policy threshold,rank   # logged Jev scores, logged points
npm run replay -- --root <dir> --asker size,zero,one --policy threshold,rank
```

Comma lists run a matrix over the same parsed sessions.

| Flag | Meaning (default) |
| -- | -- |
| `--root` | directory of `*.jsonl` session files (required) |
| `--limit` | sessions to replay; sessions with no point are skipped, not counted (30) |
| `--pick` | `recent` or `largest` first (recent); `--max-bytes` skips bigger files (60 MB) |
| `--asker` | `size`, `zero`, `one`, `recorded`, `jev` (size) |
| `--policy` | `threshold` or `rank` = the library's `keepMode` (rank) |
| `--points` | `threshold` (sequential simulation) or `recorded` (the hook's logged compactions); `recorded` asker forces `recorded` |
| `--trim-host-text on\|off` | passed as `trimHostText` only when `src/` has that option (feature-detected by grepping `src/types.ts` and `src/compact.ts`); skipped with a note otherwise |
| `--threshold` / `--min-growth` / `--max-points` / `--window` | 150000 est. tokens / 25000 / 12 per segment / 20 assistant turns |
| `--out` | JSON path |

## What it does

- **Parsing** (`transcript.ts`): JSONL to `Message[]`, mirroring
  `hooks/jetcompact.ts`. Sidechain entries are ignored, assistant lines sharing
  a `message.id` are merged, `tool_result` blocks pair with `tool_use` by id.
- **Segments**: a `compact_boundary` starts a new segment, replayed
  independently (the model never saw earlier messages again). Each segment
  starts from its own first message.
- **Threshold points**: walk a segment keeping a working history. When its
  estimate passes `--threshold`, has grown `--min-growth` since the last floor
  and no tool call is pending, simulate the hook: the working history becomes
  the compacted one and later original messages are appended to it. Successive
  points therefore show the real recurrence.
- **Recorded points**: the hook logs
  `decisions: t12:Read:drop_call/call=0.21/result=0.11` lines. Each logged event
  is a point; `tN` is mapped by order of `collectToolCalls`, and a point is
  skipped ("skip") when under 90 % of the logged tool names match. The prefix is
  the segment's untouched original messages (no sequential state).
- **Askers**: `size` scores results by log-size percentile rank and calls by
  recency (the "keep the largest outputs" baseline of upstream issue #26);
  `zero`/`one` answer a constant; `recorded` replays logged scores; `jev` is
  live.

## Metrics

Per point, aggregated in the table and JSON: all token figures use the library's
`estimateTokens`.

- **reduct**: `1 - sum(after) / sum(before)` over points. **floor**: estimated
  tokens right after compaction; `first`/`last` are the mean first/last floor
  per segment, **growth/pt** the mean of
  `(last floor - first floor) / (points - 1)` over segments with at least two
  points (threshold points only).
- **degraded**: results newly dropped or stubbed at a point (results degraded by
  an earlier point are not recounted).
- **lost&needed**: a degraded result is lost-and-needed when a distinctive token
  of it (paths, identifiers of 8+ chars that contain `_`, a digit or camelCase,
  hex of 8+ chars with a digit, UUIDs, numbers of 5+ digits; at most 500 per
  result) is absent from the compacted history **and** appears in a tool call
  input within the next `--window` assistant turns of the original transcript
  (never past the segment end for threshold points) **before any message showed
  it again** (a later result, user text or assistant text counts as showing it).
  Rate = lost-and-needed / degraded.
- **rerun**: the same tool with an identical input is issued again inside the
  window.
- **win**: mean assistant turns actually available to the window; far below
  `--window` means weak evidence.

## Privacy

Output has ids (session file names, message indices), sizes, counts and tool
names only. No message text, no extracted tokens. The test fixtures are
synthetic. Review the JSON before sharing anyway: tool names and session ids
describe your work.

## Caveats

- Lost-and-needed is a proxy: a token typed into a call may be guessable, and a
  lost value may be re-derived. It undercounts needs that surface later than the
  window or in assistant prose, and tokens beyond 500 per result.
- The simulated compaction is not what the model really saw, so the continuation
  is held fixed (the original transcript) while the policy changes; this
  measures information loss, not behaviour change.
- Recorded points coincide with the `compact_boundary` that followed them (often
  a manual `/compact`), and the work after one is frequently a new task, which
  biases loss toward zero at those points.
- Token counts are estimates, thinking blocks and images are not parsed, and the
  60 MB cap skips the largest sessions.

## Credit

Approach and the distinctive-token idea follow
considerITman/fast-systemone-compaction `tools/replay/` (MIT). This code is a
reimplementation for this library's types, not a copy.
