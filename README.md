# JetCompact

Claude Code plugin that replaces the compaction summary with the decisions of a
fast decision model. The newest turns stay verbatim, every older tool call and
result is scored by the model and kept or cut accordingly, host notices are
trimmed, and old prose can be condensed into a digest. The model is TypeSafe's
[Jev](https://typesafe.ai) by default, or OpenAI's Decisions API
(`provider: "openai"`), or no model at all (`provider: "algorithmic"`). Nothing
is lost: the `recall` tool reads back what a compaction cut, and searches your
past sessions.

In A/B runs against the built-in summary, a compaction took 0.7 s instead of 25
s and the model re-read fewer files after it; a session that compacts once cost
13% less, and one that compacts repeatedly in a small window cost the same. See
[Evals](docs/evals.md).

JetCompact is a fork of
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction). It
combines the most useful work from that project's many forks with its own; the
full lineage is under [Features and credits](#features-and-credits).

## Why this fork

I used [pi-vcc](https://github.com/sting8k/pi-vcc) in Pi for some time and liked
how fast its compaction is compared to the stock summary. Speed was the main
factor for me. When Jev came out, fast-jev-compaction brought it to Claude Code
as a mod. The next day
[Theo posted about it](https://x.com/theo/status/2100762304862384257), and his
post started a debate. I wanted the speed, so I tried it anyway. It had many
issues, and the author stopped merging fixes, so I forked it to fix them. On the
way the project turned into an experiment, with [evals](docs/evals.md) against
Claude Code's built-in summary. Try it, and send feedback and suggestions as
issues.

### Questions from Theo's post

Theo's post is about the original fast-jev-compaction. Other users may have the
same questions, so here is how JetCompact answers them.

| Concern | JetCompact |
| -- | -- |
| Compaction should be rare, not a constant filter. | It runs only when Claude Code would compact anyway: at `compactAtPercent` of the compaction window, or on `/compact`. |
| The decision model decides per tool call without seeing the output, so the agent loses what it needs and loops. | A cut result keeps its first few hundred characters, the transcript is never deleted, and the `recall` tool returns the full output by its id. After each compaction, the model gets a note that says what was cut and tells it to use `recall` before it runs a tool again. In the evals the model re-read 0.8 files per run after a compaction, against 2.1 with the built-in summary. |
| The output is "deleted permanently", so the agent must re-run the tool. | That is the original's README. JetCompact deletes nothing from the transcript, and `recall` reads it back. |
| Reasoning traces are lost. | Every compaction loses them: the built-in summary replaces the whole history, reasoning included. JetCompact keeps the prompts, the replies and the kept tool output word for word, but no reasoning blocks either. |
| Models are trained on their own compaction summary. | Not measured directly. In the evals every arm finished every task, so these tasks do not separate the two on success. |
| Editing history invalidates the prompt cache. | Every compaction rewrites the cache, the built-in one too. The trade-off of JetCompact is that it keeps more context, so later turns read more from the cache and the next compaction comes sooner. `targetPercent` caps what a compaction keeps. In the evals, sessions that compacted once cost 13% less, and sessions that compacted several times in a small window cost the same. |

## Added in JetCompact

| Feature | What it does | Origin |
| -- | -- | -- |
| Quiet output | Diagnostics, including the per-call decisions, go to the debug log only; you see one short toast instead of a wall of text in the transcript | k-metehan (6bb138d) |
| Compaction log file | Each outcome, and each `/compact` queued in a headless session, is one line in `~/.claude/jetcompact/compactions.log` (newest 200), since the desktop app has no `--debug` | k-metehan (aa912a9) |
| Hidden content folded back | Kept messages go back without their engine handles so `--resume` starts at the compaction ([#89](https://github.com/tamaratran/fast-jev-compaction/issues/89)). That drops what Claude Code keeps beside each message: skill bodies, prompts typed while a tool ran, attachments, images, ToolSearch-loaded tools. The hook reads them from the conversation's API form and folds them back as text (placeholders for images and deferred tools), counted in the size guards | JetCompact. k-metehan identified the loss and keeps handles instead, which brings #89 back |
| Request policy | At most `maxConcurrentRequests` (4) Jev requests at once; one retry on 429/5xx; no further requests after 401/403 or no answer; a failed request's calls are kept and the rest is applied, with the reason in the log | k-metehan (de21417, 06163e6, b2a3d4c) |
| `/compact` instructions | Text typed after `/compact` reaches Jev's goal (first 2000 characters) | k-metehan (3019dab, 10e00ab) |
| OpenAI Decisions provider | `provider: "openai"` asks [OpenAI's Decisions API](https://developers.openai.com/api/docs/guides/decisions) (`gpt-6-luna`, key from `OPENAI_API_KEY`) instead of Jev; Jev stays the default, and the Jev `apiKey`/`baseUrl` never reach OpenAI | [deadczarvc-labs/jev-factkeep-compaction](https://github.com/deadczarvc-labs/jev-factkeep-compaction) (235a6c6) |
| Recall tool | The model gets a `recall` tool over the session transcript, which compaction never deletes from: search it (`query`, ranked or regex), read entries in full by `#N` or tool_use_id (`expand`, the uncut result, following outputs Claude Code saved to a file), list them (`range`), or see which files the session changed and every call on a file (`touched`), in answers of at most 48k characters; `agent` does the same inside subagent transcripts. It runs on a pinned Node that `tools/node.cmd` downloads and verifies on first use, so nothing needs installing. `recall: false` turns it off | Ranking, regex mode and the touched view from [pi-vcc](https://github.com/sting8k/pi-vcc); answer budget from [pi-blackhole](https://github.com/k0valik/pi-blackhole); Node wrapper from [intellij-community](https://github.com/JetBrains/intellij-community/tree/master/tools); transcript reader: JetCompact |
| Past-session search | `sessions` searches the other sessions of this project, another one (`project: "billing-api"`) or all of them, and `session` opens one: "do it the way we did in the billing-api session" finds that session. The current session's matches are counted on a last line. With [qmd](https://github.com/tobi/qmd) installed, the search goes through an index of the sessions, which `/recall-index` builds for all projects or the ones you name by name, path or folder. Details: [Searching past sessions](#searching-past-sessions) | JetCompact |
| Recall guidance | The model is told what compaction cut and how to get it back, at the points where it matters and never on every prompt: the recall tool stays loaded instead of behind ToolSearch, each cut note names the `recall expand` call that returns the rest, a digest or summary says recall reads its turns back, and one note at the top of the compacted history says what this compaction cut and to use recall before re-running a tool or saying something is gone. Each compaction replaces that note. Details: [What the model is told](hooks/README.md#what-the-model-is-told) | JetCompact |
| Adaptive prose digest | Each compaction keeps your old prose verbatim while that frees enough. When it would be refused, as happens after two or three compactions in a long session, the prose older than `recentTurns` becomes a digest (cut results keep 100-character heads), and later compactions start with the digest, so multi-day sessions keep compacting instead of getting stuck. Pros, cons and options: [Adaptive prose digest](#adaptive-prose-digest) | JetCompact; the digest is QuanticPotatoes' `oldProse: digest` |
| Harder cut | Before an automatic compaction gives up to the built-in summary, one more attempt halves the keep budgets and cuts to 100-character heads; see [Adaptive prose digest](#adaptive-prose-digest) | JetCompact |
| Algorithmic provider | `provider: "algorithmic"` decides with no model and no key, by rules after [pi-vcc](https://github.com/sting8k/pi-vcc) and [pi-blackhole](https://github.com/k0valik/pi-blackhole): superseded reads, repeated calls and fixed errors go first; open errors and edits stay | JetCompact |
| Typed `/compact` applies | A `/compact` you type is applied whenever it frees anything; the size guards hold back only automatic compactions | ferrisworks (bd4a01d) |
| Stops when Claude Code moves on | Esc or another hook settling first abandons the in-flight request; nothing is returned or delegated | k-metehan (18f69f8, 0f4ca22) |
| Own result when the summary fails | If Claude Code's built-in summary fails after a fallback, JetCompact installs its own result when that freed anything | deadczarvc (a45402e) |
| Compaction window | `compactAtPercent` and `targetPercent` count against the window Claude Code compacts at (`CLAUDE_CODE_AUTO_COMPACT_WINDOW` or a setting), not the model's whole window, so the plugin compacts at your setting and on 1M-token models | JetCompact |
| Evals | A/B runs against the built-in summary on graded coding tasks, with a cost model; see [Evals](docs/evals.md) and [jetcompact-eval](https://github.com/CrazyCoder/jetcompact-eval) | JetCompact |
| Claude Code 2.1.292 types | `$.model.complete` returns an object since 2.1.292, which had silently broken `oldProse: summarize` | JetCompact |

k-metehan is
[k-metehan/fast-jev-compaction](https://github.com/k-metehan/fast-jev-compaction).

How the adaptive prose digest decides, what it costs and how to control it is
under [Adaptive prose digest](#adaptive-prose-digest).

## Install

Function hooks are an early-access Claude Code feature (2.1.292+). Set the flag
and your key where Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

```sh
claude plugin marketplace add CrazyCoder/jetcompact
claude plugin install jetcompact@crazycoder
```

Restart Claude Code or run `/reload-plugins`. `/compact` and auto-compaction now
go through Jev; a one-line toast reports the outcome
(`jetcompact: compacted, N% smaller`, `built-in summary (…)`, or
`not compacted (…)`). The details, including the per-call decisions, go to the
debug log only (`claude --debug`), never into the transcript, and each outcome
is also one line in `~/.claude/jetcompact/compactions.log`.

**Updating.** Claude Code updates a plugin only when its version changes. Set
`autoUpdate: true` on the marketplace entry, or run
`claude plugin marketplace update crazycoder`.

To try it from a checkout:
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`

**Developing.** To have every session, including the desktop app's Code tab, run
the plugin from a checkout, add the checkout as a local marketplace and install
from it. Claude Code then reads the plugin from the checkout itself: an edit
takes effect in new sessions, and in open ones after `/reload-plugins`, with no
version bump or reinstall.

```sh
claude plugin marketplace add /path/to/jetcompact
claude plugin install jetcompact@crazycoder
```

Disable any other compaction plugin first, such as fast-jev-compaction or
another of its forks
(`claude plugin disable fast-jev-compaction@<marketplace>`), so only one
compaction hook runs.

## Configure

Options are asked at install time and live under `pluginConfigs`. The ones most
people touch:

```json
{
  "pluginConfigs": {
    "jetcompact@crazycoder": {
      "options": {
        "compactAtPercent": 60,
        "recentTurns": 8,
        "builtinFallback": "auto"
      }
    }
  }
}
```

| Option | Default | Effect |
| -- | -- | -- |
| `compactAtPercent` | `60` | Context percentage at which the plugin asks for a compaction, of the window Claude Code compacts at (`CLAUDE_CODE_AUTO_COMPACT_WINDOW` when set, else the model's) |
| `oldProse` | unset: [adaptive](#adaptive-prose-digest) | Prose older than `recentTurns` user turns: `keep` verbatim, `digest` (offline, deterministic) or `summarize` (written by `proseModel`). Unset, verbatim until that would be refused, then the digest |
| `recentTurns` | `8` | User turns kept outside the digest or summary |
| `builtinFallback` | `auto` | Which compactions fall back to Claude Code's built-in summary when Jev fails or frees too little: `auto` (only its own automatic one), `always`, `never`. Use `always` if Claude Code's own autoCompact is disabled, so `/compact` and plugin requests still get a summary |
| `targetPercent` | `45` | Gives up the Jev result if the estimated context after compaction would still exceed this percentage |
| `minReductionRatio` | `0.25` | Minimum estimated reduction required to replace the history |
| `keepMode` | `rank` | `rank` keeps the best-scored calls within `keepResultTokens` / `keepCallTokens`; `threshold` uses `keepThreshold` |
| `preserveRecentMessages` | `6` | Newest messages never touched |
| `provider` | `jev` | Who scores the calls: `jev` (TypeSafe Jev), `openai` ([OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions), `gpt-6-luna`, key from `OPENAI_API_KEY`), or `algorithmic` (no model and no key: rules after pi-vcc and pi-blackhole, see [hooks/README.md](hooks/README.md#configuration)). Luna's probabilities are on a different scale from Jev's, so `keepThreshold` and the rank budgets may need retuning |
| `ageCutResults` | `false` | A result already cut by an earlier compaction keeps only its cut note at the next one |

To score with OpenAI's Decisions API instead of Jev, set `provider` and give the
key through `OPENAI_API_KEY` in the environment, in the settings' `env` block,
or in a dotenv file:

```json
{ "options": { "provider": "openai", "envFile": "C:/path/to/.env" } }
```

Every option, with its default, is listed in
[hooks/README.md](hooks/README.md#configuration).

## Adaptive prose digest

Each compaction cuts tool calls, tool results and host notices first and keeps
your old prompts and the assistant's replies verbatim. That is enough for a
session that compacts once or twice. In a long session the kept prose
accumulates: each compaction ends higher than the last, and after two or three
the result frees less than `minReductionRatio` or still leaves more than
`targetPercent`, so every later compaction is refused.

With `oldProse` unset, the hook then computes the compaction again with the
**digest**: everything older than the last `recentTurns` user turns (8) becomes
one message of at most 12,000 characters, and cut results keep 100-character
heads instead of 300. Only a session with turns older than `recentTurns` has
anything to digest; otherwise the refusal stands. Once a compaction has used the
digest, the next ones start with it, since the conversation holds it, also after
a restart or `--resume`. A new session, or one whose history Claude Code's
built-in summary replaced, starts verbatim again.

When that is refused too, a **harder cut** is tried before an automatic
compaction falls back to Claude Code's built-in summary: `keepResultTokens` and
`keepCallTokens` halve, and cut results keep 100 characters. Once the
conversation holds a cut from an earlier compaction, every compaction starts
that hard. This is the case of a compaction soon after a light one, where the
first attempts keep everything the previous compaction kept. It asks Jev nothing
new when only the budgets change.

The digest keeps the first prompt (up to 2,000 characters), each later prompt
(up to 400), the assistant's final reply of each turn (up to 500), the tool
names used per turn with counts, and the paths and ids mentioned. It drops the
tool calls and results of those turns and the narration between them. Each
digest folds the previous one in, so it does not grow with the session; the
oldest turns are left out first when it is full. The `recall` tool reads every
original message, call and result back from the transcript.

**Pros**

- Sessions that compact once or twice keep their prose word for word, as they
  would with `oldProse: keep`.
- Long sessions keep compacting instead of getting stuck. Replaying six real
  sessions, from a few compactions to a multi-day one with 34,000 messages: with
  verbatim prose every long session was refused from the second or third
  compaction on; with the adaptive default none was. The multi-day one compacted
  38 times: the first three verbatim (27%, 37%, 43% of the context left), every
  later one between 4% and 26%.
- The switch needs no setting: each session gets verbatim prose until it needs
  the digest.

**Cons**

- Old turns survive only as digest lines: an instruction or preference you gave
  more than `recentTurns` turns ago is cut to 400 characters, and an
  intermediate reply is gone. Repeat what still matters, or put it in
  `CLAUDE.md`.
- Old tool calls leave no stubs, only counts. The model has to call `recall` to
  see them again; the digest header and the compaction note tell it to, but it
  does not always follow. On a replay of real sessions the share of cut content
  that was needed later rose from 1.0% to 1.7% with the digest.
- The compaction that switches runs Jev twice, once per pass, and both passes
  share one `compactionTimeoutMs`; with a slow Jev the second pass can time out
  and the compaction follows `builtinFallback`.
- A session that switched stays on the digest while the digest is in the
  conversation; it does not go back to verbatim prose.

**Controlling it**

| Option | Effect on the adaptive digest |
| -- | -- |
| `oldProse` | Unset: adaptive. `keep`: never digest (long sessions may get stuck; `builtinFallback` then decides). `digest`: digest from the first compaction. `summarize`: a summary written by `proseModel` from the first compaction |
| `recentTurns` | User turns kept verbatim outside the digest (8) |
| `truncateHeadChars` | Head of a cut result: 300, or 100 once the adaptive digest is in use; a set value is used throughout |
| `minReductionRatio`, `targetPercent` | The guards whose refusal triggers the switch (0.25, 45) |
| `recall` | Keep it on (the default) so the model can read digested turns back |

Each outcome line in `~/.claude/jetcompact/compactions.log` names the prose mode
used (`old prose digest: …`), and ends with `verbatim prose was refused (…)` on
the compaction that switched.

## Searching past sessions

The `recall` tool also searches your other sessions, so you can ask "see how we
set up jscpd in the billing-api session and do the same here". The model calls
it with `sessions: "<keywords>"`, in this project by default, in another with
`project: "<part of its name or path>"`, or in all with `project: "all"`. The
current session is not among the hits, since recall searches it directly; when
the searched projects include it, a last line says how many matches it holds.

There are two ways to search, and recall picks one for you:

- **Transcript scan** (no setup): reads the session transcripts under
  `~/.claude/projects/` directly, with ripgrep when it is installed to pick the
  files. Fast enough for one project; across many projects a broad query can
  take seconds.
- **Session index**: with [qmd](https://github.com/tobi/qmd) installed
  (`npm install -g @tobilu/qmd`; recall never installs it), each session is
  exported as markdown (prompts, replies, calls with the head of their results)
  to `~/.claude/jetcompact/sessions/` and indexed in a qmd index of its own,
  `jetcompact-sessions`, apart from your other qmd collections. Searches across
  many projects then stay fast, and hits are ranked across sessions. The exports
  and the index are readable by you only, and an export goes when Claude Code
  deletes its transcript.

Without any command, the first cross-session search builds the index for all
projects in the background (that search is answered by the scan), and every
later search adds the sessions that changed. To build it yourself, or for some
projects only, use `/recall-index`:

| You want to | Run |
| -- | -- |
| See what is indexed | `/recall-index` |
| Index every project | `/recall-index all` |
| Index this project | `/recall-index .` |
| Index a project by name or path | `/recall-index billing-api` or `/recall-index C:\work\billing-api` |
| Index every project under a folder | `/recall-index C:\work` |
| Take a project out | `/recall-index remove billing-api` |
| Delete the index and exports | `/recall-index remove` or `/recall-index remove all` |

Names match any part of a project's folder name; paths take any slash style or
case, `~/…`, or a path relative to this project. Several targets can be given,
separated by spaces or commas; quote a path with spaces. The command waits for
the build and reports the sessions, projects, time and index size. Once you
choose projects, only those are indexed and kept up to date; a search elsewhere
uses the scan. An index that covers all projects, including the one a search
built on its own, keeps covering all of them when you name one: to index only
some, run `/recall-index remove` first. `sessionIndex: "off"` turns the index
off. The details are in [hooks/README.md](hooks/README.md#recall-index).

## How it works

```
history ─┬─ first + newest messages ─────────────── pinned, verbatim
         ├─ tool calls ── Jev scores each call and result
         │                 ├─ best results, within keepResultTokens ─ kept verbatim
         │                 ├─ best calls, within keepCallTokens ──── input + truncated result
         │                 └─ the rest ───────────────────────────── stub note (dropCalls: false)
         ├─ host notices (<system-reminder>, hook output, …) ──────── cut to a short head
         └─ prose older than recentTurns ─ keep, or digest (adaptive)
              ▼
   reduction < minReductionRatio, or estimated floor > targetPercent
              ├─▶ prose still verbatim: try again with the digest
              └─▶ else builtinFallback: built-in summary, or leave history unchanged
```

Jev scores are compressed (`keepCall` rarely exceeds 0.3), so the default `rank`
mode ranks calls instead of using an absolute threshold. Jev sees the whole
conversation with tool outputs replaced by a one-line note, fitted into
`maxStateTokens`. Your own prose is kept verbatim while cutting tool calls, tool
results and host-generated notices frees enough. When it does not, prose older
than `recentTurns` user turns becomes a digest, and later compactions start with
it; `recall` reads the originals back. Set `oldProse` to fix the choice (`keep`,
`digest` or `summarize`). The full algorithm is in
[docs/library.md](docs/library.md#algorithm-in-detail).

## Features and credits

Lineage:
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(upstream, no push since 2026-09-18, about 60 unmerged PRs) →
[ferrisworks/fast-jev-compaction](https://github.com/ferrisworks/fast-jev-compaction)
(integration fork that merged about 13 of them) →
[QuanticPotatoes/fast-jev-compaction](https://github.com/QuanticPotatoes/fast-jev-compaction)
→ JetCompact, which also takes ideas and code from
[k-metehan/fast-jev-compaction](https://github.com/k-metehan/fast-jev-compaction)
and
[deadczarvc-labs/jev-factkeep-compaction](https://github.com/deadczarvc-labs/jev-factkeep-compaction).
Thanks to all of them, and to the authors of the upstream PRs linked below. What
JetCompact adds is listed under [Added in JetCompact](#added-in-jetcompact).

### Inherited from QuanticPotatoes and ferrisworks

- **Auto-compaction in the desktop app and `claude -p`.** Those sessions refuse
  `$.session.compact`, so the `compactAtPercent` trigger queues `/compact`
  instead (upstream PR
  [#111](https://github.com/tamaratran/fast-jev-compaction/pull/111)).
- **Rank-based keeping.** Measured on 4,603 decisions over 60 sessions,
  `keepCall` was about 0.1–0.3 (max 0.58), so the absolute 0.5 threshold kept 0
  calls (upstream issues
  [#56](https://github.com/tamaratran/fast-jev-compaction/issues/56),
  [#26](https://github.com/tamaratran/fast-jev-compaction/issues/26),
  [#52](https://github.com/tamaratran/fast-jev-compaction/issues/52)).
- **`targetPercent`.** Because all message text was kept, the floor rose with
  each compaction (reduction 77% → 30% within one session; upstream issue
  [#70](https://github.com/tamaratran/fast-jev-compaction/issues/70) reports 36K
  → 87K tokens over 6 rounds).
- **Host-text trimming** (`trimHostText`): notices were about 54% of the
  retained "user" text per issue #70 (idea from upstream PR
  [#78](https://github.com/tamaratran/fast-jev-compaction/pull/78)).
- **Prose digest and summary** (`oldProse`).
- **Stubbed instead of deleted calls** (`dropCalls: false`): a silent drop led
  the model to report work it never did
  ([#65](https://github.com/tamaratran/fast-jev-compaction/issues/65), PR
  [#83](https://github.com/tamaratran/fast-jev-compaction/pull/83)).
- **Robustness from ferrisworks:** secret redaction
  ([#98](https://github.com/tamaratran/fast-jev-compaction/pull/98)), handles
  stripped so `--resume` works
  ([#89](https://github.com/tamaratran/fast-jev-compaction/issues/89)), subagent
  and speculative compactions skipped
  ([#112](https://github.com/tamaratran/fast-jev-compaction/pull/112)),
  code-point-safe truncation
  ([#110](https://github.com/tamaratran/fast-jev-compaction/pull/110)), Jev wait
  bound ([#117](https://github.com/tamaratran/fast-jev-compaction/pull/117)),
  auto-only built-in fallback
  ([#103](https://github.com/tamaratran/fast-jev-compaction/pull/103)), plus
  headless-session and surrogate-pair tests (upstream PRs
  [#125](https://github.com/tamaratran/fast-jev-compaction/pull/125),
  [#132](https://github.com/tamaratran/fast-jev-compaction/pull/132)).
- **CI and versioned releases**; see [CHANGELOG.md](CHANGELOG.md).

### Compared

|  | upstream 0.3.0 | ferrisworks 0.5.4 | QuanticPotatoes 0.8.0 | JetCompact |
| -- | -- | -- | -- | -- |
| Tool calls kept | Absolute 0.5 threshold | Same | Rank within token budgets | Same |
| Dropped calls | Deleted | Stub note | Stub note | Stub note |
| Size guard | Min 25% reduction | Same | Same + `targetPercent` | Same, hidden content counted, measured against the compaction window |
| Built-in fallback | Always | Automatic compactions only | Same | Same |
| Secret redaction | No | Yes | Yes | Yes |
| Host notices / old prose | Kept | Kept | Trimmed / optional digest | Trimmed / digest when verbatim is refused |
| Transcript output | Decision dump | Same | Same | One toast; debug log and log file |
| Hidden content after compaction | Kept on untouched rows (`--resume` reloads the old history) | Lost (no handles) | Lost | Folded back as text |
| Failed Jev request | Whole compaction falls back | Same | Same | Its calls kept, rest applied |
| Decision provider | Jev | Jev (any System One endpoint) | Same | Same + OpenAI Decisions, or rules with no model |
| What was cut | Gone from the conversation | Same | Same | `recall` tool reads it back from the transcript |
| Model told what was cut | No | No | No | Cut notes, digest header and one note per compaction point at recall |
| Past sessions | No | No | No | Searched by keyword, optionally through a qmd index |
| CI and releases | No | No | Yes | Yes |

Roadmap: fact salvage on dropped calls (upstream issues
[#118](https://github.com/tamaratran/fast-jev-compaction/issues/118),
[#105](https://github.com/tamaratran/fast-jev-compaction/issues/105)).

## Measuring

[jetcompact-eval](https://github.com/CrazyCoder/jetcompact-eval) runs the same
coding tasks headless with the built-in summary and with JetCompact, grades them
by hidden tests, and measures cost, re-reads after a compaction and compaction
time. The results are in [Evals](docs/evals.md).

`tools/replay` replays recorded sessions offline under different policies and
reports reduction, post-compaction floor, growth per compaction and a
lost-and-needed rate. See [tools/replay/README.md](tools/replay/README.md). The
evidence is limited: lost-and-needed is a token-reuse proxy computed offline,
not a measure of task success.

## Library, development, demo

The package is usable without Claude Code (`compactMessages`, your own
`JevAsker`, the building blocks): see [docs/library.md](docs/library.md).

```sh
npm install
npm run typecheck        # library + hook
npm test                 # fake Jev, no network; includes the duplicate code gate
npm run jscpd:list       # every clone (see docs/duplicate-code.md)
npm run test:hooks:host  # native hook dispatcher tests; requires Claude Code
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo   # live network check
```

### Releasing

A push to `main` never makes a release. To release a version:

1. Set the new version in `.claude-plugin/plugin.json`,
   `.claude-plugin/marketplace.json`, `package.json` and `package-lock.json`;
   `npm run check:version` confirms they agree.
2. Add its `## [x.y.z]` section to `CHANGELOG.md`, and commit.
3. Tag the commit and push the tag:

```sh
git tag vX.Y.Z
git push origin main vX.Y.Z
```

The Release workflow then checks that the tag matches every declared version,
publishes the library to npm as `jetcompact` (through npm trusted publishing,
after the typecheck, the tests and the build pass), and publishes a GitHub
release with the tag's CHANGELOG section as its notes. It fails, and publishes
nothing, when the versions disagree, the CHANGELOG section is missing, or a
check fails. Installed plugins update from the version on `main`, not from the
release, so push the version bump only when it is ready to ship.

`demo/JevDemo` is a native SwiftUI app (macOS) that plays a scripted, dramatized
compaction for screen recording; it never calls the API. `demo/JevDemo/build.sh`
builds and launches it; space replays.
