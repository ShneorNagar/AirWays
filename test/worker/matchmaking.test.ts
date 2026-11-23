import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { selectOpponents } from "../../src/worker/matchmaking";
import { runCron } from "../../src/worker/cron";
import { VALID_ATTACK, VALID_DEFENSE, call, createUser, resetDb, testEnv } from "./helpers";

describe("selectOpponents", () => {
  const c = (id: string, elo: number) => ({ version_id: `v-${id}`, user_id: id, elo });
  it("sorts by absolute Elo distance and takes N", () => {
    const out = selectOpponents(1000, [c("far", 1400), c("near", 990), c("mid", 1100), c("below", 850)], 3, () => 0);
    expect(out.map((x) => x.user_id)).toEqual(["near", "mid", "below"]);
  });
  it("breaks ties with the random source", () => {
    const vals = [5, 1];
    let i = 0;
    const out = selectOpponents(1000, [c("x", 1050), c("y", 950)], 2, () => vals[i++]!);
    expect(out.map((x) => x.user_id)).toEqual(["y", "x"]);
  });
  it("returns everything when there are fewer than N candidates", () => {
    expect(selectOpponents(1000, [c("a", 1), c("b", 2)], 10)).toHaveLength(2);
  });
});

describe("submitVersion", () => {
  beforeEach(resetDb);

  it("creates matches vs bots on an empty server, excludes self and banned users, supersedes old pending matches", async () => {
    const { env: e } = testEnv();
    await runCron(e);
    const banned = await createUser({ banned: true });
    await env.DB.prepare("UPDATE users SET banned = 0 WHERE id = ?").bind(banned.id).run();
    await call(e, "/api/versions", { method: "POST", cookie: banned.cookie, body: { defense_prompt: VALID_DEFENSE, attack_prompt: VALID_ATTACK } });
    await env.DB.prepare("UPDATE users SET banned = 1 WHERE id = ?").bind(banned.id).run();

    const u = await createUser();
    const body = { defense_prompt: VALID_DEFENSE, attack_prompt: VALID_ATTACK };
    const r1 = (await (await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body })).json()) as { version: { version_no: number }; matches_queued: number };
    expect(r1.version.version_no).toBe(1);
    expect(r1.matches_queued).toBe(3);
    const opp = (await env.DB.prepare("SELECT user_b_id FROM matches WHERE user_a_id = ?").bind(u.id).all<{ user_b_id: string }>()).results;
    expect(opp.map((o) => o.user_b_id).sort()).toEqual(["bot-chatter", "bot-guard", "bot-trickster"]);

    const r2 = (await (await call(e, "/api/versions", { method: "POST", cookie: u.cookie, body })).json()) as { version: { version_no: number } };
    expect(r2.version.version_no).toBe(2);
    const statuses = (await env.DB.prepare(
      "SELECT v.version_no, m.status, m.cancel_reason FROM matches m JOIN versions v ON v.id = m.version_a_id WHERE m.user_a_id = ? ORDER BY v.version_no",
    ).bind(u.id).all()).results;
    expect(statuses.filter((s) => s.version_no === 1).every((s) => s.status === "cancelled" && s.cancel_reason === "superseded")).toBe(true);
    expect(statuses.filter((s) => s.version_no === 2).every((s) => s.status === "pending")).toBe(true);
    const active = await env.DB.prepare("SELECT version_no FROM versions WHERE user_id = ? AND is_active = 1").bind(u.id).all();
    expect(active.results).toEqual([{ version_no: 2 }]);
    const rating = await env.DB.prepare("SELECT elo FROM ratings WHERE user_id = ?").bind(u.id).first();
    expect(rating).toEqual({ elo: 1000 });
  });

  it("a later user is matched against earlier users too", async () => {
    const { env: e } = testEnv();
    await runCron(e);
    const a = await createUser();
    const b = await createUser();
    const body = { defense_prompt: VALID_DEFENSE, attack_prompt: VALID_ATTACK };
    await call(e, "/api/versions", { method: "POST", cookie: a.cookie, body });
    const res = (await (await call(e, "/api/versions", { method: "POST", cookie: b.cookie, body })).json()) as { matches_queued: number };
    expect(res.matches_queued).toBe(4);
  });
});
