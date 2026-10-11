# Changelog

All notable changes to this fork are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.12.0]

### Changed

- Compactions cut harder by default. Prose older than the last 4 user turns
  (`recentTurns`, was 8) becomes a digest at every compaction, instead of only
  when verbatim prose would be refused; `keepResultTokens` is 6000 (was 12000)
  and `keepCallTokens` 2000 (was 4000). In a replay of 30 large real sessions, a
  compaction kept 36% of the context instead of 70%, and the share of cut
  results needed again later went from 2.2% to 3.1%; `recall` reads them back.
  Set `oldProse: "keep"`, `recentTurns` and the budgets to keep more. Why these
  values: README, "How hard a compaction cuts"; numbers in `docs/evals.md`.
- `targetPercent` is a goal, not a reason to give up. An automatic compaction
  that misses it after the harder cut, but frees `minReductionRatio`, applies
  its own result; the built-in summary runs only when JetCompact cannot free
  that much or the decision model fails. In 0.11.0, at a small compaction
  window, most compactions went to the built-in summary and took about 25 s; now
  they take under 2 s at the same cost.
- The harder cut (half budgets, 100-character heads) is only the second attempt
  of a compaction; it no longer applies to every compaction once the session
  holds an earlier cut.

### Added

- `tools/replay` takes `--options <json>` to replay sessions with other
  compaction options, such as the keep budgets or `decider: "algorithmic"`.

## [0.11.0]

### Added

- [Evals](docs/evals.md): A/B runs against Claude Code's built-in summary on
  nine coding tasks, with a cost model of compacting harder or lighter. The
  harness is [jetcompact-eval](https://github.com/CrazyCoder/jetcompact-eval).
- `provider: "algorithmic"` (library `decider: 'algorithmic'`): compaction with
  no decision model and no key. Calls are scored from the transcript alone,
  after pi-vcc's ranking and pi-blackhole's error tracking: superseded reads,
  repeated calls and older todo lists near 0, resolved errors low, open errors
  kept, search output lower, test and build output higher.
- `ageCutResults` (default off): a result an earlier compaction cut to a head
  keeps only its cut note at the next compaction.
- `questionCriteria` (default off): each decision question gets true/false
  criteria for what is worth keeping.

### Changed

- Before an automatic compaction falls back to the built-in summary, a harder
  cut is tried: the keep budgets halve and heads shrink to 100 characters.
  Identical Jev requests within one compaction are sent once; an error status is
  asked again.
- Once a session holds a cut from an earlier compaction, every compaction cuts
  that hard from its first attempt, so a long session keeps less context per
  compaction and compacts less often. The first compaction stays light.
- A `/compact` you type is applied whenever it frees anything; the size guards
  hold back only automatic compactions. The `/compact` the plugin queues in a
  headless session carries `automatic, from jetcompact` and stays automatic.
  (ferrisworks bd4a01d)
- When Claude Code moves on (Esc, another hook settling first), the in-flight
  request is abandoned and nothing is returned or delegated. When the hook runs
  over Claude Code's time budget, or Claude Code refuses its result, that is
  logged and the built-in summary runs where `builtinFallback` allows it.
  (k-metehan 18f69f8, 0f4ca22)
- When the built-in summary fails after a fallback, the plugin installs its own
  result if that freed anything. (deadczarvc a45402e)

### Fixed

- `compactAtPercent` and `targetPercent` count against the window Claude Code
  compacts at (`CLAUDE_CODE_AUTO_COMPACT_WINDOW` or a setting when set), not the
  model's whole window. With a smaller compaction window, or on a 1M model, the
  plugin asked for compaction late and the size target never applied.
- The estimate of the context after a compaction keeps the system prompt, tools
  and memory files as they are; it shrank them with the messages, so it came out
  low.
- A stubbed call's input is cut on a code point boundary, so an emoji is never
  split. (k-metehan 11bd2be)

## [0.10.0]

First release of JetCompact, a fork of fast-jev-compaction based on
QuanticPotatoes 0.8.0. The plugin id is `jetcompact`; its markers, data folder
(`~/.claude/jetcompact/`) and qmd index (`jetcompact-sessions`) carry the name.

### Added

- `recall` (default on): the model gets a `recall` tool
  (`mcp__jetcompact__recall`) over the session transcript, with `query` (BM25 or
  regex), `expand` (by `#N` or tool_use_id, the uncut result, saved large
  outputs included), `range` and `touched` (files changed, or every call on a
  file), in answers of at most 48k characters; `agent` runs a request on
  subagent transcripts, `sessions` searches past sessions of this project,
  another or all (`project`), and `session` runs a request on one of them; with
  qmd installed that search uses a qmd index of the sessions
  (`sessionIndex: auto`, default; `off` always scans). Cut notes name the recall
  call instead of "re-run the tool" (`recallNotes` in the library).
- `/recall-index`: shows the session index, builds it now for all projects or
  the ones named by name part, path, folder or `.`, takes projects out of it, or
  removes it.
- A cross-session search that covers this session's project ends with how many
  matches this session holds, since its hits leave this session out.
- Recall guidance: the recall tool is kept in the prompt's tool list instead of
  behind ToolSearch; a digest or summary header says recall reads its turns
  back; and a compaction that cut anything opens the history with one
  `[jetcompact note]` saying what it cut and to use recall before re-running a
  tool, replaced by the next compaction (`recallNotes` in the library;
  `withoutCompactionNote` strips it).
- `tools/node.cmd`: a pinned Node.js, downloaded from nodejs.org and checked by
  SHA-256 on first use, which runs the recall tool; CI checks the line endings
  of the `.cmd` files and runs the wrapper on Linux, macOS and Windows.
- Each compaction outcome, and each `/compact` queued in a headless session, is
  appended as one line to
  `<CLAUDE_CONFIG_DIR or ~/.claude>/jetcompact/compactions.log` (newest 200
  lines).
- Hidden content (skill bodies, prompts typed while a tool ran, attachments,
  images and ToolSearch-loaded tools) is read from the conversation's API form
  and folded back as text into the handle-stripped rows; images and deferred
  tools become placeholders. The session context and the reminders the host
  re-sends or that describe a past moment (token countdown, output style,
  task-tool nudge, deferred tool list, MCP instructions, editor diagnostics,
  file-changed notes) are skipped, and removed from rows an earlier compaction
  folded them into.
- `maxConcurrentRequests` (default 4); a 429 or 5xx is retried once after 1 s;
  no further request starts after a 401, 403 or no answer; the calls of a
  request that still failed are kept and counted in `stats.requestsFailed`.
- `/compact <instructions>` reach Jev's goal (`instructions` option, capped at
  2000 characters).
- `provider: "openai"`: OpenAI's Decisions API (`gpt-6-luna`, key from
  `OPENAI_API_KEY`) instead of Jev. Jev stays the default.

### Changed

- Releases are made by pushing a version tag (`v0.10.0`); a push to `main` no
  longer releases. The Release workflow checks that the tag matches every
  declared version, then publishes the library to npm as `jetcompact` (trusted
  publishing, with provenance) and the GitHub release.
- Diagnostics (outcome line, per-call decisions, redaction count, skipped
  auto-compacts) go to the debug log only; the user sees one short toast.
- Type reference from Claude Code 2.1.292.
- Marketplace renamed to `crazycoder`.
- Adaptive prose digest: with `oldProse` unset, each compaction keeps old prose
  verbatim while that clears the size guards; when it would be refused, it
  digests old prose instead (`truncateHeadChars` 100 unless set), within the
  same `compactionTimeoutMs`, and later compactions start with the digest while
  it is in the conversation. Long sessions no longer climb until every
  compaction is refused, and short ones keep their prose verbatim. `oldProse`
  and `truncateHeadChars` no longer have manifest defaults: if your saved plugin
  options hold `oldProse: "keep"` or `truncateHeadChars: 300` only because an
  earlier install stored the defaults, remove them to get the adaptive default.

### Fixed

- `oldProse: summarize` always fell back to the digest on Claude Code 2.1.292+,
  where `$.model.complete` returns a result object instead of a string.

## [0.8.0]

### Added

- `oldProse` (`keep` default, `digest`, `summarize`) and `recentTurns` (default
  8): the history is split at the start of the `recentTurns`-th last user turn
  and everything before it is replaced by one user message (a digest or a
  summary) plus a one-line assistant acknowledgement. The recent suffix goes
  through the usual pruning. The cut always falls on a user turn, so a tool_use
  and its tool_result stay on the same side; the first message becomes the
  digest, so it is the pinned one.
  - `digest`: deterministic and offline. Keeps the first prompt (2000 chars),
    then per turn the user prompt (400) and the assistant's final reply (500),
    tool names with counts, and a footer of the paths, URLs, ticket ids, PR
    numbers and shas mentioned. Tool results and intermediate narration are
    dropped. Capped at 12000 chars (oldest entries after the first prompt go).
  - `summarize`: one `$.model.complete` call through the session's own client
    (`proseModel`, default `haiku`, 3000 tokens), over the old prose and tool
    names; falls back to the digest when the call fails or comes back empty.
    Counts against `compactionTimeoutMs`.
  - A digest or summary from an earlier compaction is folded in (digest entries
    and references merged, a summary passed to the summarizer as the previous
    one), never chained, so its size stays bounded.
- `proseModel` plugin option; `oldProse*` fields in `CompactResult.stats`; the
  hook's summary line reports the old-prose replacement.
- Exports: `condenseOldProse`, `splitOldProse`, `buildDigest`,
  `buildSummaryPrompt`, `parseCondensed`, `collectReferences`.

## [0.7.0]

### Added

- `taskResultHeadChars` (default 4000, 0 = trim like the rest): a trimmed
  `<task-notification>` keeps `task-id`, `status`, `summary`, `output-file` and
  `tool-use-id` whole and its `<result>` (a subagent's final report, not
  reproducible) up to this budget; `<event>`, `<usage>` and other bulk collapse
  into one marker.
- `trimHostText` (default true) and `hostTextHeadChars` (default 200): outside
  the pinned recent messages, host-generated blocks in user turns
  (`<system-reminder>`, `<task-notification>`, local and `!` command echoes and
  output, untagged hook output) are cut to their head plus a
  `[fast-jev-compaction trimmed N chars of host notice]` marker. Recognition is
  by complete tag pairs or an anchored hook header only; free prose is never
  trimmed. Upstream issue #70 measured 54% of retained user text as host text,
  the main source of the rising post-compaction floor.
- The Jev goal is built from user text with host blocks removed, so `/compact`
  echoes and reminders no longer steer the keep decisions.
- The compaction summary line reports host notices trimmed.

## [0.6.0]

Changes relative to ferrisworks 0.5.4, the base of this fork.

### Added

- `keepMode: 'rank'` (new default) with `keepResultTokens` (12000) and
  `keepCallTokens` (4000): keep the best-scored tool results and inputs within
  token budgets instead of applying an absolute threshold, which kept 0 calls on
  measured sessions because Jev scores are compressed. `keepMode: 'threshold'`
  restores the previous behavior.
- `targetPercent` (default 45): when the estimated context after compaction
  would still exceed this percentage of the window, the Jev result is given up
  (built-in summary on automatic compactions, skipped otherwise).
- Regression test for headless sessions (upstream PR #125).
- Surrogate pairs kept whole when cutting text for the Jev state, plus a request
  backstop for lone surrogates (upstream PR #132).
- CI workflow (typecheck, tests, version consistency, version-bump check on pull
  requests), `scripts/check-version.mjs`, and a release workflow that tags and
  publishes a GitHub release for each new version on `main`.

### Changed

- Rebranded as the QuanticPotatoes fork: marketplace name, install commands and
  fork documentation.
- Version bumped to 0.6.0 so Claude Code delivers these changes: it updates an
  installed plugin only when its version string changes.

## [0.5.4]

ferrisworks/fast-jev-compaction 0.5.4, the integration base. See the README's
"About this fork" for what it merged from upstream.
