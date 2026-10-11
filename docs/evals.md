# Evals: JetCompact against Claude Code's built-in summary

Claude Sonnet 5.5 finished every task with either compaction, so the difference
is in what a compaction costs and what the model does after it:

- **One compaction in a session** (a 150k compaction window): JetCompact 0.11
  cost 13% less per run than the built-in summary ($0.73 against $0.84), the
  model re-read 0.8 files after compacting against 2.1, and a compaction took
  0.7 s instead of 25 s.
- **Repeated compaction in a small window** (100k, 1 to 4 compactions): the two
  cost the same ($0.88 against $0.87) and JetCompact re-read less (1.6 against
  2.3). Here JetCompact hands most compactions to the built-in summary, because
  what it keeps would not fit its 45% target.
- Before 0.11 fixed how the plugin reads the context's fill, the second case
  cost 17% more: JetCompact kept 58k per compaction against 44k and so compacted
  more often.

The harness, the tasks and the raw numbers are in
[CrazyCoder/jetcompact-eval](https://github.com/CrazyCoder/jetcompact-eval).

## Setup

- Model: Sonnet 5.5 (`claude -p`, headless), one session per run, each task step
  a user turn (`--resume`).
- Tasks: one generated invoicing project ("ledger") with tests, 9 tasks of 6 to
  17 turns. Three hide a fact deep in an early large output (a 1,500-line spec,
  a 2,000-line script output, paged customer notes) and need it after
  compacting; two are long sessions where the user states a convention in turn 2
  that is needed in turns 14 and 15. Graded by hidden tests.
- Compaction: a `/compact` step stands for an automatic compaction and runs only
  when the context is at 60% of the compaction window
  (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`) or more, in both arms. JetCompact's arm
  gets `/compact automatic, from jetcompact`, the form its own queued compaction
  takes, so its size guards and the built-in fallback apply as in real use; its
  own trigger is off (`compactAtPercent` 1000) so both arms compact at the same
  points.
- Cost is Claude Code's own `total_cost_usd`, compaction included; the decision
  model's requests are not in it. A re-read is a Read, after a compaction, of a
  file read before it.

## One compaction: all 9 tasks

27 runs per arm at a 150k window, JetCompact at `09b893e` (0.11 before the
window fix). Means per run; brackets are the range.

|  | Built-in summary | JetCompact (Jev) | JetCompact (algorithmic) |
| -- | -- | -- | -- |
| Tasks passed | 27/27 | 27/27 | 27/27 |
| Re-reads after a compaction | 1.7 [0-4] | 0.0 [0-1] | 0.9 [0-2] |
| Identical repeated tool calls | 1.2 [0-3] | 0.3 [0-2] | 0.3 [0-2] |
| Time per compaction | 24.9 s [18-36] | 0.6 s [0.5-0.7] | 0.4 s [0.3-0.4] |
| Wall time per run | 156 s | 129 s | 135 s |
| Claude cost per run | $0.79 [0.28-1.29] | $0.76 [0.30-1.04] | $0.81 [0.28-1.20] |
| Context after a compaction | 49k [38k-58k] | 67k [62k-73k] | 68k [55k-73k] |

JetCompact was cheaper on 6 of 9 tasks (by up to 12%: `api-migration` $0.75
against $0.85) and more expensive on `migration-notes` ($0.67 against $0.60).
`audit-script` never reached the trigger, so its arms differ only by chance.

0.11 (`7b4496d`; the release adds review fixes that do not change what these
runs exercised), 8 runs on four of those tasks (`api-migration`, `csv-export`,
`fix-bugs`, `discounts`), against the 12 runs per arm above on the same tasks:

|  | Built-in summary | 0.11 before the fix | 0.11 |
| -- | -- | -- | -- |
| Claude cost per run | $0.84 | $0.79 | $0.73 |
| Re-reads after a compaction | 2.1 | 0.0 | 0.8 |
| Time per compaction | 25 s | 0.6 s | 0.7 s |
| Context after a compaction | 49k | 67k | 59k |

## Repeated compaction

12 runs per arm at a 100k window on the two long tasks and two recall tasks,
which compacted 1 to 4 times each (JetCompact before the fix 2 to 4, the
built-in summary and 0.11 1 to 3). The JetCompact columns ran at `09b893e` (0.11
before the fix), `7cf973b` (the sticky harder cut added) and `7b4496d` (the
window fix):

|  | Built-in summary | 0.11 before the fix | Sticky harder cut | 0.11 |
| -- | -- | -- | -- | -- |
| Tasks passed | 12/12 | 12/12 | 12/12 | 12/12 |
| Claude cost per run | $0.87 | $1.02 | $1.02 | $0.88 |
| Re-reads after a compaction | 2.3 | 1.2 | 0.8 | 1.6 |
| Cache writes per run | 121k | 176k | 181k | 123k |
| Context after a compaction | 44k | 58k | 58k | 45k |
| Time per compaction | 24.7 s | 2.4 s | 0.6 s | 25.2 s |

Before the fix, `targetPercent` (45) was compared with the fill of the model's
whole 200k window, so at a 100k compaction window it never applied: JetCompact
kept 58k, compacted more often, and every compaction rewrote the prompt cache at
that size. Measured against the compaction window, about 30k of it is fixed
(Claude Code's tools 24k, system prompt, skills), so the 45% target leaves about
15k for messages, and most compactions there go to the built-in summary. Making
every compaction after the first cut harder on its own (the "sticky harder cut"
column) lowered re-reads but not the context kept.

## The trade-off: compacting harder or lighter

A compaction that keeps more context leaves the model what it was working with,
so it re-reads and repeats less; but every later request reads that larger
context from the cache, the next compaction comes sooner, and each compaction
rewrites the cache at the new size. `tradeoff.mjs` in the eval repository fits
these per arm from the one-compaction runs and projects a 400-request session in
a 200k window, with Sonnet prices.

At a 60% trigger:

| Cache | Built-in summary | JetCompact before the fix |
| -- | -- | -- |
| 1-hour (writes at 2x input) | $43.8, 34 compactions, 848 s compacting | $48.3, 45 compactions, 28 s |
| 5-minute (1.25x) | $34.3 | $35.7 |
| 5-minute, a pause past it every 15 requests | $41.9 | $44.1 |

Holding the share kept equal, JetCompact's lower re-read rate makes it the
cheaper one at every share (1-hour cache, 60% trigger):

| Share kept per compaction | 30% | 40% | 50% | 60% | 70% |
| -- | -- | -- | -- | -- | -- |
| JetCompact's re-reads | $33.7 | $37.7 | $43.3 | $50.9 | $63.5 |
| Built-in summary's re-reads | $35.2 | $39.7 | $46.2 | $54.9 | $69.5 |

The share kept, not the decider, drives the cost of a long session: from 70% to
40% kept cuts it by about 40%. A light compaction pays off while a session
compacts once or twice, where it avoids the re-reads; in a long session it pays
a cache rewrite at every extra compaction. The 1-hour cache, Claude Code's
default, makes each rewrite cost more and so favours keeping less; the 5-minute
cache narrows the difference to a few percent.

How the defaults follow from it:

- The first compaction stays light (`keepResultTokens` 12,000, 300-character
  heads, prose verbatim), where the runs measured the re-read advantage.
- `targetPercent` (45, of the compaction window) caps what a compaction keeps.
  Above it, JetCompact digests old prose and cuts harder; when that still does
  not fit, the built-in summary runs. Lower it to compact harder, raise it to
  keep more.
- Once a session holds a cut from an earlier compaction, every compaction cuts
  harder from its first attempt: the keep budgets halve, and heads shrink to 100
  characters. Aging earlier cuts to their note (`ageCutResults`) stays off: in a
  4-task sweep it raised re-reads from 0.5 to 1.3 per run.

## Jev, OpenAI Decisions, or no model

On the three tasks where all four arms ran (`api-migration`, `csv-export`,
`fix-bugs`; 3 runs each, 2 for OpenAI; JetCompact at `09b893e`):

|  | Built-in summary | Jev | OpenAI Decisions | Algorithmic |
| -- | -- | -- | -- | -- |
| Re-reads after a compaction | 2.5 | 0.0 | 1.2 | 1.3 |
| Claude cost per run | $0.84 | $0.77 | $0.81 | $0.82 |
| Time per compaction | 25 s | 0.6 s | 1.0 s | 0.4 s |

Over all 9 tasks, the algorithmic decider re-read 0.9 times per run against
Jev's 0.0 and cost 7% more; it still re-read half as often as the built-in
summary and needs no key. Jev stays the default; `provider: "algorithmic"` is
the choice without a decision-model key, and `openai` for an OpenAI account.

## Limits

- Task success: every arm passed every task, so these tasks do not separate the
  arms on success. The signal is in re-reads, repeated calls, time and cost.
- Synthetic tasks: one generated project, whose context grows fast (about 6,000
  tokens per model request, from large file reads). Real sessions grow slower
  and carry more prose.
- Small samples: 6 to 27 runs per cell. Cost differences under about 5% are
  within the run-to-run spread.

## Reproducing

```bash
git clone https://github.com/CrazyCoder/jetcompact-eval
cd jetcompact-eval
node fixtures/build-ledger.mjs && node fixtures/check-reference.mjs
git -C ../jetcompact worktree add ../jetcompact-ab v0.11.0
WINDOW=150000 REPS=3 PARALLEL=5 VARIANTS=window150 PLUGIN_DIR=../jetcompact-ab harness/run-all.sh
node harness/analyze.mjs && node harness/tradeoff.mjs
```

The runs behind this page cost about $150 of Claude usage.
