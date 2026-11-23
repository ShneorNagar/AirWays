import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage, type AdminAppeal, type AdminSettings, type AdminStats } from "../api";
import { useMe } from "../App";
import { LoginRequired } from "../components/Layout";
import { useT } from "../i18n";

export default function Admin() {
  const S = useT();
  const { me, loading } = useMe();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [appeals, setAppeals] = useState<AdminAppeal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = !!me?.user?.is_admin;

  const reload = useCallback(() => {
    Promise.all([api.admin.stats(), api.admin.appeals()])
      .then(([s, a]) => {
        setStats(s);
        setAppeals(a.appeals);
      })
      .catch((e) => setError(errorMessage(e, S)));
  }, []);

  useEffect(() => {
    if (isAdmin) reload();
  }, [isAdmin, reload]);

  if (loading) return <p className="muted">{S.common.loading}</p>;
  if (!me?.user) return <LoginRequired />;
  if (!isAdmin) return <p className="card">{S.errors.notFound}</p>;

  return (
    <div className="stack">
      <h1>{S.admin.title}</h1>
      {error && <p className="error">{error}</p>}

      <ProtectionPanel />

      <section className="card">
        <h2>{S.admin.stats}</h2>
        {!stats ? (
          <p className="muted">{S.common.loading}</p>
        ) : (
          <dl className="stats">
            <Stat label={S.admin.users} value={stats.users} />
            <Stat label={S.admin.versionsThisSeason} value={stats.versions_this_season} />
            <Stat label={S.admin.users2plus} value={stats.users_with_2plus_versions} />
            <Stat
              label={S.admin.resubmitRate}
              value={stats.resubmit_after_loss_rate === null ? "—" : `${Math.round(stats.resubmit_after_loss_rate * 100)}%`}
              highlight
            />
            <Stat label={S.admin.avgCost} value={stats.avg_cost_usd === null ? "—" : `$${stats.avg_cost_usd.toFixed(4)}`} />
            <Stat label={S.admin.creditsCharged} value={stats.credits_charged_total} />
            <Stat
              label={S.admin.matchesByStatus}
              value={
                Object.entries(stats.matches_by_status)
                  .map(([k, v]) => `${S.status[k] ?? k}: ${v}`)
                  .join(" · ") || "—"
              }
            />
          </dl>
        )}
      </section>

      <section className="card">
        <h2>{S.admin.appeals}</h2>
        {!appeals ? (
          <p className="muted">{S.common.loading}</p>
        ) : appeals.length === 0 ? (
          <p className="muted">{S.admin.noAppeals}</p>
        ) : (
          appeals.map((a) => <AppealItem key={a.id} appeal={a} onDone={reload} />)
        )}
      </section>

      <GrantForm />
      <ToggleForm
        title={S.admin.hide}
        idLabel={S.admin.matchId}
        onLabel={S.admin.hideBtn}
        offLabel={S.admin.unhideBtn}
        action={(id, on) => api.admin.hideMatch(id, on)}
      />
      <ToggleForm
        title={S.admin.ban}
        idLabel={S.admin.userId}
        onLabel={S.admin.banBtn}
        offLabel={S.admin.unbanBtn}
        action={(id, on) => api.admin.banUser(id, on)}
      />
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  const S = useT();
  return (
    <div className={`stat-item ${highlight ? "highlight" : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function AppealItem({ appeal, onDone }: { appeal: AdminAppeal; onDone: () => void }) {
  const S = useT();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function resolve(status: "accepted" | "rejected") {
    try {
      await api.admin.resolveAppeal(appeal.id, status, note);
      onDone();
    } catch (e) {
      setError(errorMessage(e, S));
    }
  }
  return (
    <div className="appeal-item">
      <p className="small muted">
        {S.admin.by} <bdi>{appeal.user_name}</bdi> · {new Date(appeal.created_at).toLocaleString(S.locale)} ·{" "}
        <Link to={`/match/${appeal.match_id}`}>{S.admin.openMatch}</Link>
      </p>
      <p className="text" dir="auto">{appeal.reason}</p>
      {appeal.turn && (
        <div className="appeal-turn">
          <div className="turn-label">{S.replay.content}</div>
          <div className="text" dir="auto">{appeal.turn.content}</div>
          <div className="turn-label">{S.replay.reply}</div>
          <div className="text reply" dir="auto">{appeal.turn.reply}</div>
          <div className="verdict strike">
            {S.replay.strike} — {appeal.turn.reason}
          </div>
        </div>
      )}
      <input placeholder={S.admin.adminNote} value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <p className="error small">{error}</p>}
      <div className="actions">
        <button className="btn primary small" onClick={() => resolve("accepted")}>
          {S.admin.accept}
        </button>
        <button className="btn small" onClick={() => resolve("rejected")}>
          {S.admin.reject}
        </button>
      </div>
    </div>
  );
}

function GrantForm() {
  const S = useT();
  const [userId, setUserId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api.admin.grant(userId.trim(), Number(amount), note);
      setMsg(S.admin.grantDone);
      setAmount("");
    } catch (err) {
      setMsg(errorMessage(err, S));
    }
  }
  return (
    <form className="card form-grid" onSubmit={submit}>
      <h2>{S.admin.grant}</h2>
      <input placeholder={S.admin.userId} value={userId} onChange={(e) => setUserId(e.target.value)} dir="ltr" required />
      <input placeholder={S.admin.amount} value={amount} onChange={(e) => setAmount(e.target.value)} type="number" step="1" dir="ltr" required />
      <input placeholder={S.admin.note} value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn primary" type="submit">
        {S.common.save}
      </button>
      {msg && <p className="small">{msg}</p>}
    </form>
  );
}

function ToggleForm(props: {
  title: string;
  idLabel: string;
  onLabel: string;
  offLabel: string;
  action: (id: string, on: boolean) => Promise<unknown>;
}) {
  const S = useT();
  const [id, setId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  async function run(on: boolean) {
    setMsg(null);
    try {
      await props.action(id.trim(), on);
      setMsg(S.admin.done);
    } catch (err) {
      setMsg(errorMessage(err, S));
    }
  }
  return (
    <div className="card form-grid">
      <h2>{props.title}</h2>
      <input placeholder={props.idLabel} value={id} onChange={(e) => setId(e.target.value)} dir="ltr" />
      <div className="actions">
        <button className="btn primary small" disabled={!id.trim()} onClick={() => run(true)}>
          {props.onLabel}
        </button>
        <button className="btn small" disabled={!id.trim()} onClick={() => run(false)}>
          {props.offLabel}
        </button>
      </div>
      {msg && <p className="small">{msg}</p>}
    </div>
  );
}

function ProtectionPanel() {
  const S = useT();
  const [st, setSt] = useState<AdminSettings | null>(null);
  const [daily, setDaily] = useState("");
  const [monthly, setMonthly] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    api.admin
      .settings()
      .then((s) => {
        setSt(s);
        setDaily(String(s.daily_budget_usd));
        setMonthly(String(s.monthly_budget_usd));
      })
      .catch((e) => setMsg(errorMessage(e, S)));
  }, [S]);
  useEffect(load, [load]);

  async function save(s: Parameters<typeof api.admin.saveSettings>[0]) {
    setMsg(null);
    try {
      await api.admin.saveSettings(s);
      setMsg(S.admin.done);
      load();
    } catch (e) {
      setMsg(errorMessage(e, S));
    }
  }

  if (!st) {
    return (
      <section className="card">
        <p className="muted">{S.common.loading}</p>
      </section>
    );
  }
  const usd = (n: number) => `$${n.toFixed(2)}`;
  return (
    <section className={`card protection ${st.matches_paused ? "is-paused" : ""}`}>
      <h2>{S.admin.protection}</h2>
      <p className="muted small">{S.admin.protectionHint}</p>
      <div className="row-between">
        <strong className={st.matches_paused ? "error" : "ok-text"}>{st.matches_paused ? S.admin.paused : S.admin.running}</strong>
        <button className={`btn ${st.matches_paused ? "primary" : "danger"}`} onClick={() => save({ matches_paused: !st.matches_paused })}>
          {st.matches_paused ? S.admin.resume : S.admin.pause}
        </button>
      </div>
      <dl className="stats">
        <Stat label={S.admin.spentToday} value={`${usd(st.spent_today_usd)} / ${usd(st.daily_budget_usd)}`} highlight={st.spent_today_usd >= st.daily_budget_usd} />
        <Stat label={S.admin.spentMonth} value={`${usd(st.spent_month_usd)} / ${usd(st.monthly_budget_usd)}`} highlight={st.spent_month_usd >= st.monthly_budget_usd} />
        <Stat label={S.admin.runningNow} value={st.running_matches} />
        <Stat label={S.admin.canStart} value={st.startable_matches} />
      </dl>
      <form
        className="budget-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ daily_budget_usd: Number(daily), monthly_budget_usd: Number(monthly) });
        }}
      >
        <label>
          {S.admin.dailyBudget}
          <input type="number" min="0" step="0.5" value={daily} onChange={(e) => setDaily(e.target.value)} dir="ltr" />
        </label>
        <label>
          {S.admin.monthlyBudget}
          <input type="number" min="0" step="1" value={monthly} onChange={(e) => setMonthly(e.target.value)} dir="ltr" />
        </label>
        <button className="btn primary" type="submit">
          {S.admin.saveBudgets}
        </button>
      </form>
      {msg && <p className="small">{msg}</p>}
      <p className="muted small">💡 {S.admin.consoleTip}</p>
    </section>
  );
}
