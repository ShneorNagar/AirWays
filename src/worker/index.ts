// Main module: workerd only accepts handler exports here (no other named exports).
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv } from "./auth";
import { runCron } from "./cron";
import type { Env, QueueMsg } from "./env";
import { apiError } from "./errors";
import { handleQueue } from "./queue";
import admin from "./routes/admin";
import appeals from "./routes/appeals";
import auth from "./routes/auth";
import leaderboard from "./routes/leaderboard";
import matches from "./routes/matches";
import me from "./routes/me";
import versions from "./routes/versions";

const app = new Hono<AppEnv>().basePath("/api");

/** Largest legitimate body is a version submission (2 × 1500 chars of UTF-8). */
const MAX_BODY_BYTES = 32 * 1024;

app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin" }));
app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});
app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => apiError(c, 413, "bad_request") }));

app.route("/auth", auth);
app.route("/me", me);
app.route("/versions", versions);
app.route("/leaderboard", leaderboard);
app.route("/matches", matches);
app.route("/appeals", appeals);
app.route("/admin", admin);

app.notFound((c) => apiError(c, 404, "not_found"));
app.onError((err, c) => {
  console.error(JSON.stringify({ event: "api_error", path: c.req.path, message: err.message }));
  return apiError(c, 500, "internal");
});

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  queue: (batch, env) => handleQueue(batch, env),
  scheduled: async (_controller, env) => {
    await runCron(env);
  },
} satisfies ExportedHandler<Env, QueueMsg>;
