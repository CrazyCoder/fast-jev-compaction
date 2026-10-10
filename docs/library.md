# Library usage

The repository is also an npm package (`src/`). The Claude Code plugin in
`hooks/` is a thin adapter over it.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation. The
building blocks (`collectToolCalls`, `fitState`, `batchCalls`, `decideCall`,
`applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or put
it in a source file.

`baseUrl` picks the Jev endpoint. Left unset it is the TypeSafe one; the same
Jev model is also served through OpenRouter, at
`https://openrouter.ai/api/alpha/decisions`, with `model` left at `jev-latest`
and an OpenRouter key in place of a TypeSafe one.

`provider: 'openai'` on `compactMessages` or `JevClient` asks OpenAI's Decisions
API (`https://api.openai.com/v1/decisions`, `gpt-6-luna`) instead: the state
goes as text `input`, each `noul` question as a named `predicate`, and a refusal
answers 1 (keep). `buildDecisionsRequest`, `parseDecisionsResponse` and
`wireFor(provider)` are the request and response halves for your own transport.

`hiddenContent(rows, apiView)` and `foldHiddenContent(messages, hidden)` are
what the Claude Code hook uses to put back the hidden entries (skill bodies,
prompts typed during a tool, attachments) that rows returned without their
engine handle lose; see [hooks/README.md](../hooks/README.md).

## Options

| Option | Default | Description |
| -- | -- | -- |
| `provider` | `jev` | `compactMessages`/`JevClient`: `jev` (System One) or `openai` (Decisions API) |
| `apiKey` | `TYPESAFE_API_KEY` (`OPENAI_API_KEY` with `openai`) | Key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` (`gpt-6-luna` with `openai`) | Model name |
| `baseUrl` | the provider's endpoint | Endpoint URL |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepMode` | `rank` | `rank` keeps the best-scored calls within the token budgets below; `threshold` compares against `keepThreshold` |
| `keepThreshold` | `0.5` | Threshold mode: minimum keep probability for a call or result to stay |
| `keepResultTokens` | `12000` | Rank mode: estimated tokens of results kept verbatim |
| `keepCallTokens` | `4000` | Rank mode: estimated tokens of inputs plus truncated heads kept when the result is dropped |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `maxConcurrentRequests` | `4` | Jev requests in flight at once |
| `instructions` | none | What the user asked this compaction to keep; added to the goal, capped at 2000 characters |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `dropCalls` | `false` | `true` removes a no-longer-needed call with its result; `false` leaves a stub of the call |
| `recallNotes` | `false` | Cut notes end with `full text: recall expand ["<tool_use_id>"]` instead of "re-run the tool if needed"; for hosts that offer the recall tool |
| `trimHostText` | `true` | Cut host-generated blocks (`<system-reminder>`, `<task-notification>`, command echoes, hook output; never user prose) outside the pinned messages to a head plus a marker |
| `hostTextHeadChars` | `200` | Characters of a trimmed host block retained before its marker |
| `oldProse` | `keep` | `digest` replaces everything before the last `recentTurns` user turns with a deterministic digest (first prompt, per-turn prompt head and final reply head, tool names, referenced paths and ids); `summarize` with a model-written summary (plugin: `proseModel`, falls back to the digest; the library needs a `summarize` callback in `compact`'s fourth argument). An earlier digest or summary is folded, not chained |
| `recentTurns` | `8` | User turns kept outside `oldProse` condensing |
| `taskResultHeadChars` | `4000` | Characters of a `<task-notification>`'s `<result>` (a subagent's final report) retained; its `task-id`, `status`, `summary`, `output-file` and `tool-use-id` always stay whole; `0` trims it like any host block |

Plugin-only options (set as plugin options, see
[`hooks/README.md`](../hooks/README.md)): `compactAtPercent` (60),
`minReductionRatio` (0.25), `compactionTimeoutMs` (15000), `builtinFallback`
(`auto`), `targetPercent` (45: above this estimated post-compaction context
percentage, the Jev result is given up for the built-in summary on automatic
compactions, or skipped otherwise), `envFile`. With `oldProse` unset, the plugin
first retries a refused result with `oldProse: 'digest'` (see
[Adaptive prose digest](../README.md#adaptive-prose-digest)).

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Only tool calls and results are candidates; text messages are never removed or
  shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Algorithm in detail

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left out;
   runs of old call-only messages folded into one entry. If it still does not
   fit (long sessions), the calls are asked in contiguous windows, halved until
   each window's state fits: a window keeps the goal, the first message, the
   pinned newest messages and its own messages in full. A call whose window
   cannot fit even alone is not asked, so it stays. Tokens are estimated without
   a tokenizer (a word per six letters, half a token per digit, ~one per other
   symbol), calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; up to
   `maxConcurrentRequests` (4) run at once and their answers are merged. A 429
   or 5xx is retried once after `RETRY_DELAY_MS` (pass `sleep` in the fourth
   argument of `compact`; without it the retry goes out at once). After a 401,
   403 or a request with no answer, no further request starts. The calls of a
   request that still failed are kept and counted in `stats.requestsFailed`.
6. Decisions per call. Jev's scores are compressed (keepCall rarely exceeds
   0.3), so the default `rank` mode ranks them instead of applying an absolute
   threshold: results are kept verbatim best-`keepResult` first within
   `keepResultTokens`, then the best-`keepCall` of the rest keep their input and
   a truncated result within `keepCallTokens`, the rest are removed (ties go to
   the more recent call). In `threshold` mode, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is removed,
   untouched messages are returned as the same objects, and no result is ever
   left without its call.

A missing key, or Jev failing every request (an error, a malformed answer),
throws; the caller (or the Claude Code hook) decides what to fall back to. When
only some requests fail, their calls are kept and the rest is applied.
