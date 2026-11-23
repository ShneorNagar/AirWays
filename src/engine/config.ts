// All tunables live here. No magic numbers elsewhere.

export const PLAYER_MODEL = "claude-haiku-5-5";
export const JUDGE_MODEL = "claude-haiku-5-5";

// SPEC DEVIATION (reported): the spec asks for 0.7 / 0. claude-haiku-5-5 rejects any
// non-default sampling value with HTTP 400 (on anthropic-version 2023-06-01 only
// temperature=1 is accepted; on 2026-10-21 any value is rejected). `null` means
// "do not send the field". Set a number here only for a model that accepts it.
export const PLAYER_TEMPERATURE: number | null = null; // spec value: 0.7
export const JUDGE_TEMPERATURE: number | null = null; // spec value: 0

// SPEC DEVIATION (reported): claude-haiku-5-5 runs adaptive thinking by default, and
// thinking tokens count against max_tokens (500/200 here), which can leave the reply
// empty or truncated. We send `thinking: {type: "disabled"}` (accepted at the
// model's default effort). Set to false to restore the model default.
export const DISABLE_THINKING = true;

export const ATTACKER_MAX_TOKENS = 500;
export const DEFENDER_MAX_TOKENS = 500;
export const JUDGE_MAX_TOKENS = 200;

export const MAX_TURNS = 10; // per channel per round
export const MAX_GUESSES = 3; // per channel per round
export const MAX_STRIKES = 3; // defender strikes before losing the channel
export const ROUNDS_PER_MATCH = 3; // best of 3, stop early when decided

export const PROMPT_MIN_CHARS = 20;
export const PROMPT_MAX_CHARS = 1500;
export const CONTENT_MAX_CHARS = 1500; // attacker content is truncated to this
export const CONTENT_MIN_CHARS_FOR_JUDGE = 3; // shorter content => auto "complied", no judge call
export const JUDGE_REASON_MAX_CHARS = 200;

// Pricing — verified 2026-11-23 for claude-haiku-5-5: $0.10 input / $0.50 output per
// 1M tokens for prompts <= 100K tokens (our calls are far below that).
// Units: USD per 1M tokens.
export const PRICE_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
// The app must refuse to start a match if any price is NaN (see cost.ts assertPricesConfigured).

// Upper bounds used only for computing the credit HOLD (section 9).
export const MAX_INPUT_TOKENS_PLAYER_CALL = 12000;
export const MAX_INPUT_TOKENS_JUDGE_CALL = 4000;

export const MARGIN = 0.2; // 20% on top of actual LLM cost
export const CREDIT_USD = 0.01; // 1 credit = $0.01
export const SIGNUP_BONUS_CREDITS = 300;

export const OPPONENTS_PER_VERSION = 10;
export const MAX_ACTIVE_MATCHES = 5; // global concurrency cap
export const SUBMISSIONS_PER_DAY = 5; // per user, rolling 24h
export const SEASON_DAYS = 14;

export const ELO_START = 1000;
export const ELO_K = 32;

export const LLM_RETRIES = 3; // in-call retries with backoff 1s, 2s, 4s
export const LLM_BACKOFF_MS = [1000, 2000, 4000];

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

// Phase-1 local league runner.
export const LEAGUE_CONCURRENCY = 3;
