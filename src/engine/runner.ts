import { MAX_TURNS, ROUNDS_PER_MATCH } from "./config";
import { newChannelState, runChannelTurn } from "./channel";
import { assertPricesConfigured } from "./cost";
import type { LLMClient } from "./llm";
import { evaluateMatch } from "./match";
import { evaluateRound } from "./round";
import { WORDS, cryptoUint32, generateSecret, type Uint32Source } from "./secret";
import type {
  ChannelState,
  MatchResult,
  RoundEndReason,
  RoundWinner,
  Side,
  TurnRecord,
  VersionPrompts,
} from "./types";

export interface ChannelResult extends ChannelState {
  turns: TurnRecord[];
}

export interface RoundResult {
  round_no: number;
  /** Held by A's defender (target of channel b). */
  secret_a: string;
  /** Held by B's defender (target of channel a). */
  secret_b: string;
  winner: RoundWinner;
  end_turn: number;
  end_reason: RoundEndReason;
  channels: Record<Side, ChannelResult>;
}

export interface FullMatchResult {
  result: MatchResult;
  rounds_a: number;
  rounds_b: number;
  rounds: RoundResult[];
  warnings: string[];
}

export interface RunFullMatchInput {
  llm: LLMClient;
  a: VersionPrompts;
  b: VersionPrompts;
  words?: readonly string[];
  random?: Uint32Source;
}

/** Plays one round in memory (spec 5.3–5.5), both channels in lockstep. */
export async function runRound(
  input: RunFullMatchInput,
  roundNo: number,
  warnings: string[],
): Promise<RoundResult> {
  const words = input.words ?? WORDS;
  const random = input.random ?? cryptoUint32;
  const secret_a = generateSecret(words, random);
  const secret_b = generateSecret(words, random);

  const channels: Record<Side, ChannelResult> = {
    a: { ...newChannelState("a"), turns: [] },
    b: { ...newChannelState("b"), turns: [] },
  };
  // channel a: attacker of A vs defender of B (target secret_b); channel b: the reverse.
  const setup = {
    a: { attack: input.a.attack_prompt, defense: input.b.defense_prompt, secret: secret_b },
    b: { attack: input.b.attack_prompt, defense: input.a.defense_prompt, secret: secret_a },
  } as const;

  for (let t = 1; t <= MAX_TURNS; t++) {
    await Promise.all(
      (["a", "b"] as const).map(async (side) => {
        const ch = channels[side];
        if (ch.status !== "open") return;
        const { turns, ...state } = ch;
        const res = await runChannelTurn({
          llm: input.llm,
          turnNo: t,
          secret: setup[side].secret,
          attackPrompt: setup[side].attack,
          defensePrompt: setup[side].defense,
          state,
          history: turns,
        });
        channels[side] = { ...res.state, turns: [...turns, res.turn] };
        for (const w of res.warnings) warnings.push(`round ${roundNo} turn ${t} channel ${side}: ${w}`);
      }),
    );

    const outcome = evaluateRound(t, channels.a, channels.b);
    if (outcome.ended) {
      for (const side of ["a", "b"] as const) {
        if (channels[side].status === "open") channels[side].status = "stopped";
      }
      return {
        round_no: roundNo,
        secret_a,
        secret_b,
        winner: outcome.winner,
        end_turn: outcome.end_turn,
        end_reason: outcome.end_reason,
        channels,
      };
    }
  }
  throw new Error("unreachable: round did not end after MAX_TURNS");
}

/** Plays a full match in memory (used by the CLI league runner and tests). */
export async function runFullMatch(input: RunFullMatchInput): Promise<FullMatchResult> {
  assertPricesConfigured();
  const rounds: RoundResult[] = [];
  const warnings: string[] = [];
  let rounds_a = 0;
  let rounds_b = 0;
  for (let r = 1; r <= ROUNDS_PER_MATCH; r++) {
    const round = await runRound(input, r, warnings);
    rounds.push(round);
    if (round.winner === "a") rounds_a++;
    if (round.winner === "b") rounds_b++;
    const m = evaluateMatch(rounds_a, rounds_b, r);
    if (m.decided) return { result: m.result, rounds_a, rounds_b, rounds, warnings };
  }
  throw new Error("unreachable: match not decided after ROUNDS_PER_MATCH");
}
