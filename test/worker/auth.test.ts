import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_TOKENINFO_URL, GOOGLE_TOKEN_URL } from "../../src/worker/routes/auth";
import { APP_URL, call, ledger, resetDb, testEnv } from "./helpers";

function mockGoogle(info: Record<string, unknown>) {
  const original = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === GOOGLE_TOKEN_URL) return Response.json({ id_token: "idtok", access_token: "x" });
    if (url.startsWith(GOOGLE_TOKENINFO_URL)) return Response.json(info);
    return original(input, init);
  });
}

async function login(state = "st8") {
  const { env: e } = testEnv();
  return call(e, `/api/auth/google/callback?state=${state}&code=abc`, { cookie: "oauth_state=st8" });
}

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("Google OAuth", () => {
  const goodInfo = { aud: "test-client.apps.googleusercontent.com", sub: "g-123", email: "a@b.com", email_verified: "true", name: "נועה" };

  it("start redirects to Google with state cookie", async () => {
    const { env: e } = testEnv();
    const res = await call(e, "/api/auth/google/start");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${APP_URL}/api/auth/google/callback`);
    expect(loc.searchParams.get("scope")).toBe("openid email profile");
    const state = loc.searchParams.get("state")!;
    expect(res.headers.get("set-cookie")).toContain(`oauth_state=${state}`);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  });

  it("callback creates the user once, grants the signup bonus once, and sets a session", async () => {
    const spy = mockGoogle(goodInfo);
    const res = await login();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/session=[^;]+;.*HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const tokenCall = spy.mock.calls.find((c) => c[0] === GOOGLE_TOKEN_URL)!;
    expect(String((tokenCall[1] as RequestInit).body)).toContain("client_secret=test-secret");

    await login(); // second login
    const user = await env.DB.prepare("SELECT * FROM users WHERE google_sub = 'g-123'").first<{ id: string; display_name: string }>();
    expect(user!.display_name).toBe("נועה");
    const l = await ledger(user!.id);
    expect(l).toEqual([{ type: "signup_bonus", amount: 300, match_id: null }]);
    const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(user!.id).first<{ n: number }>();
    expect(sessions!.n).toBe(2);

    // The session cookie works and logout clears it.
    const token = cookie.match(/session=([^;]+)/)![1];
    const { env: e } = testEnv();
    const me = (await (await call(e, "/api/me", { cookie: `session=${token}` })).json()) as { user: { id: string } };
    expect(me.user.id).toBe(user!.id);
    expect((await call(e, "/api/auth/logout", { method: "POST", body: {}, cookie: `session=${token}` })).status).toBe(200);
    const me2 = (await (await call(e, "/api/me", { cookie: `session=${token}` })).json()) as { user: unknown };
    expect(me2.user).toBeNull();
  });

  it("rejects a state mismatch without calling Google", async () => {
    const spy = mockGoogle(goodInfo);
    const res = await login("other");
    expect(res.status).toBe(400);
    expect(spy.mock.calls.some((c) => c[0] === GOOGLE_TOKEN_URL)).toBe(false);
  });

  it("rejects a wrong audience or unverified email", async () => {
    mockGoogle({ ...goodInfo, aud: "someone-else" });
    expect((await login()).status).toBe(400);
    vi.restoreAllMocks();
    mockGoogle({ ...goodInfo, email_verified: "false" });
    expect((await login()).status).toBe(400);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE is_bot = 0").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});
