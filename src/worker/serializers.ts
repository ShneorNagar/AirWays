// The ONLY place DB rows become API JSON. Never include defense/attack prompts of any
// user in match data, secrets of a non-completed match, or cost fields for non-admins.
import type {
  AppealRow,
  ChannelRow,
  MatchRow,
  RatingRow,
  RoundRow,
  SeasonRow,
  TurnRow,
  UserRow,
  VersionRow,
} from "./db";

type Side = "a" | "b";

export function serializeMe(user: UserRow | null) {
  return user ? { id: user.id, display_name: user.display_name, is_admin: user.is_admin === 1 } : null;
}

export function serializeSeason(s: SeasonRow | null) {
  return s ? { id: s.id, name: s.name, ends_at: s.ends_at } : null;
}

export function serializeSeasonListItem(s: SeasonRow) {
  return { id: s.id, name: s.name, status: s.status, starts_at: s.starts_at, ends_at: s.ends_at };
}

/** Own versions only (the caller must check ownership). */
export function serializeOwnVersion(v: VersionRow) {
  return {
    id: v.id,
    version_no: v.version_no,
    defense_prompt: v.defense_prompt,
    attack_prompt: v.attack_prompt,
    is_active: v.is_active === 1,
    created_at: v.created_at,
  };
}

export function serializeLeaderboardRow(
  rank: number,
  row: RatingRow & Pick<UserRow, "display_name" | "is_bot">,
) {
  return {
    rank,
    user_id: row.user_id,
    display_name: row.display_name,
    is_bot: row.is_bot === 1,
    elo: row.elo,
    wins: row.wins,
    draws: row.draws,
    losses: row.losses,
    matches: row.matches,
  };
}

export function serializeMatchListItem(m: MatchRow, meId: string, opponentName: string) {
  const role: Side = m.user_a_id === meId ? "a" : "b";
  let result_for_me: "win" | "loss" | "draw" | null = null;
  if (m.status === "completed" && m.result) {
    result_for_me = m.result === "draw" ? "draw" : m.result === role ? "win" : "loss";
  }
  return {
    id: m.id,
    opponent_name: opponentName,
    role,
    status: m.status,
    result_for_me,
    rounds_me: role === "a" ? m.rounds_a : m.rounds_b,
    rounds_opp: role === "a" ? m.rounds_b : m.rounds_a,
    created_at: m.created_at,
  };
}

export interface ReplayInput {
  match: MatchRow;
  rounds: RoundRow[];
  channels: ChannelRow[];
  turns: TurnRow[];
  names: Record<Side, string>;
  meId: string | null;
  isAdmin: boolean;
}

export function serializeTurn(t: TurnRow) {
  return {
    turn_no: t.turn_no,
    task: t.attacker_task,
    content: t.attacker_content,
    guess: t.guess,
    guess_correct: t.guess_correct === null ? null : t.guess_correct === 1,
    reply: t.defender_reply,
    complied: t.verdict_complied === null ? null : t.verdict_complied === 1,
    reason: t.verdict_reason,
    turn_id: t.id,
  };
}

export function serializeMatchReplay(input: ReplayInput) {
  const { match, names, meId, isAdmin } = input;
  const completed = match.status === "completed";
  const me: Side | null = meId === match.user_a_id ? "a" : meId === match.user_b_id ? "b" : null;

  const rounds = [...input.rounds]
    .sort((x, y) => x.round_no - y.round_no)
    .map((r) => {
      const channels: Partial<Record<Side, unknown>> = {};
      for (const ch of input.channels.filter((c) => c.round_id === r.id)) {
        channels[ch.attacker_side] = {
          status: ch.status,
          guesses_used: ch.guesses_used,
          strikes: ch.strikes,
          turns: input.turns
            .filter((t) => t.channel_id === ch.id)
            .sort((x, y) => x.turn_no - y.turn_no)
            .map(serializeTurn),
        };
      }
      return {
        round_no: r.round_no,
        status: r.status,
        winner: r.winner,
        end_turn: r.end_turn,
        end_reason: r.end_reason,
        ...(completed ? { secrets: { a: r.secret_a, b: r.secret_b } } : {}),
        channels,
      };
    });

  return {
    id: match.id,
    status: match.status,
    result: match.result,
    me,
    players: { a: { display_name: names.a }, b: { display_name: names.b } },
    rounds_a: match.rounds_a,
    rounds_b: match.rounds_b,
    rounds,
    ...(isAdmin
      ? {
          admin: {
            cost_usd_micro: match.cost_usd_micro,
            hold_credits: match.hold_credits,
            charged_credits: match.charged_credits,
            hidden: match.hidden === 1,
            error: match.error,
          },
        }
      : {}),
  };
}

export function serializeAppeal(a: AppealRow) {
  return {
    id: a.id,
    turn_id: a.turn_id,
    match_id: a.match_id,
    reason: a.reason,
    status: a.status,
    admin_note: a.admin_note,
    created_at: a.created_at,
    resolved_at: a.resolved_at,
  };
}

/** Admin appeal queue item: the appeal plus the turn it is about (no secrets, no prompts). */
export function serializeAdminAppeal(a: AppealRow & { user_name: string }, turn: TurnRow | null) {
  return { ...serializeAppeal(a), user_id: a.user_id, user_name: a.user_name, turn: turn ? serializeTurn(turn) : null };
}
