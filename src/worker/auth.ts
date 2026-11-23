import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { UserRow } from "./db";
import type { Env } from "./env";
import { apiError } from "./errors";

export const SESSION_COOKIE = "session";
export const OAUTH_STATE_COOKIE = "oauth_state";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const OAUTH_STATE_TTL_S = 10 * 60;

export type AppEnv = { Bindings: Env; Variables: { user: UserRow | null } };

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Loads the session user (or null). Does not reject. */
export async function loadUser(c: Context<AppEnv>): Promise<UserRow | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const hash = await sha256Hex(token);
  return c.env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
  )
    .bind(hash, Date.now())
    .first<UserRow>();
}

export const optionalUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", await loadUser(c));
  await next();
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await loadUser(c);
  if (!user) return apiError(c, 401, "unauthorized");
  if (user.banned) return apiError(c, 403, "banned");
  c.set("user", user);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await loadUser(c);
  if (!user) return apiError(c, 401, "unauthorized");
  if (user.banned) return apiError(c, 403, "banned");
  if (!user.is_admin) return apiError(c, 403, "forbidden");
  c.set("user", user);
  await next();
};

/** CSRF (spec 11): state-changing routes are POST, JSON, and same-origin. */
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "POST") {
    const ct = c.req.header("content-type") ?? "";
    const origin = c.req.header("origin");
    const expected = new URL(c.env.APP_URL).origin;
    if (!ct.toLowerCase().startsWith("application/json") || origin !== expected) {
      return apiError(c, 403, "csrf");
    }
  }
  await next();
};

/** Reads a JSON object body; returns null when it is not an object. */
export async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
