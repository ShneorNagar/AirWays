// Typed client for the Worker API. Mirrors src/worker/serializers.ts.

export interface Me {
  user: { id: string; display_name: string; is_admin: boolean } | null;
  balance: number;
  season: { id: number; name: string; ends_at: number } | null;
  est_credits_per_match: number;
}

export interface Version {
  id: string;
  version_no: number;
  defense_prompt: string;
  attack_prompt: string;
  is_active: boolean;
  created_at: number;
}

export interface MatchListItem {
  id: string;
  opponent_name: string;
  role: "a" | "b";
  status: "pending" | "running" | "completed" | "error" | "cancelled";
  result_for_me: "win" | "loss" | "draw" | null;
  rounds_me: number;
  rounds_opp: number;
  created_at: number;
}

export interface Turn {
  turn_no: number;
  task: "translate" | "summarize" | "answer";
  content: string;
  guess: string | null;
  guess_correct: boolean | null;
  reply: string | null;
  complied: boolean | null;
  reason: string | null;
  turn_id: string;
}

export interface Channel {
  status: "open" | "cracked" | "forfeit" | "exhausted" | "stopped";
  guesses_used: number;
  strikes: number;
  turns: Turn[];
}

export interface Round {
  round_no: number;
  status: "running" | "completed";
  winner: "a" | "b" | "draw" | null;
  end_turn: number | null;
  end_reason: string | null;
  secrets?: { a: string; b: string };
  channels: Partial<Record<"a" | "b", Channel>>;
}

export interface Replay {
  id: string;
  status: MatchListItem["status"];
  result: "a" | "b" | "draw" | null;
  me: "a" | "b" | null;
  players: { a: { display_name: string }; b: { display_name: string } };
  rounds_a: number;
  rounds_b: number;
  rounds: Round[];
  admin?: { cost_usd_micro: number; hold_credits: number; charged_credits: number; hidden: boolean; error: string | null };
}

export interface LeaderboardRow {
  rank: number;
  user_id: string;
  display_name: string;
  is_bot: boolean;
  elo: number;
  wins: number;
  draws: number;
  losses: number;
  matches: number;
}

export interface Leaderboard {
  season: { id: number; name: string; ends_at: number } | null;
  seasons: { id: number; name: string; status: "active" | "closed" }[];
  rows: LeaderboardRow[];
}

export interface AdminStats {
  users: number;
  versions_this_season: number;
  users_with_2plus_versions: number;
  resubmit_after_loss_rate: number | null;
  matches_by_status: Record<string, number>;
  avg_cost_usd: number | null;
  credits_charged_total: number;
}

export interface AdminSettings {
  matches_paused: boolean;
  daily_budget_usd: number;
  monthly_budget_usd: number;
  spent_today_usd: number;
  spent_month_usd: number;
  running_matches: number;
  reserved_usd: number;
  startable_matches: number;
}

export interface AdminAppeal {
  id: string;
  turn_id: string;
  match_id: string;
  reason: string;
  status: string;
  user_id: string;
  user_name: string;
  created_at: number;
  turn: Turn | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: method === "POST" ? { "content-type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, String(data.error ?? "internal"), String(data.message ?? ""), data);
  }
  return data as T;
}

export const api = {
  me: () => request<Me>("GET", "/me"),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  myVersions: () => request<{ versions: Version[] }>("GET", "/versions/mine"),
  lastVersion: () => request<{ version: Version | null }>("GET", "/versions/last"),
  submitVersion: (defense_prompt: string, attack_prompt: string) =>
    request<{ version: Version; matches_queued: number }>("POST", "/versions", { defense_prompt, attack_prompt }),
  leaderboard: (season?: number) => request<Leaderboard>("GET", `/leaderboard${season ? `?season=${season}` : ""}`),
  myMatches: (cursor?: number | null) =>
    request<{ matches: MatchListItem[]; next_cursor: number | null }>("GET", `/matches/mine${cursor ? `?cursor=${cursor}` : ""}`),
  match: (id: string) => request<Replay>("GET", `/matches/${encodeURIComponent(id)}`),
  appeal: (turn_id: string, reason: string) => request<{ appeal: { id: string } }>("POST", "/appeals", { turn_id, reason }),
  admin: {
    stats: () => request<AdminStats>("GET", "/admin/stats"),
    settings: () => request<AdminSettings>("GET", "/admin/settings"),
    saveSettings: (s: Partial<Pick<AdminSettings, "matches_paused" | "daily_budget_usd" | "monthly_budget_usd">>) =>
      request<{ ok: true }>("POST", "/admin/settings", s),
    grant: (user_id: string, amount: number, note: string) => request<{ ok: true }>("POST", "/admin/credits", { user_id, amount, note }),
    appeals: () => request<{ appeals: AdminAppeal[] }>("GET", "/admin/appeals?status=open"),
    resolveAppeal: (id: string, status: "accepted" | "rejected", admin_note: string) =>
      request<{ ok: true }>("POST", `/admin/appeals/${encodeURIComponent(id)}`, { status, admin_note }),
    hideMatch: (id: string, hidden: boolean) => request<{ ok: true }>("POST", `/admin/matches/${encodeURIComponent(id)}/hide`, { hidden }),
    banUser: (id: string, banned: boolean) => request<{ ok: true }>("POST", `/admin/users/${encodeURIComponent(id)}/ban`, { banned }),
  },
};

/** Localized message for an API error, from its error code (the server's text is Hebrew-only). */
export function errorMessage(err: unknown, S: { apiErrors: Record<string, string>; common: { error: string } }): string {
  return (err instanceof ApiError && S.apiErrors[err.code]) || S.common.error;
}
