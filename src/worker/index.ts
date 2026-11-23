import { Hono } from "hono";
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

export const app = new Hono<AppEnv>().basePath("/api");

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
