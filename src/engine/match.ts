import { ROUNDS_PER_MATCH } from "./config";
import type { MatchOutcome } from "./types";

export const ROUND_WINS_NEEDED = Math.floor(ROUNDS_PER_MATCH / 2) + 1;

/** Spec 5.6. Call after each completed round. */
export function evaluateMatch(roundsA: number, roundsB: number, roundsPlayed: number): MatchOutcome {
  if (roundsA >= ROUND_WINS_NEEDED) return { decided: true, result: "a" };
  if (roundsB >= ROUND_WINS_NEEDED) return { decided: true, result: "b" };
  if (roundsPlayed >= ROUNDS_PER_MATCH) {
    if (roundsA > roundsB) return { decided: true, result: "a" };
    if (roundsB > roundsA) return { decided: true, result: "b" };
    return { decided: true, result: "draw" };
  }
  return { decided: false };
}
