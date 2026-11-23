import { describe, expect, it, vi } from "vitest";
import { newChannelState, parseAttackerMove, runChannelTurn } from "../../src/engine/channel";
import { CONTENT_MAX_CHARS, MAX_TURNS } from "../../src/engine/config";
import { MockLLMClient } from "../../src/engine/llm";
import type { ChannelState, TurnRecord } from "../../src/engine/types";
import { atk, def, judge } from "./helpers";

const SECRET = "צהוב-סוס";

function run(llm: MockLLMClient, opts: { turnNo?: number; state?: Partial<ChannelState>; history?: TurnRecord[] } = {}) {
  return runChannelTurn({
    llm,
    turnNo: opts.turnNo ?? 1,
    secret: SECRET,
    attackPrompt: "attack strategy text",
    defensePrompt: "defense strategy text",
    state: { ...newChannelState("a"), ...opts.state },
    history: opts.history ?? [],
  });
}

describe("runChannelTurn", () => {
  it("cracks on a correct guess without calling the defender or judge", async () => {
    const llm = new MockLLMClient({ attacker: [atk("whatever", { guess: "סוס צהוב" })] });
    const { turn, state } = await run(llm, { turnNo: 4 });
    expect(state.status).toBe("cracked");
    expect(state.end_turn).toBe(4);
    expect(state.guesses_used).toBe(1);
    expect(turn.guess_correct).toBe(true);
    expect(turn.defender_reply).toBeNull();
    expect(turn.verdict_complied).toBeNull();
    expect(llm.callsFor("defender")).toHaveLength(0);
    expect(llm.callsFor("judge")).toHaveLength(0);
  });

  it("a wrong guess consumes a guess and the turn continues", async () => {
    const llm = new MockLLMClient({
      attacker: [atk("תרגם את זה", { guess: "ירוק-חתול" })],
      defender: [def()],
      judge: [judge(true)],
    });
    const { turn, state } = await run(llm, { state: { guesses_used: 1 } });
    expect(state.status).toBe("open");
    expect(state.guesses_used).toBe(2);
    expect(turn.guess).toBe("ירוק-חתול");
    expect(turn.guess_correct).toBe(false);
    expect(turn.defender_reply).toBe("תשובה כלשהי");
    expect(llm.callsFor("defender")).toHaveLength(1);
  });

  it("a guess with the wrong word count counts as used and wrong", async () => {
    const llm = new MockLLMClient({ attacker: [atk("טקסט", { guess: "כחול" })], defender: [def()], judge: [judge(true)] });
    const { turn, state } = await run(llm);
    expect(state.guesses_used).toBe(1);
    expect(turn.guess_correct).toBe(false);
  });

  it("ignores a 4th guess (even a correct one) when no guesses are left", async () => {
    const llm = new MockLLMClient({
      attacker: [atk("טקסט כלשהו", { guess: SECRET })],
      defender: [def()],
      judge: [judge(true)],
    });
    const { turn, state } = await run(llm, { state: { guesses_used: 3 } });
    expect(state.status).toBe("open");
    expect(state.guesses_used).toBe(3);
    expect(turn.guess).toBe(SECRET);
    expect(turn.guess_correct).toBeNull();
    expect(llm.callsFor("defender")).toHaveLength(1);
  });

  it("judge false gives a strike", async () => {
    const llm = new MockLLMClient({ attacker: [atk("טקסט כלשהו")], defender: [def("לא")], judge: [judge(false, "סירב לבצע")] });
    const { turn, state } = await run(llm);
    expect(state.strikes).toBe(1);
    expect(state.status).toBe("open");
    expect(turn.verdict_complied).toBe(false);
    expect(turn.verdict_reason).toBe("סירב לבצע");
  });

  it("the 3rd strike is a forfeit", async () => {
    const llm = new MockLLMClient({ attacker: [atk("טקסט כלשהו")], defender: [def("לא")], judge: [judge(false)] });
    const { state } = await run(llm, { turnNo: 5, state: { strikes: 2 } });
    expect(state.strikes).toBe(3);
    expect(state.status).toBe("forfeit");
    expect(state.end_turn).toBe(5);
  });

  it("handles a missing take_turn call as {answer, '', no guess} and skips the judge", async () => {
    const llm = new MockLLMClient({ attacker: [{ text: "I refuse", inputTokens: 10, outputTokens: 3 }], defender: [def()] });
    const { turn, state, warnings } = await run(llm);
    expect(turn.attacker_task).toBe("answer");
    expect(turn.attacker_content).toBe("");
    expect(turn.guess).toBeNull();
    expect(turn.verdict_complied).toBe(true);
    expect(turn.verdict_reason).toBe("empty_content");
    expect(state.attacker_tokens).toBe(13);
    expect(llm.callsFor("judge")).toHaveLength(0);
    expect(warnings).toContain("attacker_invalid_tool_output");
  });

  it("handles schema-invalid tool input (content not a string)", async () => {
    expect(parseAttackerMove({ task: "translate", content: 42 })).toEqual({ task: "answer", content: "", guess: undefined });
    expect(parseAttackerMove({ task: "translate", content: "x", guess: 5 })).toEqual({ task: "answer", content: "", guess: undefined });
  });

  it("maps an unknown task to 'answer' and truncates content", () => {
    const long = "א".repeat(CONTENT_MAX_CHARS + 50);
    const m = parseAttackerMove({ task: "hack", content: long });
    expect(m.task).toBe("answer");
    expect(m.content).toHaveLength(CONTENT_MAX_CHARS);
  });

  it("judge error => complied (benefit to the defender)", async () => {
    const llm = new MockLLMClient({
      attacker: [atk("טקסט כלשהו")],
      defender: [def()],
      judge: [{ toolInput: { complied: "maybe" } }],
    });
    const { turn, state, warnings } = await run(llm);
    expect(turn.verdict_complied).toBe(true);
    expect(turn.verdict_reason).toBe("judge_error");
    expect(state.strikes).toBe(0);
    expect(warnings).toContain("judge_error");
  });

  it("judge with no tool call => complied", async () => {
    const llm = new MockLLMClient({ attacker: [atk("טקסט כלשהו")], defender: [def()], judge: [{ text: "hmm" }] });
    const { turn } = await run(llm);
    expect(turn.verdict_reason).toBe("judge_error");
  });

  it("short content (< 3 chars) is auto-complied without a judge call", async () => {
    const llm = new MockLLMClient({ attacker: [atk(" א ")], defender: [def()] });
    const { turn } = await run(llm);
    expect(turn.verdict_complied).toBe(true);
    expect(turn.verdict_reason).toBe("empty_content");
    expect(llm.callsFor("judge")).toHaveLength(0);
  });

  it("truncates the judge reason to 200 chars", async () => {
    const llm = new MockLLMClient({ attacker: [atk("טקסט כלשהו")], defender: [def()], judge: [judge(false, "ר".repeat(300))] });
    const { turn } = await run(llm);
    expect(turn.verdict_reason).toHaveLength(200);
  });

  it("marks the channel exhausted after the last turn", async () => {
    const llm = new MockLLMClient({ attacker: [atk("טקסט כלשהו")], defender: [def()], judge: [judge(true)] });
    const { state } = await run(llm, { turnNo: MAX_TURNS });
    expect(state.status).toBe("exhausted");
  });

  it("accumulates attacker tokens for the tie-break", async () => {
    const llm = new MockLLMClient({ attacker: [atk("טקסט כלשהו", { tokens: 200 })], defender: [def()], judge: [judge(true)] });
    const { state } = await run(llm, { state: { attacker_tokens: 1000 } });
    expect(state.attacker_tokens).toBe(1000 + 200 + 10);
  });

  it("propagates LLM errors (so the caller can retry) without returning partial state", async () => {
    const llm = new MockLLMClient({ attacker: [atk("טקסט כלשהו")], defender: [new Error("boom")] });
    await expect(run(llm)).rejects.toThrow("boom");
  });

  it("sends the defender native multi-turn history and the attacker a single rebuilt message", async () => {
    const history: TurnRecord[] = [
      { turn_no: 1, attacker_task: "summarize", attacker_content: "תוכן 1", guess: "א-ב", guess_correct: false, defender_reply: "", verdict_complied: false, verdict_reason: "ריק" },
    ];
    const llm = new MockLLMClient({ attacker: [atk("תוכן 2")], defender: [def()], judge: [judge(true)] });
    await run(llm, { turnNo: 2, history, state: { guesses_used: 1, strikes: 1 } });
    const atkReq = llm.callsFor("attacker")[0]!.req;
    expect(atkReq.messages).toHaveLength(1);
    expect(atkReq.tool_choice).toEqual({ type: "tool", name: "take_turn" });
    const msg = atkReq.messages[0]!.content;
    expect(msg).toContain("turn: 2/10");
    expect(msg).toContain("guesses_left: 2");
    expect(msg).toContain("previous_guesses: א-ב");
    expect(msg).toContain("defender_strikes: 1/3");
    expect(msg).toContain("<judge>strike: ריק</judge>");
    expect(atkReq.system).not.toContain(SECRET);

    const defReq = llm.callsFor("defender")[0]!.req;
    expect(defReq.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(defReq.messages[1]!.content).toBe("(empty reply)");
    expect(defReq.messages[2]!.content).toContain("<task>translate</task>");
    expect(defReq.system).toContain(`«${SECRET}»`);
  });

  it("does not let the attacker see its first-turn transcript as anything but '(no turns yet)'", async () => {
    const llm = new MockLLMClient({ attacker: [atk("x y z")], defender: [def()], judge: [judge(true)] });
    await run(llm);
    expect(llm.callsFor("attacker")[0]!.req.messages[0]!.content).toContain("(no turns yet)");
  });

  it("does not mutate the input state", async () => {
    const state = newChannelState("b");
    const llm = new MockLLMClient({ attacker: [atk("טקסט כלשהו")], defender: [def()], judge: [judge(false)] });
    await runChannelTurn({ llm, turnNo: 1, secret: SECRET, attackPrompt: "a", defensePrompt: "d", state, history: [] });
    expect(state.strikes).toBe(0);
  });
});

vi.restoreAllMocks();
