import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { computeHoldCredits, computeMaxMatchUsdMicro } from "../../src/engine/cost";
import { runCron } from "../../src/worker/cron";
import type { MatchRow } from "../../src/worker/db";
import { handleStartMatch, handleStep } from "../../src/worker/queue";
import { VALID_ATTACK, VALID_DEFENSE, call, createUser, installStrikeMock, ledger, resetDb, testEnv } from "./helpers";

const body = { defense_prompt: VALID_DEFENSE, attack_prompt: VALID_ATTACK };
const HOLD = computeHoldCredits();
const PER_MATCH_USD = computeMaxMatchUsdMicro() / 1e6;

async function setup() {
  const { env: e, queue } = testEnv();
  await runCron(e);
  const admin = await createUser({ admin: true });
  const u = await createUser({ credits: 1000 });
  return { e, queue, admin, u };
}

async function setSettings(e: Parameters<typeof call>[0], admin: { cookie: string }, s: Record<string, unknown>) {
  const res = await call(e, "/api/admin/settings", { method: "POST", cookie: admin.cookie, body: s });
  expect(res.status).toBe(200);
}

async function spend(usd: number) {
  await env.DB.prepare(
    "INSERT INTO llm_calls (id, match_id, role, model, input_tokens, output_tokens, cost_usd_micro, created_at) SELECT ?, id, 'attacker', 'claude-haiku-5-5', 0, 0, ?, ? FROM matches LIMIT 1",
  ).bind(crypto.randomUUID(), Math.round(usd * 1e6), Date.now()).run();
}

const statusOf = async (id: string) => (await env.DB.prepare("SELECT * FROM matches WHERE id = ?").bind(id).first<MatchRow>())!;

beforeEach(resetDb);

describe("kill switch", () => {
  it("pauses submissions and match starts; resuming restores them", async () => {
    const { e, queue, admin, u } = await setup();
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body });
    await setSettings(e, admin, { matches_paused: true });

    const res = await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "paused" });

    await runCron(e);
    expect(queue.sent).toHaveLength(0);
    const m = await env.DB.prepare("SELECT id FROM matches WHERE status = 'pending' LIMIT 1").first<{ id: string }>();
    await handleStartMatch(e, m!.id); // even a message already in the queue does nothing
    expect((await statusOf(m!.id)).status).toBe("pending");
    expect((await ledger(u.id)).filter((x) => x.type === "hold")).toHaveLength(0);

    await setSettings(e, admin, { matches_paused: false });
    await runCron(e);
    expect(queue.sent.filter((x) => x.type === "start_match")).toHaveLength(3);
  });
});

describe("global budgets", () => {
  it("only starts as many matches as the daily budget can cover in the worst case", async () => {
    const { e, queue, admin, u } = await setup();
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body });
    await setSettings(e, admin, { daily_budget_usd: PER_MATCH_USD * 1.5 });
    await runCron(e);
    expect(queue.sent.filter((x) => x.type === "start_match")).toHaveLength(1);
  });

  it("blocks new matches once today's spend reaches the budget; matches wait instead of being cancelled", async () => {
    const { e, admin, u } = await setup();
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body });
    await setSettings(e, admin, { daily_budget_usd: 1 });
    await spend(0.9);
    const m = await env.DB.prepare("SELECT id FROM matches WHERE status = 'pending' LIMIT 1").first<{ id: string }>();
    await handleStartMatch(e, m!.id);
    expect((await statusOf(m!.id)).status).toBe("pending");

    const s = (await (await call(e, "/api/admin/settings", { cookie: admin.cookie })).json()) as Record<string, number>;
    expect(s.spent_today_usd).toBeCloseTo(0.9, 6);
    expect(s.startable_matches).toBe(0);

    await setSettings(e, admin, { daily_budget_usd: 5 });
    await handleStartMatch(e, m!.id);
    expect((await statusOf(m!.id)).status).toBe("running");
  });

  it("the monthly budget applies too", async () => {
    const { e, queue, admin, u } = await setup();
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body });
    await setSettings(e, admin, { daily_budget_usd: 100, monthly_budget_usd: 0.1 });
    await runCron(e);
    expect(queue.sent).toHaveLength(0);
  });
});

describe("per-match cost cap", () => {
  it("ends a match that reached its worst-case cost and never charges above the hold", async () => {
    const { e, u } = await setup();
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body });
    installStrikeMock();
    const m = await env.DB.prepare("SELECT id FROM matches WHERE user_a_id = ? LIMIT 1").bind(u.id).first<{ id: string }>();
    await handleStartMatch(e, m!.id);
    await handleStep(e, { matchId: m!.id, round: 1, turn: 1 });
    // Simulate a runaway match: its recorded cost reaches the cap.
    await env.DB.prepare(
      "INSERT INTO llm_calls (id, match_id, role, model, input_tokens, output_tokens, cost_usd_micro, created_at) VALUES (?, ?, 'defender', 'claude-haiku-5-5', 0, 0, ?, ?)",
    ).bind(crypto.randomUUID(), m!.id, computeMaxMatchUsdMicro(), Date.now()).run();

    await handleStep(e, { matchId: m!.id, round: 1, turn: 2 });
    const after = await statusOf(m!.id);
    expect(after).toMatchObject({ status: "completed", result: "draw", charged_credits: HOLD });
    const round = await env.DB.prepare("SELECT * FROM rounds WHERE match_id = ?").bind(m!.id).first();
    expect(round).toMatchObject({ status: "completed", winner: "draw", end_reason: "cost_cap", end_turn: 1 });
    const rows = (await ledger(u.id)).filter((x) => x.match_id === m!.id);
    expect(rows.reduce((s, x) => s + x.amount, 0)).toBe(-HOLD);
    // No further LLM calls were made for the capped step.
    const calls = await env.DB.prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE match_id = ?").bind(m!.id).first<{ n: number }>();
    expect(calls!.n).toBe(6 + 1);
  });
});

describe("admin settings endpoint", () => {
  it("is admin-only and validates input", async () => {
    const { e, admin, u } = await setup();
    expect((await call(e, "/api/admin/settings", { cookie: u.cookie })).status).toBe(403);
    expect((await call(e, "/api/admin/settings", { method: "POST", cookie: admin.cookie, body: { daily_budget_usd: -1 } })).status).toBe(400);
    expect((await call(e, "/api/admin/settings", { method: "POST", cookie: admin.cookie, body: { matches_paused: "yes" } })).status).toBe(400);
    expect((await call(e, "/api/admin/settings", { method: "POST", cookie: admin.cookie, body: {} })).status).toBe(400);
    const s = (await (await call(e, "/api/admin/settings", { cookie: admin.cookie })).json()) as Record<string, unknown>;
    expect(s).toMatchObject({ matches_paused: false, daily_budget_usd: 2, monthly_budget_usd: 20, running_matches: 0 });
  });
});
