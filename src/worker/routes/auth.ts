import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SIGNUP_BONUS_CREDITS } from "../../engine/config";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_S,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  csrf,
  randomToken,
  sha256Hex,
  type AppEnv,
} from "../auth";
import { newId, now, type UserRow } from "../db";
import { apiError } from "../errors";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

const app = new Hono<AppEnv>();

const redirectUri = (appUrl: string) => `${new URL(appUrl).origin}/api/auth/google/callback`;

app.get("/google/start", (c) => {
  const state = randomToken();
  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/api/auth",
    maxAge: OAUTH_STATE_TTL_S,
  });
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri(c.env.APP_URL));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return c.redirect(url.toString(), 302);
});

interface TokenInfo {
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
}

app.get("/google/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  const cookieState = getCookie(c, OAUTH_STATE_COOKIE);
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/api/auth", secure: true });
  if (!state || !code || !cookieState || state !== cookieState) return apiError(c, 400, "oauth_failed");

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(c.env.APP_URL),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return apiError(c, 400, "oauth_failed");
  const { id_token } = (await tokenRes.json()) as { id_token?: string };
  if (!id_token) return apiError(c, 400, "oauth_failed");

  const infoRes = await fetch(`${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(id_token)}`);
  if (!infoRes.ok) return apiError(c, 400, "oauth_failed");
  const info = (await infoRes.json()) as TokenInfo;
  const verified = info.email_verified === true || info.email_verified === "true";
  if (info.aud !== c.env.GOOGLE_CLIENT_ID || !verified || !info.sub) return apiError(c, 400, "oauth_failed");

  const db = c.env.DB;
  const ts = now();
  let user = await db.prepare("SELECT * FROM users WHERE google_sub = ?").bind(info.sub).first<UserRow>();
  if (!user) {
    const id = newId();
    const displayName = (info.name || info.email?.split("@")[0] || "שחקן").slice(0, 60);
    // INSERT OR IGNORE + conditional bonus: a concurrent double callback grants the bonus once.
    await db.batch([
      db
        .prepare("INSERT OR IGNORE INTO users (id, google_sub, email, display_name, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, info.sub, info.email ?? null, displayName, ts),
      db
        .prepare(
          `INSERT INTO credit_ledger (id, user_id, amount, type, created_at)
           SELECT ?, ?, ?, 'signup_bonus', ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
             AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE user_id = ? AND type = 'signup_bonus')`,
        )
        .bind(newId(), id, SIGNUP_BONUS_CREDITS, ts, id, id),
    ]);
    user = await db.prepare("SELECT * FROM users WHERE google_sub = ?").bind(info.sub).first<UserRow>();
    if (!user) return apiError(c, 500, "internal");
  }

  const token = randomToken();
  await db
    .prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), user.id, ts + SESSION_TTL_MS, ts)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return c.redirect("/dashboard", 302);
});

app.post("/logout", csrf, async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});

export default app;

