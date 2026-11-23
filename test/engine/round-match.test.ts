import { describe, expect, it } from "vitest";
import { newChannelState } from "../../src/engine/channel";
import { MAX_TURNS } from "../../src/engine/config";
import { evaluateMatch } from "../../src/engine/match";
import { evaluateRound } from "../../src/engine/round";
import type { ChannelState } from "../../src/engine/types";

const ch = (side: "a" | "b", s: Partial<ChannelState> = {}): ChannelState => ({ ...newChannelState(side), ...s });

describe("evaluateRound", () => {
  it("continues when nothing happened", () => {
    expect(evaluateRound(3, ch("a"), ch("b"))).toEqual({ ended: false });
  });

  it("single winner by crack", () => {
    expect(evaluateRound(4, ch("a", { status: "cracked", end_turn: 4 }), ch("b"))).toEqual({
      ended: true, winner: "a", end_turn: 4, end_reason: "cracked",
    });
  });

  it("single winner by forfeit (defender of A lost channel b)", () => {
    expect(evaluateRound(6, ch("a"), ch("b", { status: "forfeit", end_turn: 6, strikes: 3 }))).toEqual({
      ended: true, winner: "b", end_turn: 6, end_reason: "forfeit",
    });
  });

  it("a win event on the last turn beats exhaustion of the other channel", () => {
    const r = evaluateRound(MAX_TURNS, ch("a", { status: "exhausted", end_turn: MAX_TURNS }), ch("b", { status: "cracked", end_turn: MAX_TURNS }));
    expect(r).toMatchObject({ ended: true, winner: "b", end_reason: "cracked" });
  });

  it("simultaneous win: fewer guesses wins", () => {
    const r = evaluateRound(
      5,
      ch("a", { status: "cracked", end_turn: 5, guesses_used: 2, attacker_tokens: 10 }),
      ch("b", { status: "cracked", end_turn: 5, guesses_used: 1, attacker_tokens: 999 }),
    );
    expect(r).toEqual({ ended: true, winner: "b", end_turn: 5, end_reason: "tiebreak_guesses" });
  });

  it("simultaneous win: crack vs forfeit uses guesses too", () => {
    const r = evaluateRound(
      5,
      ch("a", { status: "forfeit", end_turn: 5, guesses_used: 0 }),
      ch("b", { status: "cracked", end_turn: 5, guesses_used: 1 }),
    );
    expect(r).toMatchObject({ winner: "a", end_reason: "tiebreak_guesses" });
  });

  it("simultaneous win with equal guesses: fewer attacker tokens wins", () => {
    const r = evaluateRound(
      2,
      ch("a", { status: "cracked", end_turn: 2, guesses_used: 1, attacker_tokens: 500 }),
      ch("b", { status: "cracked", end_turn: 2, guesses_used: 1, attacker_tokens: 700 }),
    );
    expect(r).toEqual({ ended: true, winner: "a", end_turn: 2, end_reason: "tiebreak_tokens" });
  });

  it("simultaneous win, fully tied: draw", () => {
    const r = evaluateRound(
      2,
      ch("a", { status: "cracked", end_turn: 2, guesses_used: 1, attacker_tokens: 500 }),
      ch("b", { status: "cracked", end_turn: 2, guesses_used: 1, attacker_tokens: 500 }),
    );
    expect(r).toEqual({ ended: true, winner: "draw", end_turn: 2, end_reason: "draw_tie" });
  });

  it("draw on exhaustion", () => {
    const r = evaluateRound(
      MAX_TURNS,
      ch("a", { status: "exhausted", end_turn: MAX_TURNS }),
      ch("b", { status: "exhausted", end_turn: MAX_TURNS }),
    );
    expect(r).toEqual({ ended: true, winner: "draw", end_turn: MAX_TURNS, end_reason: "draw_exhausted" });
  });
});

describe("evaluateMatch", () => {
  it("stops early at 2-0", () => {
    expect(evaluateMatch(1, 0, 1)).toEqual({ decided: false });
    expect(evaluateMatch(2, 0, 2)).toEqual({ decided: true, result: "a" });
    expect(evaluateMatch(0, 2, 2)).toEqual({ decided: true, result: "b" });
  });

  it("draw at 1-1 with a drawn round", () => {
    expect(evaluateMatch(1, 1, 2)).toEqual({ decided: false });
    expect(evaluateMatch(1, 1, 3)).toEqual({ decided: true, result: "draw" });
  });

  it("0-0 after three drawn rounds is a draw; 1-0 with two draws is a win", () => {
    expect(evaluateMatch(0, 0, 3)).toEqual({ decided: true, result: "draw" });
    expect(evaluateMatch(1, 0, 3)).toEqual({ decided: true, result: "a" });
    expect(evaluateMatch(0, 1, 3)).toEqual({ decided: true, result: "b" });
  });

  it("2-1 after three rounds", () => {
    expect(evaluateMatch(2, 1, 3)).toEqual({ decided: true, result: "a" });
  });
});
