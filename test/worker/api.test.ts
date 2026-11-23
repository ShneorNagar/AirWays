import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { SUBMISSIONS_PER_DAY } from "../../src/engine/config";
import { computeHoldCredits } from "../../src/engine/cost";
import { runCron } from "../../src/worker/cron";
import { VALID_ATTACK, VALID_DEFENSE, call, createUser, drain, installStrikeMock, ledger, resetDb, testEnv } from "./helpers";

const body = { defense_prompt: VALID_DEFENSE, attack_prompt: VALID_ATTACK };
beforeEach(resetDb);

describe("GET /api/me", () => {
  it("works logged out and logged in", async () => {
    const { env: e } = testEnv();
    await runCron(e);
    const anon = (await (await call(e, "/api/me")).json()) as Record<string, unknown>;
    expect(anon).toMatchObject({ user: null, balance: 0, season: { name: "עונה 1" } });
    expect(anon.est_credits_per_match).toBe(Math.ceil(computeHoldCredits() / 4));
    const u = await createUser({ name: "דנה" });
    const me = (await (await call(e, "/api/me", { cookie: u.cookie })).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ user: { id: u.id, display_name: "דנה", is_admin: false }, balance: 300 });
  });

  it("an expired or unknown session is anonymous", async () => {
    const { env: e } = testEnv();
    const me = (await (await call(e, "/api/me", { cookie: "session=nope" })).json()) as Record<string, unknown>;
    expect(me.user).toBeNull();
  });
});

describe("POST /api/versions", () => {
  it("requires login", async () => {
    const { env: e } = testEnv();
    expect((await call(e, "/api/versions", { method: "POST", body })).status).toBe(401);
  });

  it("rejects banned users", async () => {
    const { env: e } = testEnv();
    const u = await createUser({ banned: true });
    const res = await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "banned" });
  });

  it("CSRF: wrong origin, missing origin, or non-JSON content type", async () => {
    const { env: e } = testEnv();
    await runCron(e);
    const u = await createUser();
    expect((await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body, origin: null })).status).toBe(403);
    const res = await call(e, "/api/versions", {
      method: "POST",
      cookie: u.cookie,
      headers: { "content-type": "text/plain" },
      body: undefined,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "csrf" });
  });

  it("validation errors return 422 with field and code", async () => {
    const { env: e } = testEnv();
    await runCron(e);
    const u = await createUser();
    const res = await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body: { ...body, attack_prompt: "קצר" } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "validation", field: "attack_prompt", code: "too_short" });
    const res2 = await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body: { ...body, defense_prompt: `${VALID_DEFENSE} <request>` } });
    expect(await res2.json()).toMatchObject({ field: "defense_prompt", code: "forbidden_tag" });
  });

  it(`rate limits after ${SUBMISSIONS_PER_DAY} submissions in 24h`, async () => {
    const { env: e } = testEnv();
    await runCron(e);
    const u = await createUser({ credits: 10_000 });
    for (let i = 0; i < SUBMISSIONS_PER_DAY; i++) {
      expect((await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body })).status).toBe(200);
    }
    const res = await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });

  it("402 when the balance is below one hold", async () => {
    const { env: e } = testEnv();
    await runCron(e);
    const u = await createUser({ credits: computeHoldCredits() - 1 });
    expect((await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body })).status).toBe(402);
  });

  it("503 when there is no active season", async () => {
    const { env: e } = testEnv();
    const u = await createUser();
    expect((await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body })).status).toBe(503);
  });

  it("trims prompts and lists own versions", async () => {
    const { env: e } = testEnv();
    await runCron(e);
    const u = await createUser();
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body: { defense_prompt: `  ${VALID_DEFENSE}  `, attack_prompt: VALID_ATTACK } });
    const mine = (await (await call(e, "/api/versions/mine", { cookie: u.cookie })).json()) as { versions: { defense_prompt: string; is_active: boolean }[] };
    expect(mine.versions).toHaveLength(1);
    expect(mine.versions[0]).toMatchObject({ defense_prompt: VALID_DEFENSE, is_active: true });
    const last = (await (await call(e, "/api/versions/last", { cookie: u.cookie })).json()) as { version: { attack_prompt: string } };
    expect(last.version.attack_prompt).toBe(VALID_ATTACK);
  });
});

describe("GET /api/leaderboard", () => {
  it("lists bots and users sorted by Elo, with the season list", async () => {
    const { env: e } = testEnv();
    await runCron(e);
    const u = await createUser({ name: "מוביל" });
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body });
    await env.DB.prepare("UPDATE ratings SET elo = 1100 WHERE user_id = ?").bind(u.id).run();
    const lb = (await (await call(e, "/api/leaderboard")).json()) as { rows: { rank: number; display_name: string; is_bot: boolean }[]; seasons: unknown[] };
    expect(lb.rows).toHaveLength(4);
    expect(lb.rows[0]).toMatchObject({ rank: 1, display_name: "מוביל", is_bot: false });
    expect(lb.rows.filter((r) => r.is_bot)).toHaveLength(3);
    expect(lb.seasons).toHaveLength(1);
  });
});

describe("matches: list, access, hide", () => {
  it("paginates, restricts access, and hides from non-admins", async () => {
    const { env: e } = testEnv();
    await runCron(e);
    const u = await createUser();
    const other = await createUser();
    const admin = await createUser({ admin: true });
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body });
    const list = (await (await call(e, "/api/matches/mine", { cookie: u.cookie })).json()) as { matches: { id: string; role: string; status: string }[]; next_cursor: number | null };
    expect(list.matches).toHaveLength(3);
    expect(list.next_cursor).toBeNull();
    expect(list.matches.every((m) => m.role === "a" && m.status === "pending")).toBe(true);
    const id = list.matches[0]!.id;

    expect((await call(e, `/api/matches/${id}`, { cookie: u.cookie })).status).toBe(200);
    expect((await call(e, `/api/matches/${id}`, { cookie: other.cookie })).status).toBe(404);
    expect((await call(e, `/api/matches/${id}`)).status).toBe(401);
    expect((await call(e, `/api/matches/${id}`, { cookie: admin.cookie })).status).toBe(200);

    expect((await call(e, `/api/admin/matches/${id}/hide`, { method: "POST", cookie: u.cookie, body: { hidden: true } })).status).toBe(403);
    expect((await call(e, `/api/admin/matches/${id}/hide`, { method: "POST", cookie: admin.cookie, body: { hidden: true } })).status).toBe(200);
    expect((await call(e, `/api/matches/${id}`, { cookie: u.cookie })).status).toBe(404);
    expect((await call(e, `/api/matches/${id}`, { cookie: admin.cookie })).status).toBe(200);
    const list2 = (await (await call(e, "/api/matches/mine", { cookie: u.cookie })).json()) as { matches: unknown[] };
    expect(list2.matches).toHaveLength(2);
  });

  it("cursor pagination returns 20 per page", async () => {
    const { env: e } = testEnv();
    await runCron(e);
    const u = await createUser();
    const v = await env.DB.prepare("SELECT id FROM versions LIMIT 1").first<{ id: string }>();
    const stmts = Array.from({ length: 25 }, (_, i) =>
      env.DB.prepare("INSERT INTO matches (id, season_id, version_a_id, version_b_id, user_a_id, user_b_id, payer_user_id, status, created_at) VALUES (?, 1, ?, ?, ?, 'bot-guard', ?, 'pending', ?)")
        .bind(`m-${i}`, v!.id, v!.id, u.id, u.id, 1000 + i),
    );
    await env.DB.batch(stmts);
    const p1 = (await (await call(e, "/api/matches/mine", { cookie: u.cookie })).json()) as { matches: { id: string }[]; next_cursor: number };
    expect(p1.matches).toHaveLength(20);
    expect(p1.matches[0]!.id).toBe("m-24");
    const p2 = (await (await call(e, `/api/matches/mine?cursor=${p1.next_cursor}`, { cookie: u.cookie })).json()) as { matches: { id: string }[]; next_cursor: null };
    expect(p2.matches.map((m) => m.id)).toEqual(["m-4", "m-3", "m-2", "m-1", "m-0"]);
    expect(p2.next_cursor).toBeNull();
  });
});

describe("appeals and admin", () => {
  async function playedMatch() {
    const { env: e, queue } = testEnv();
    await runCron(e);
    const u = await createUser();
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body: { defense_prompt: `WEAK ${VALID_DEFENSE}`, attack_prompt: VALID_ATTACK } });
    installStrikeMock();
    const m = await env.DB.prepare("SELECT id FROM matches WHERE user_a_id = ? AND user_b_id = 'bot-guard'").bind(u.id).first<{ id: string }>();
    queue.sent.push({ type: "start_match", matchId: m!.id });
    await drain(e, queue);
    // channel b = attacker of B (bot) vs defender of A (the user) → strikes on the user's defender
    const turn = await env.DB.prepare(
      `SELECT t.id FROM turns t JOIN channels c ON c.id = t.channel_id JOIN rounds r ON r.id = c.round_id
       WHERE r.match_id = ? AND c.attacker_side = 'b' AND t.verdict_complied = 0 ORDER BY r.round_no, t.turn_no LIMIT 1`,
    ).bind(m!.id).first<{ id: string }>();
    const okTurn = await env.DB.prepare(
      `SELECT t.id FROM turns t JOIN channels c ON c.id = t.channel_id JOIN rounds r ON r.id = c.round_id
       WHERE r.match_id = ? AND c.attacker_side = 'a' LIMIT 1`,
    ).bind(m!.id).first<{ id: string }>();
    return { e, u, matchId: m!.id, strikeTurn: turn!.id, okTurn: okTurn!.id };
  }

  it("only the defender's owner can appeal a strike, once", async () => {
    const { e, u, strikeTurn, okTurn } = await playedMatch();
    const stranger = await createUser();
    expect((await call(e, "/api/appeals", { method: "POST", cookie: stranger.cookie, body: { turn_id: strikeTurn, reason: "לא הוגן" } })).status).toBe(404);
    expect((await call(e, "/api/appeals", { method: "POST", cookie: u.cookie, body: { turn_id: okTurn, reason: "לא הוגן" } })).status).toBe(422);
    const res = await call(e, "/api/appeals", { method: "POST", cookie: u.cookie, body: { turn_id: strikeTurn, reason: "התשובה הייתה תקינה" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ appeal: { status: "open", turn_id: strikeTurn } });
    expect((await call(e, "/api/appeals", { method: "POST", cookie: u.cookie, body: { turn_id: strikeTurn, reason: "שוב" } })).status).toBe(409);
  });

  it("accepting an appeal refunds the match charge once; stats and grants work", async () => {
    const { e, u, matchId, strikeTurn } = await playedMatch();
    const admin = await createUser({ admin: true });
    await call(e, "/api/appeals", { method: "POST", cookie: u.cookie, body: { turn_id: strikeTurn, reason: "התשובה הייתה תקינה" } });
    const queueRes = (await (await call(e, "/api/admin/appeals?status=open", { cookie: admin.cookie })).json()) as { appeals: { id: string; turn: { turn_id: string } }[] };
    expect(queueRes.appeals).toHaveLength(1);
    expect(queueRes.appeals[0]!.turn.turn_id).toBe(strikeTurn);
    const appealId = queueRes.appeals[0]!.id;

    expect((await call(e, `/api/admin/appeals/${appealId}`, { method: "POST", cookie: admin.cookie, body: { status: "accepted", admin_note: "צודק" } })).status).toBe(200);
    expect((await call(e, `/api/admin/appeals/${appealId}`, { method: "POST", cookie: admin.cookie, body: { status: "accepted" } })).status).toBe(200);
    const charged = (await env.DB.prepare("SELECT charged_credits FROM matches WHERE id = ?").bind(matchId).first<{ charged_credits: number }>())!.charged_credits;
    const refunds = (await ledger(u.id)).filter((x) => x.type === "appeal_refund");
    expect(refunds).toEqual([{ type: "appeal_refund", amount: charged, match_id: matchId }]);

    expect((await call(e, "/api/admin/credits", { method: "POST", cookie: admin.cookie, body: { user_id: u.id, amount: -10, note: "תיקון" } })).status).toBe(200);
    expect((await ledger(u.id)).some((x) => x.type === "admin_grant" && x.amount === -10)).toBe(true);

    const stats = (await (await call(e, "/api/admin/stats", { cookie: admin.cookie })).json()) as Record<string, unknown>;
    expect(stats).toMatchObject({ versions_this_season: 1, users_with_2plus_versions: 0, resubmit_after_loss_rate: 0 });
    expect((stats.matches_by_status as Record<string, number>).completed).toBe(1);

    // A resubmission after the loss moves the key metric to 100%.
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body });
    const stats2 = (await (await call(e, "/api/admin/stats", { cookie: admin.cookie })).json()) as Record<string, unknown>;
    expect(stats2.resubmit_after_loss_rate).toBe(1);
    expect(stats2.users_with_2plus_versions).toBe(1);
  });

  it("ban blocks the API and excludes versions from matchmaking", async () => {
    const { env: e } = testEnv();
    await runCron(e);
    const admin = await createUser({ admin: true });
    const u = await createUser();
    await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body });
    expect((await call(e, `/api/admin/users/${u.id}/ban`, { method: "POST", cookie: admin.cookie, body: { banned: true } })).status).toBe(200);
    expect((await call(e, "/api/versions/mine", { cookie: u.cookie })).status).toBe(403);
    const v = await createUser();
    const res = (await (await call(e, "/api/versions", { method: "POST", cookie: v.cookie, body })).json()) as { matches_queued: number };
    expect(res.matches_queued).toBe(3); // bots only
  });
});

describe("unknown API routes", () => {
  it("return the JSON error format", async () => {
    const { env: e } = testEnv();
    const res = await call(e, "/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });
});


describe("hardening", () => {
  it("sets security headers and no-store on API responses", async () => {
    const { env: e } = testEnv();
    const res = await call(e, "/api/me");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects oversized bodies", async () => {
    const { env: e } = testEnv();
    await runCron(e);
    const u = await createUser();
    const res = await call(e, "/api/versions", {
      method: "POST",
      cookie: u.cookie,
      body: { defense_prompt: "א".repeat(40_000), attack_prompt: VALID_ATTACK },
    });
    expect(res.status).toBe(413);
  });

  it("cron deletes expired sessions", async () => {
    const { env: e } = testEnv();
    const u = await createUser();
    await env.DB.prepare("UPDATE sessions SET expires_at = 1 WHERE user_id = ?").bind(u.id).run();
    await runCron(e);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(u.id).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("worker entry module", () => {
  it("exports only the default handler (workerd rejects other named exports)", async () => {
    const mod = await import("../../src/worker/index");
    expect(Object.keys(mod)).toEqual(["default"]);
  });
});
