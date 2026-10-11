export type Role = 'user' | 'assistant';

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (Claude Code attaches them).
 */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

/** A tool_result block of a user message. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

/**
 * One transcript message. The shape is a subset of Claude Code's
 * `SessionMessage`, so a session transcript can be passed in as is.
 */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use block. */
  callIndex: number;
  /** Index of the message holding the tool_result block. */
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
}

export interface CallAnswer {
  /** Jev's probability that the call itself still matters. */
  keepCall: number;
  /** Jev's probability that the full result still needs to stay verbatim. */
  keepResult: number;
}

/**
 * `stub_call` keeps the call's tool name with a truncated input and a truncated
 * result: the history still shows that a call was made, at a fraction of the
 * size. Chosen instead of `drop_call` when `dropCalls` is false.
 */
export type CallAction = 'keep' | 'drop_result' | 'drop_call' | 'stub_call';

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  action: CallAction;
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped' | 'call_stubbed';
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

export interface HistoryEntry {
  i: number;
  role: Role;
  text: string;
  /** Structured per call, or one compact line per call once the state has to shrink. */
  tool_calls?: HistoryToolCall[] | string[];
}

/** The state sent with every Jev request: the whole history, results omitted. */
export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  /** Which fitting stage produced the state, for diagnostics. */
  stage: string;
}

export type KeepMode = 'threshold' | 'rank';

/** What becomes of prose older than `recentTurns` user turns: kept verbatim, summarized by a model, or reduced to a deterministic digest. */
export type OldProseMode = 'keep' | 'summarize' | 'digest';

export interface CompactOptions {
  /** Ongoing task description; defaults to the last few user prompts. */
  goal?: string;
  /** What the user asked this compaction to keep (`/compact <instructions>`); added to the goal. */
  instructions?: string;
  /** `threshold` compares Jev's probabilities to `keepThreshold`; `rank` spends token budgets on the best-scored calls. Default `rank`. */
  keepMode?: KeepMode;
  /** Threshold mode: minimum keep probability for a call or result to stay. Default 0.5. */
  keepThreshold?: number;
  /** Rank mode: estimated tokens of results kept verbatim. Default 12000. */
  keepResultTokens?: number;
  /** Rank mode: estimated tokens of inputs (plus truncated heads) kept when the result is dropped. Default 4000. */
  keepCallTokens?: number;
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for the state. Default 25000. */
  maxStateTokens?: number;
  /** Estimated token ceiling for state plus one batch of questions. Default 30000. */
  maxRequestTokens?: number;
  /** Jev requests in flight at once. Default 4. */
  maxConcurrentRequests?: number;
  /** Characters of a dropped tool result to retain. Default 300. */
  truncateHeadChars?: number;
  /**
   * Whether a call Jev rates as no longer needed is removed together with its
   * result (`drop_call`). With `false` it becomes a stub (`stub_call`): the
   * tool name stays, input and result are cut to `truncateHeadChars`, so the
   * history keeps a tool call in front of every report the assistant made.
   * Default false: a silent drop led the model to report work it never did
   * (tamaratran/fast-jev-compaction#65).
   */
  dropCalls?: boolean;
  /**
   * Cut recognized host-generated blocks (system reminders, task notifications,
   * command echoes, hook output) outside the pinned messages to a head and a
   * marker. User prose is never matched. Default true.
   */
  trimHostText?: boolean;
  /**
   * Cut notes name the recall call that gets the rest (`recall expand
   * ["<tool_use_id>"]`) instead of saying to run the tool again. For hosts that
   * offer the recall tool. Default false.
   */
  recallNotes?: boolean;
  /** Characters of a trimmed host block to retain. Default 200. */
  hostTextHeadChars?: number;
  /** Characters of a task-notification's `<result>` (a subagent's final report) retained; 0 trims it like any host block. Default 4000. */
  taskResultHeadChars?: number;
  /**
   * `digest` replaces everything before the last `recentTurns` user turns with
   * a deterministic extractive digest, `summarize` with a model-written summary
   * (needs a summarizer; falls back to the digest). The recent turns are
   * compacted as usual. Default `keep`.
   */
  oldProse?: OldProseMode;
  /** User turns kept outside `oldProse` condensing. Default 8. */
  recentTurns?: number;
  /**
   * A result an earlier compaction already cut to a head loses that head too:
   * only its cut note stays, and recall (or running the tool again) returns
   * it. Pinned results are never aged. Default false.
   */
  ageCutResults?: boolean;
  /**
   * Gives each Jev question `true`/`false` criteria describing what a call or
   * result worth keeping looks like. Default false.
   */
  questionCriteria?: boolean;
  /**
   * Who scores the calls: `model` asks Jev (or the asker given); `algorithmic`
   * asks nothing and scores by recency, errors and edits (see
   * `algorithmicAnswers`), so a compaction needs no key and no network.
   * Default `model`.
   */
  decider?: Decider;
}

export type Decider = 'model' | 'algorithmic';

export interface ResolvedCompactOptions {
  goal: string;
  instructions: string;
  keepMode: KeepMode;
  keepThreshold: number;
  keepResultTokens: number;
  keepCallTokens: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  maxConcurrentRequests: number;
  dropCalls: boolean;
  truncateHeadChars: number;
  trimHostText: boolean;
  recallNotes: boolean;
  hostTextHeadChars: number;
  taskResultHeadChars: number;
  oldProse: OldProseMode;
  recentTurns: number;
  ageCutResults: boolean;
  questionCriteria: boolean;
  decider: Decider;
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CallDecision[];
  stats: {
    messagesBefore: number;
    messagesAfter: number;
    charsBefore: number;
    charsAfter: number;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    callsStubbed: number;
    /** Results an earlier compaction cut to a head, reduced to their cut note (`ageCutResults`). */
    resultsAged: number;
    pinned: number;
    /** Messages whose host blocks were trimmed, and the characters that removed. */
    hostTextTrimmed: number;
    hostCharsTrimmed: number;
    /** Which `oldProse` mechanism replaced the old prefix (`keep`: none), the messages it replaced, and their characters before and after. */
    oldProse: OldProseMode;
    oldProseReplaced: number;
    oldProseCharsBefore: number;
    oldProseCharsAfter: number;
    stateTokens: number;
    /** Which fitting stage the state needed, '' when no request was made. */
    stateStage: string;
    requests: number;
    /** Requests that failed after their retry; their calls were kept. */
    requestsFailed: number;
    /** The first such failure's message, when there was one. */
    requestError?: string;
    ms: number;
  };
}

/** The `state` of a Jev request: a string or any JSON-serialisable object. */
export type JevState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
}

/** Anything that can answer Jev questions: `JevClient`, or a host-provided adapter. */
export interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>;
}
