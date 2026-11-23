// Loss protection: runtime kill switch and global LLM spending budgets.
import {
  DEFAULT_DAILY_LLM_BUDGET_USD,
  DEFAULT_MONTHLY_LLM_BUDGET_USD,
} from "../engine/config";
import { computeMaxMatchUsdMicro } from "../engine/cost";

export interface Settings {
  matchesPaused: boolean;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
}

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  const num = (k: string, d: number) => {
    const v = Number(map.get(k));
    return map.has(k) && Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    matchesPaused: map.get("matches_paused") === "1",
    dailyBudgetUsd: num("daily_budget_usd", DEFAULT_DAILY_LLM_BUDGET_USD),
    monthlyBudgetUsd: num("monthly_budget_usd", DEFAULT_MONTHLY_LLM_BUDGET_USD),
  };
}

export function setSettingStmt(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, value, Date.now());
}

export function utcDayStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function utcMonthStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export interface BudgetStatus {
  settings: Settings;
  todayMicro: number;
  monthMicro: number;
  runningMatches: number;
  /** Worst-case cost still to come from matches already running. */
  reservedMicro: number;
  /** How many more matches may start now without risking either budget. */
  startableMatches: number;
}

/**
 * Conservative check: spent so far + worst-case cost of every running match + worst-case
 * cost of each new match must stay within both the daily and the monthly budget.
 */
export async function budgetStatus(db: D1Database, ts = Date.now()): Promise<BudgetStatus> {
  const [settings, [today, month, running]] = await Promise.all([
    getSettings(db),
    db.batch<{ v: number }>([
      db.prepare("SELECT COALESCE(SUM(cost_usd_micro), 0) AS v FROM llm_calls WHERE created_at >= ?").bind(utcDayStart(ts)),
      db.prepare("SELECT COALESCE(SUM(cost_usd_micro), 0) AS v FROM llm_calls WHERE created_at >= ?").bind(utcMonthStart(ts)),
      db.prepare("SELECT COUNT(*) AS v FROM matches WHERE status = 'running'"),
    ]),
  ]);
  const todayMicro = today!.results[0]!.v;
  const monthMicro = month!.results[0]!.v;
  const runningMatches = running!.results[0]!.v;
  const perMatch = computeMaxMatchUsdMicro();
  const reservedMicro = runningMatches * perMatch;
  const roomDay = settings.dailyBudgetUsd * 1e6 - todayMicro - reservedMicro;
  const roomMonth = settings.monthlyBudgetUsd * 1e6 - monthMicro - reservedMicro;
  const startableMatches = settings.matchesPaused ? 0 : Math.max(0, Math.floor(Math.min(roomDay, roomMonth) / perMatch));
  return { settings, todayMicro, monthMicro, runningMatches, reservedMicro, startableMatches };
}
