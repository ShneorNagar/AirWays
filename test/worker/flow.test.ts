import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ELO_START } from "../../src/engine/config";
import { computeChargeCredits, computeHoldCredits } from "../../src/engine/cost";
import { updateElo } from "../../src/engine/elo";
import { ensureSeason, recoverStalledMatches, runCron, STALL_MS } from "../../src/worker/cron";
import type { MatchRow } from "../../src/worker/db";
import { handleQueue, handleStartMatch, handleStep, setLLMFactory } from "../../src/worker/queue";
import { MockLLMClient } from "../../src/engine/llm";
import {
  VALID_ATTACK,
  VALID_DEFENSE,
  call,
  createUser,
  drain,
  installStrikeMock,
  ledger,
  resetDb,
  testEnv,
} from "./helpers";

const HOLD = computeHoldCredits();

async function matches(userId: string) {
  return (await env.DB.prepare("SELECT * FROM matches WHERE user_a_id = ? ORDER BY created_at").bind(userId).all<MatchRow>()).results;
}

beforeEach(resetDb);

describe("cron: seasons and bots", () => {
  it("creates the first season with bot versions and ratings, idempotently", async () => {
    const { env: e } = testEnv();
    await runCron(e);
    await runCron(e);
    const seasons = (await env.DB.prepare("SELECT * FROM seasons").all()).results;
    expect(seasons).toHaveLength(1);
    expect(seasons[0]).toMatchObject({ name: "עונה 1", status: "active" });
    const v = await env.DB.prepare("SELECT COUNT(*) AS n FROM versions WHERE is_active = 1").first<{ n: number }>();
    expect(v!.n).toBe(3);
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM ratings WHERE elo = ?").bind(ELO_START).first<{ n: number }>();
    expect(r!.n).toBe(3);
  });

  it("rolls over an expired season and cancels its pending matches", async () => {
    const { env: e } = testEnv();
    const s1 = await ensureSeason(e);
    const u = await createUser();
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body: { defense_prompt: VALID_DEFENSE, attack_prompt: VALID_ATTACK } });
    const s2 = await ensureSeason(e, s1.ends_at + 1);
    expect(s2.id).not.toBe(s1.id);
    expect(s2.name).toBe("עונה 2");
    expect((await matches(u.id)).every((m) => m.status === "cancelled" && m.cancel_reason === "season_closed")).toBe(true);
    const bots = await env.DB.prepare("SELECT COUNT(*) AS n FROM versions WHERE season_id = ?").bind(s2.id).first<{ n: number }>();
    expect(bots!.n).toBe(3);
  });
});

describe("full match through queue steps", () => {
  it("submit → cron → matches complete; ledger hold/release/charge; Elo updated", async () => {
    const { env: e, queue } = testEnv();
    await runCron(e);
    const u = await createUser();
    const res = await call(e, "/api/versions", {
      method: "POST",
      cookie: u.cookie,
      body: { defense_prompt: `WEAK ${VALID_DEFENSE}`, attack_prompt: VALID_ATTACK },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { matches_queued: number }).matches_queued).toBe(3);
    expect(queue.sent).toHaveLength(0); // matches start from the cron, not immediately

    installStrikeMock();
    await runCron(e);
    expect(queue.sent.filter((m) => m.type === "start_match")).toHaveLength(3);
    expect(await drain(e, queue)).toBe(0);

    const ms = await matches(u.id);
    expect(ms).toHaveLength(3);
    for (const m of ms) {
      // The user's defender forfeits on turn 3 of rounds 1 and 2 → bot wins 2-0.
      expect(m).toMatchObject({ status: "completed", result: "b", rounds_a: 0, rounds_b: 2, hold_credits: HOLD });
      const cost = await env.DB.prepare("SELECT SUM(cost_usd_micro) AS s, COUNT(*) AS n FROM llm_calls WHERE match_id = ?").bind(m.id).first<{ s: number; n: number }>();
      expect(m.cost_usd_micro).toBe(cost!.s);
      expect(m.charged_credits).toBe(computeChargeCredits(cost!.s));
      // 2 rounds × 3 turns × 2 channels × 3 calls
      expect(cost!.n).toBe(36);
      const rounds = (await env.DB.prepare("SELECT * FROM rounds WHERE match_id = ? ORDER BY round_no").bind(m.id).all()).results;
      expect(rounds).toHaveLength(2);
      expect(rounds[0]).toMatchObject({ status: "completed", winner: "b", end_turn: 3, end_reason: "forfeit" });
    }

    // Ledger: signup, then per match hold / hold_release / match_charge.
    const l = await ledger(u.id);
    for (const m of ms) {
      const rows = l.filter((x) => x.match_id === m.id);
      expect(rows.map((x) => x.type).sort()).toEqual(["hold", "hold_release", "match_charge"]);
      expect(rows.find((x) => x.type === "hold")!.amount).toBe(-HOLD);
      expect(rows.find((x) => x.type === "hold_release")!.amount).toBe(HOLD);
      expect(rows.find((x) => x.type === "match_charge")!.amount).toBe(-m.charged_credits);
    }
    const balance = l.reduce((s, x) => s + x.amount, 0);
    expect(balance).toBe(300 - ms.reduce((s, m) => s + m.charged_credits, 0));

    // Elo: three losses vs 1000-rated bots, applied as sequential deltas.
    const rating = await env.DB.prepare("SELECT * FROM ratings WHERE user_id = ?").bind(u.id).first<{ elo: number; losses: number; matches: number }>();
    expect(rating).toMatchObject({ losses: 3, matches: 3 });
    let elo = ELO_START;
    for (let i = 0; i < 3; i++) elo = updateElo(elo, ELO_START, "b").a;
    expect(rating!.elo).toBe(elo);
    const bot = await env.DB.prepare("SELECT * FROM ratings WHERE user_id = 'bot-guard'").first<{ elo: number; wins: number }>();
    expect(bot).toMatchObject({ wins: 1 });
    expect(bot!.elo).toBeGreaterThan(ELO_START);

    // Replay endpoint shows secrets now that the match is completed.
    const replay = (await (await call(e, `/api/matches/${ms[0]!.id}`, { cookie: u.cookie })).json()) as { rounds: { secrets?: unknown }[] };
    expect(replay.rounds[0]!.secrets).toBeDefined();
  });

  it("duplicate step messages are no-ops", async () => {
    const { env: e, queue } = testEnv();
    await runCron(e);
    const u = await createUser();
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body: { defense_prompt: VALID_DEFENSE, attack_prompt: VALID_ATTACK } });
    installStrikeMock();
    const m = (await matches(u.id))[0]!;
    await handleStartMatch(e, m.id);
    await handleStartMatch(e, m.id); // duplicate start_match
    expect(queue.sent).toEqual([{ type: "step", matchId: m.id, round: 1, turn: 1 }]);
    const holds = (await ledger(u.id)).filter((x) => x.type === "hold");
    expect(holds).toHaveLength(1);

    await handleStep(e, { matchId: m.id, round: 1, turn: 1 });
    const count = async (sql: string) => (await env.DB.prepare(sql).bind(m.id).first<{ n: number }>())!.n;
    const turnsSql = "SELECT COUNT(*) AS n FROM turns t JOIN channels c ON c.id = t.channel_id JOIN rounds r ON r.id = c.round_id WHERE r.match_id = ?";
    const callsSql = "SELECT COUNT(*) AS n FROM llm_calls WHERE match_id = ?";
    expect(await count(turnsSql)).toBe(2);
    const calls = await count(callsSql);

    await handleStep(e, { matchId: m.id, round: 1, turn: 1 }); // the same step again
    expect(await count(turnsSql)).toBe(2);
    expect(await count(callsSql)).toBe(calls);
    expect(queue.sent.filter((x) => x.type === "step" && x.turn === 2)).toHaveLength(1);
    const after = await env.DB.prepare("SELECT current_turn FROM matches WHERE id = ?").bind(m.id).first<{ current_turn: number }>();
    expect(after!.current_turn).toBe(2);
  });

  it("forced LLM failure → retries → DLQ → match error, hold released, no charge", async () => {
    const { env: e, queue } = testEnv();
    await runCron(e);
    const u = await createUser();
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body: { defense_prompt: VALID_DEFENSE, attack_prompt: VALID_ATTACK } });
    let attackerCalls = 0;
    setLLMFactory((_env, onUsage) => new MockLLMClient({}, onUsage, {
      attacker: () => {
        attackerCalls++;
        return new Error("HTTP 529: overloaded");
      },
    }));
    const m = (await matches(u.id))[0]!;
    queue.sent.push({ type: "start_match", matchId: m.id });
    expect(await drain(e, queue, 5)).toBe(1);
    expect(attackerCalls).toBe(2 * 6); // both channels, 1 try + 5 retries

    const after = await env.DB.prepare("SELECT * FROM matches WHERE id = ?").bind(m.id).first<MatchRow>();
    expect(after).toMatchObject({ status: "error", charged_credits: 0 });
    expect(after!.error).toMatch(/step/);
    const rows = (await ledger(u.id)).filter((x) => x.match_id === m.id);
    expect(rows.map((x) => x.type).sort()).toEqual(["hold", "hold_release"]);
    expect(rows.reduce((s, x) => s + x.amount, 0)).toBe(0);
  });

  it("the queue consumer rethrows so the runtime retries", async () => {
    const { env: e } = testEnv();
    await runCron(e);
    const u = await createUser();
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body: { defense_prompt: VALID_DEFENSE, attack_prompt: VALID_ATTACK } });
    setLLMFactory((_env, onUsage) => new MockLLMClient({}, onUsage, { attacker: new Error("boom") }));
    const m = (await matches(u.id))[0]!;
    await handleStartMatch(e, m.id);
    let acked = false;
    const batch = {
      queue: "matches",
      messages: [{ body: { type: "step", matchId: m.id, round: 1, turn: 1 }, ack: () => (acked = true), retry: () => {} }],
    } as unknown as MessageBatch<never>;
    await expect(handleQueue(batch, e)).rejects.toThrow("boom");
    expect(acked).toBe(false);
  });

  it("start_match cancels when the payer cannot cover the hold", async () => {
    const { env: e, queue } = testEnv();
    await runCron(e);
    const u = await createUser({ credits: HOLD });
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body: { defense_prompt: VALID_DEFENSE, attack_prompt: VALID_ATTACK } });
    const [m1, m2] = await matches(u.id);
    await handleStartMatch(e, m1!.id);
    await handleStartMatch(e, m2!.id);
    const a = await env.DB.prepare("SELECT status, cancel_reason FROM matches WHERE id IN (?, ?) ORDER BY created_at").bind(m1!.id, m2!.id).all();
    expect(a.results).toEqual([
      { status: "running", cancel_reason: null },
      { status: "cancelled", cancel_reason: "insufficient_credits" },
    ]);
    expect(queue.sent).toHaveLength(1);
  });

  it("cron respects MAX_ACTIVE_MATCHES and re-enqueues stalled matches", async () => {
    const { env: e, queue } = testEnv();
    await runCron(e);
    const users = await Promise.all([createUser(), createUser()]);
    for (const u of users) {
      await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body: { defense_prompt: VALID_DEFENSE, attack_prompt: VALID_ATTACK } });
    }
    // 2 users: user 1 has 3 bots; user 2 has 3 bots + user 1 → 7 pending
    await env.DB.prepare("UPDATE matches SET status = 'running', current_round = 1, current_turn = 1, started_at = ? WHERE id IN (SELECT id FROM matches LIMIT 2)")
      .bind(Date.now() - STALL_MS - 1)
      .run();
    await runCron(e);
    const starts = queue.sent.filter((m) => m.type === "start_match");
    const steps = queue.sent.filter((m) => m.type === "step");
    expect(starts).toHaveLength(3); // 5 - 2 running
    expect(steps).toHaveLength(2); // both running ones look stalled
    queue.sent = [];
    expect(await recoverStalledMatches(e, Date.now() - STALL_MS)).toBe(0);
  });
});
