import { Link } from "react-router-dom";
import { useMe } from "../App";
import { S } from "../strings";

export default function Home() {
  const { me } = useMe();
  return (
    <div className="stack">
      <section className="hero card">
        <h1>{S.home.title}</h1>
        <p>{S.home.p1}</p>
        <p>{S.home.p2}</p>
        <p>{S.home.p3}</p>
        <div className="actions">
          {me?.user ? (
            <Link className="btn primary" to="/dashboard">
              {S.home.toDashboard}
            </Link>
          ) : (
            <a className="btn primary google" href="/api/auth/google/start">
              {S.home.login}
            </a>
          )}
          <Link className="btn" to="/leaderboard">
            {S.home.toLeaderboard}
          </Link>
        </div>
        {!me?.user && <p className="muted small">{S.home.bonus}</p>}
      </section>
      <section className="card">
        <h2>{S.home.rulesTitle}</h2>
        <ul className="rules">
          {S.home.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
