import { MAX_TURNS } from "./config";
import type { ChannelState, RoundOutcome, Side } from "./types";

function hasWinEvent(ch: ChannelState, t: number): boolean {
  return (ch.status === "cracked" || ch.status === "forfeit") && ch.end_turn === t;
}

/**
 * Spec 5.5. Evaluated after both channels finished turn t.
 * channel `a` = attacker of side A; a win event there means side A wins.
 */
export function evaluateRound(t: number, chA: ChannelState, chB: ChannelState): RoundOutcome {
  const winA = hasWinEvent(chA, t);
  const winB = hasWinEvent(chB, t);

  if (winA && winB) {
    if (chA.guesses_used !== chB.guesses_used) {
      const winner: Side = chA.guesses_used < chB.guesses_used ? "a" : "b";
      return { ended: true, winner, end_turn: t, end_reason: "tiebreak_guesses" };
    }
    if (chA.attacker_tokens !== chB.attacker_tokens) {
      const winner: Side = chA.attacker_tokens < chB.attacker_tokens ? "a" : "b";
      return { ended: true, winner, end_turn: t, end_reason: "tiebreak_tokens" };
    }
    return { ended: true, winner: "draw", end_turn: t, end_reason: "draw_tie" };
  }
  if (winA || winB) {
    const ch = winA ? chA : chB;
    return {
      ended: true,
      winner: winA ? "a" : "b",
      end_turn: t,
      end_reason: ch.status === "cracked" ? "cracked" : "forfeit",
    };
  }
  if (t >= MAX_TURNS) {
    return { ended: true, winner: "draw", end_turn: t, end_reason: "draw_exhausted" };
  }
  return { ended: false };
}
