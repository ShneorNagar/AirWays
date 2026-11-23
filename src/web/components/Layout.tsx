import type { ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useMe } from "../App";
import { S } from "../strings";

export default function Layout({ children }: { children: ReactNode }) {
  const { me, refresh } = useMe();
  const navigate = useNavigate();
  const user = me?.user ?? null;

  async function logout() {
    try {
      await api.logout();
    } finally {
      await refresh();
      navigate("/");
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-icon" aria-hidden>🔐</span>
          <span>
            {S.appName}
            <small>{S.appTagline}</small>
          </span>
        </Link>
        <nav className="nav">
          <NavLink to="/leaderboard">{S.nav.leaderboard}</NavLink>
          {user && <NavLink to="/dashboard">{S.nav.dashboard}</NavLink>}
          {user?.is_admin && <NavLink to="/admin">{S.nav.admin}</NavLink>}
          {user ? (
            <>
              <span className="balance-chip" title={S.dashboard.balance}>
                {me!.balance} {S.common.credits}
              </span>
              <button className="link-btn" onClick={logout}>
                {S.nav.logout}
              </button>
            </>
          ) : (
            <a href="/api/auth/google/start">{S.nav.login}</a>
          )}
        </nav>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}

export function LoginRequired() {
  return (
    <div className="card center">
      <p>{S.errors.needLogin}</p>
      <a className="btn primary" href="/api/auth/google/start">
        {S.home.login}
      </a>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge status-${status}`}>{S.status[status] ?? status}</span>;
}
