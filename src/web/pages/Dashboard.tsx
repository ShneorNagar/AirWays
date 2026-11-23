import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage, type MatchListItem, type Version } from "../api";
import { useMe } from "../App";
import { LoginRequired, StatusBadge } from "../components/Layout";
import { S } from "../strings";

const DAY_MS = 24 * 60 * 60 * 1000;

export default function Dashboard() {
  const { me, loading, refresh } = useMe();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [matches, setMatches] = useState<MatchListItem[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loggedIn = !!me?.user;

  useEffect(() => {
    if (!loggedIn) return;
    void refresh();
    Promise.all([api.myVersions(), api.myMatches()])
      .then(([v, m]) => {
        setVersions(v.versions);
        setMatches(m.matches);
        setCursor(m.next_cursor);
      })
      .catch((e) => setError(errorMessage(e, S.common.error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn]);

  if (loading) return <p className="muted">{S.common.loading}</p>;
  if (!loggedIn) return <LoginRequired />;

  async function loadMore() {
    try {
      const m = await api.myMatches(cursor);
      setMatches((prev) => [...prev, ...m.matches]);
      setCursor(m.next_cursor);
    } catch (e) {
      setError(errorMessage(e, S.common.error));
    }
  }

  const active = versions?.find((v) => v.is_active) ?? null;
  const daysLeft = me!.season ? Math.ceil((me!.season.ends_at - Date.now()) / DAY_MS) : 0;

  return (
    <div className="stack">
      <h1>{S.dashboard.title}</h1>
      {error && <p className="error">{error}</p>}
      <div className="grid-3">
        <div className="card stat">
          <div className="stat-label">{S.dashboard.balance}</div>
          <div className="stat-value">
            {me!.balance} <small>{S.common.credits}</small>
          </div>
          <div className="muted small">{S.dashboard.estimate(me!.est_credits_per_match)}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">{S.dashboard.season}</div>
          {me!.season ? (
            <>
              <div className="stat-value">{me!.season.name}</div>
              <div className="muted small">{S.dashboard.daysLeft(daysLeft)}</div>
            </>
          ) : (
            <div className="muted">{S.dashboard.noSeason}</div>
          )}
        </div>
        <div className="card stat">
          <div className="stat-label">{S.dashboard.activeVersion}</div>
          {active ? (
            <>
              <div className="stat-value">{S.dashboard.versionNo(active.version_no)}</div>
              <div className="muted small">{S.dashboard.chars(active.defense_prompt.length, active.attack_prompt.length)}</div>
            </>
          ) : (
            <div className="muted small">{versions ? S.dashboard.noVersion : S.common.loading}</div>
          )}
        </div>
      </div>
      <div>
        <Link className="btn primary" to="/submit">
          {S.dashboard.submitNew}
        </Link>
      </div>

      <section className="card">
        <h2>{S.dashboard.myMatches}</h2>
        {matches.length === 0 ? (
          <p className="muted">{versions ? S.dashboard.noMatches : S.common.loading}</p>
        ) : (
          <ul className="match-list">
            {matches.map((m) => (
              <li key={m.id}>
                <Link to={`/match/${m.id}`} className="match-row">
                  <span className="match-opp">
                    {S.dashboard.vs} {m.opponent_name}
                  </span>
                  <StatusBadge status={m.status} />
                  {m.result_for_me && <span className={`badge result-${m.result_for_me}`}>{S.result[m.result_for_me]}</span>}
                  {(m.status === "completed" || m.status === "running") && (
                    <span className="score score-pair">
                      <span>{m.rounds_me}</span>
                      <span aria-hidden>–</span>
                      <span>{m.rounds_opp}</span>
                    </span>
                  )}
                  <span className="match-date muted small">{new Date(m.created_at).toLocaleDateString("he-IL")}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {cursor && (
          <button className="btn" onClick={loadMore}>
            {S.common.loadMore}
          </button>
        )}
      </section>
    </div>
  );
}
