export type Side = "a" | "b";
export type Task = "translate" | "summarize" | "answer";
export const TASKS: readonly Task[] = ["translate", "summarize", "answer"] as const;

export type ChannelStatus = "open" | "cracked" | "forfeit" | "exhausted" | "stopped";
export type RoundWinner = "a" | "b" | "draw";
export type RoundEndReason =
  | "cracked"
  | "forfeit"
  | "tiebreak_guesses"
  | "tiebreak_tokens"
  | "draw_exhausted"
  | "draw_tie";

export interface VersionPrompts {
  defense_prompt: string;
  attack_prompt: string;
}

/** One persisted turn of one channel (mirrors the `turns` table). */
export interface TurnRecord {
  turn_no: number;
  attacker_task: Task;
  attacker_content: string;
  guess: string | null;
  /** true/false when the guess was evaluated; null if no guess or no guesses left. */
  guess_correct: boolean | null;
  /** null if the channel was cracked this turn. */
  defender_reply: string | null;
  /** null if the channel was cracked this turn. */
  verdict_complied: boolean | null;
  verdict_reason: string | null;
}

/** Mutable state of one channel (mirrors the `channels` table). */
export interface ChannelState {
  attacker_side: Side;
  status: ChannelStatus;
  end_turn: number | null;
  guesses_used: number;
  strikes: number;
  attacker_tokens: number;
}

export type RoundOutcome =
  | { ended: false }
  | { ended: true; winner: RoundWinner; end_turn: number; end_reason: RoundEndReason };

export type MatchResult = "a" | "b" | "draw";

export type MatchOutcome = { decided: false } | { decided: true; result: MatchResult };
