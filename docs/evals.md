# Evals: JetCompact against Claude Code's built-in summary

Claude Sonnet 5.5 finished every task with either compaction, so the difference
is in what a compaction costs and what the model does after it:

- **One compaction in a session** (a 150k compaction window): JetCompact cost
  13% less per run than the built-in summary ($0.73 against $0.84). The model
  re-read 0.8 files after compacting against 2.1, and a compaction took 0.7 s
  instead of 25 s.
- **Repeated compaction in a small window** (100k): the two cost the same ($0.89
  against $0.87). JetCompact re-read 0.8 files against 2.3, and a compaction
  took 1.8 s on average instead of 25 s.
- **Long real sessions** (a replay, no model runs): the 0.12 defaults keep about
  a third of the context instead of 70%, so a long session compacts less often.
  The cost model puts such a session at about $36, against $65 with the 0.11
  defaults and $45 with the built-in summary.

How hard to compact depends on many variables: the model, the window, how fast a
session grows, the cache TTL, how often the agent needs old output, and which
decision model ranks the calls. These evals cover part of that. More research
and evals are needed, and the [limits](#limits) below say where the evidence is
thin. The defaults that ship are the ones the evidence supports best; why each
was chosen is under
[How hard a compaction cuts](../README.md#how-hard-a-compaction-cuts).

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

On four of those tasks (`api-migration`, `csv-export`, `fix-bugs`, `discounts`),
8 runs each of later commits, against the 12 runs per arm above on the same
tasks:

|  | Built-in summary | `09b893e` | `7b4496d` (window fix) | `8ae477a` (target as goal) |
| -- | -- | -- | -- | -- |
| Claude cost per run | $0.84 | $0.79 | $0.73 | $0.76 |
| Re-reads after a compaction | 2.1 | 0.0 | 0.8 | 0.5 |
| Time per compaction | 25 s | 0.6 s | 0.7 s | 0.7 s |
| Context after a compaction | 49k | 67k | 59k | 60k |

## Repeated compaction

12 runs per arm at a 100k window on the two long tasks and two recall tasks,
which compacted 1 to 4 times each. The JetCompact columns ran at `09b893e` (0.11
before the window fix), `7cf973b` (a sticky harder cut, not shipped), `7b4496d`
(the window fix, 0.11.0) and `8ae477a` (the target as a goal):

|  | Built-in summary | `09b893e` | `7cf973b` | `7b4496d` | `8ae477a` |
| -- | -- | -- | -- | -- | -- |
| Tasks passed | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| Claude cost per run | $0.87 | $1.02 | $1.02 | $0.88 | $0.89 |
| Re-reads after a compaction | 2.3 | 1.2 | 0.8 | 1.6 | 0.8 |
| Cache writes per run | 121k | 176k | 181k | 123k | not compared |
| Context after a compaction | 44k | 58k | 58k | 45k | 53k |
| Time per compaction | 24.7 s | 2.4 s | 0.6 s | 25.2 s | 1.8 s |

Before the window fix, `targetPercent` (45) was compared with the fill of the
model's whole 200k window, so at a 100k compaction window it never applied:
JetCompact kept 58k, compacted more often, and every compaction rewrote the
prompt cache at that size. Measured against the compaction window, about 30k of
it is fixed (Claude Code's tools 24k, system prompt, skills), so the 45% target
leaves about 15k for messages. In 0.11.0 most compactions there went to the
built-in summary, which made them as slow as the summary. With the target as a
goal, a compaction that frees 25% applies its own result, so compactions stay
fast at the same cost. The 1.8 s mean includes a few compactions that freed less
than 25% and still fell back.

## Defaults for 0.12: replays of real sessions

How much a compaction keeps was measured offline on 30 large real sessions,
replayed through the library at the compaction points of a 200k window (120k
estimated tokens), with the algorithmic decider. A result is lost and needed
when a path or id from it was cut and a later tool call used it before anything
showed it again; `recall` gets it back.

| Setting | Kept | Floor | Floor growth per compaction | Compactions | Lost and needed | Per compaction |
| -- | -- | -- | -- | -- | -- | -- |
| 0.11 (prose verbatim, 12,000 / 4,000 budgets, 8 turns) | 70% | 88k | +21k | 184 | 2.2% | 1.4 |
| Budgets halved | 65% | 81k | +22k | 162 | 2.6% | 2.0 |
| Budgets halved, 150-char heads | 56% | 69k | +21k | 142 | 3.7% | 3.2 |
| Budgets quartered, 100-char heads | 49% | 60k | +21k | 128 | 4.4% | 4.2 |
| Budgets halved, prose digested, 8 turns | 48% | 59k | +13k | 129 | 2.8% | 2.0 |
| **Budgets halved, prose digested, 4 turns (0.12)** | **36%** | **44k** | **+6k** | **113** | **3.1%** | **1.6** |
| Budgets halved, prose digested, 2 turns | 27% | 33k | +0.5k | 102 | 3.6% | 1.4 |
| Budgets quartered, prose digested, 4 turns | 33% | 40k | +7k | 107 | 3.6% | 2.2 |
| Budgets quartered, prose digested, 2 turns, 100-char heads | 19% | 24k | +1k | 95 | 6.7% | 2.9 |
| Close to pi-vcc (no results kept, 1 turn, 100-char heads) | 11% | 14k | −3k | 89 | 11.8% | 4.1 |

The same replay on the 10 largest of those sessions, with live Jev against the
algorithmic decider:

| Setting | Decider | Kept | Compactions | Lost and needed | Per compaction |
| -- | -- | -- | -- | -- | -- |
| 0.11 | Jev | 70% | 90 | 1.9% | 1.5 |
| 0.11 | Algorithmic | 71% | 93 | 1.9% | 1.3 |
| 0.12 | Jev | 38% | 59 | 2.6% | 1.7 |
| 0.12 | Algorithmic | 40% | 59 | 2.0% | 1.2 |

What this shows:

- The budgets, not the decider, set how much is kept: Jev and the algorithmic
  decider kept the same share at the same settings.
- Digesting old prose is the cheapest cut: it freed as much as quartering the
  tool budgets, at less loss, and it keeps the floor from climbing.
- Short heads and empty budgets cost the most: losses doubled or tripled.
- With Jev, 0.12 loses a little more per compaction (1.7 against 1.5) but
  compacts a third less often and keeps about half as much context.
- In this replay Jev did not lose less than the algorithmic decider, while in
  the A/B runs the model re-read less after Jev's compactions (0.0 against 0.9
  per run). The replay's measure is a proxy and the sample is small, so which
  decider is better is open.

## The trade-off: compacting harder or lighter

A compaction that keeps more context leaves the model what it was working with,
so it re-reads and repeats less; but every later request reads that larger
context from the cache, the next compaction comes sooner, and each compaction
rewrites the cache at the new size. `tradeoff.mjs` in the eval repository fits
these per arm from the one-compaction runs and projects a 400-request session,
with Sonnet prices.

In a 200k window at a 60% trigger:

| Cache | Built-in summary | JetCompact `09b893e` |
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
40% kept cuts it by about 40%. Real sessions kept 70% with the 0.11 defaults, so
0.12 cuts harder: about 36% kept puts a long session near $36.

In a 1M window the same model puts the built-in summary at $76 and JetCompact
`09b893e` (57% kept) at $87; at 40% kept JetCompact is at $74, and at 30% at
$68. It charges every built-in summary as measured at about 150k context, so it
understates how slow a summary of 600k is. No session in the replay reached
600k, so the 1M case is projected, not measured.

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
- The 0.12 defaults were chosen from replays and the cost model, not from model
  runs: no A/B has run them yet.
- Synthetic tasks: one generated project, whose context grows fast (about 6,000
  tokens per model request, from large file reads). Real sessions grow slower
  and carry more prose.
- The replay's loss measure sees paths and ids reused by later tool calls, not
  instructions lost from digested prose.
- 1M windows are projected, not measured.
- Small samples: 6 to 30 runs or sessions per cell. Cost differences under about
  5% are within the run-to-run spread.

## Reproducing

```bash
git clone https://github.com/CrazyCoder/jetcompact-eval
cd jetcompact-eval
node fixtures/build-ledger.mjs && node fixtures/check-reference.mjs
git -C ../jetcompact worktree add ../jetcompact-ab v0.12.0
WINDOW=150000 REPS=3 PARALLEL=5 VARIANTS=window150 PLUGIN_DIR=../jetcompact-ab harness/run-all.sh
node harness/analyze.mjs && node harness/tradeoff.mjs
harness/replay-matrix2.sh ~/.claude/projects/<project-dir> 30
```

The model runs behind this page cost about $170 of Claude usage; the replays
cost none, except the Jev requests of the live-Jev replay.
