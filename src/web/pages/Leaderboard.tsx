import { useEffect, useState } from "react";
import { api, errorMessage, type Leaderboard as LB } from "../api";
import { useMe } from "../App";
import { useT } from "../i18n";

export default function Leaderboard() {
  const S = useT();
  const { me } = useMe();
  const [data, setData] = useState<LB | null>(null);
  const [season, setSeason] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .leaderboard(season)
      .then(setData)
      .catch((e) => setError(errorMessage(e, S)));
  }, [season]);

  return (
    <div className="stack">
      <div className="row-between">
        <h1>{S.leaderboard.title}</h1>
        {data && data.seasons.length > 0 && (
          <label className="inline">
            {S.leaderboard.season}{" "}
            <select value={data.season?.id ?? ""} onChange={(e) => setSeason(Number(e.target.value))}>
              {data.seasons.map((s) => (
                <option key={s.id} value={s.id}>
                  {S.seasonName(s.name)} ({s.status === "active" ? S.leaderboard.active : S.leaderboard.closed})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? (
        <p className="muted">{S.common.loading}</p>
      ) : data.rows.length === 0 ? (
        <p className="card muted">{S.leaderboard.empty}</p>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{S.leaderboard.rank}</th>
                <th>{S.leaderboard.name}</th>
                <th>{S.leaderboard.elo}</th>
                <th>{S.leaderboard.record}</th>
                <th className="hide-sm">{S.leaderboard.matches}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.user_id} className={r.user_id === me?.user?.id ? "me-row" : undefined}>
                  <td>{r.rank}</td>
                  <td>
                    {r.is_bot && <span aria-label="bot">🤖 </span>}
                    <bdi>{r.display_name}</bdi>
                  </td>
                  <td dir="ltr">{r.elo.toFixed(1)}</td>
                  <td dir="ltr">
                    {r.wins}/{r.draws}/{r.losses}
                  </td>
                  <td className="hide-sm">{r.matches}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">{S.leaderboard.legend}</p>
        </div>
      )}
    </div>
  );
}
