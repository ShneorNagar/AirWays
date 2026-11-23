import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, api, errorMessage, type Channel, type Replay, type Round } from "../api";
import { useMe } from "../App";
import { LoginRequired, StatusBadge } from "../components/Layout";
import RoundTabs from "../components/RoundTabs";
import TurnCard from "../components/TurnCard";
import { useT } from "../i18n";

const POLL_MS = 5000;
type Side = "a" | "b";
const other = (s: Side): Side => (s === "a" ? "b" : "a");

export default function MatchReplay() {
  const S = useT();
  const { id = "" } = useParams();
  const { me, loading } = useMe();
  const [data, setData] = useState<Replay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState<number | null>(null);
  const [mobileView, setMobileView] = useState<"mine" | "theirs">("mine");
  const loggedIn = !!me?.user;

  useEffect(() => {
    if (!loggedIn) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const d = await api.match(id);
        if (cancelled) return;
        setData(d);
        setError(null);
        if (d.status === "pending" || d.status === "running") timer = setTimeout(load, POLL_MS);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiError && e.status === 404 ? S.errors.notFound : errorMessage(e, S));
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, loggedIn]);

  if (loading) return <p className="muted">{S.common.loading}</p>;
  if (!loggedIn) return <LoginRequired />;
  if (error && !data) return <p className="card error">{error}</p>;
  if (!data) return <p className="muted">{S.common.loading}</p>;

  const names: Record<Side, string> = { a: data.players.a.display_name, b: data.players.b.display_name };
  const mySide: Side = data.me ?? "a";
  const selectedNo = round ?? data.rounds[data.rounds.length - 1]?.round_no ?? 1;
  const current = data.rounds.find((r) => r.round_no === selectedNo) ?? null;
  const winnerLabel = (r: Round) => (r.winner === "draw" ? S.replay.draw : r.winner ? names[r.winner] : "");

  // A channel is named after its attacker's side; its defender holds the other side's secret.
  const columns: { side: Side; key: "mine" | "theirs"; title: string }[] = data.me
    ? [
        { side: mySide, key: "mine", title: S.replay.myAttack },
        { side: other(mySide), key: "theirs", title: S.replay.theirAttack },
      ]
    : (["a", "b"] as const).map((s) => ({
        side: s,
        key: s === "a" ? "mine" : "theirs",
        title: `${S.replay.attackOf(names[s])} ← ${S.replay.defenderOf(names[other(s)])}`,
      }));

  return (
    <div className="stack">
      <header className="card match-head">
        <div className="players">
          <span className={`player ${data.result === "a" ? "winner" : ""}`}><bdi>{names.a}</bdi></span>
          {/* Flex follows RTL: A's score sits next to A's name (right), B's next to B's. */}
          <span className="score big score-pair">
            <span>{data.rounds_a}</span>
            <span aria-hidden>–</span>
            <span>{data.rounds_b}</span>
          </span>
          <span className={`player ${data.result === "b" ? "winner" : ""}`}><bdi>{names.b}</bdi></span>
        </div>
        <div className="row-center">
          <StatusBadge status={data.status} />
          {data.status === "completed" && data.result && (
            <span className="muted">{data.result === "draw" ? S.replay.draw : S.replay.winner(names[data.result])}</span>
          )}
        </div>
        {(data.status === "running" || data.status === "pending") && (
          <p className="muted small live">{data.status === "running" ? S.replay.live : S.replay.pending}</p>
        )}
        {data.admin && (
          <p className="muted small" dir="ltr">
            ${(data.admin.cost_usd_micro / 1e6).toFixed(4)} · hold {data.admin.hold_credits} · charged {data.admin.charged_credits}
            {data.admin.hidden ? " · hidden" : ""}
            {data.admin.error ? ` · ${data.admin.error}` : ""}
          </p>
        )}
      </header>

      {data.rounds.length > 0 && <RoundTabs rounds={data.rounds} selected={selectedNo} onSelect={setRound} winnerLabel={winnerLabel} />}

      {current && (
        <section className="stack">
          <div className="card round-info">
            {current.status === "completed" && (
              <p>
                <strong>{S.replay.roundWinner}:</strong> <bdi>{winnerLabel(current)}</bdi>
                {current.end_reason && ` (${S.replay.endReasons[current.end_reason] ?? current.end_reason}, ${S.replay.turn(current.end_turn ?? 0)})`}
              </p>
            )}
            {current.secrets ? (
              <p>
                <strong>{S.replay.secretOf(names.a)}:</strong> <bdi className="secret">{current.secrets.a}</bdi> ·{" "}
                <strong>{S.replay.secretOf(names.b)}:</strong> <bdi className="secret">{current.secrets.b}</bdi>
              </p>
            ) : (
              <p className="muted small">{S.replay.secretsHidden}</p>
            )}
          </div>

          <div className="view-toggle" role="tablist">
            {columns.map((c) => (
              <button key={c.key} className={`tab ${mobileView === c.key ? "active" : ""}`} onClick={() => setMobileView(c.key)}>
                {c.title}
              </button>
            ))}
          </div>

          <div className="columns">
            {columns.map((c) => (
              <ChannelColumn
                key={c.key}
                title={c.title}
                channel={current.channels[c.side]}
                hiddenOnMobile={mobileView !== c.key}
                // Appeals: only on strikes against MY defender (the channel where the other side attacks).
                canAppeal={data.me !== null && c.side === other(mySide)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ChannelColumn(props: { title: string; channel: Channel | undefined; hiddenOnMobile: boolean; canAppeal: boolean }) {
  const S = useT();
  const ch = props.channel;
  return (
    <div className={`column ${props.hiddenOnMobile ? "hide-mobile" : ""}`}>
      <h3 className="column-title">{props.title}</h3>
      {ch && (
        <p className="muted small">
          {S.replay.channelStatus[ch.status]} · {S.replay.guesses(ch.guesses_used)} · {S.replay.strikes(ch.strikes)}
        </p>
      )}
      {!ch || ch.turns.length === 0 ? (
        <p className="muted">{S.replay.noTurns}</p>
      ) : (
        ch.turns.map((t) => <TurnCard key={t.turn_id} turn={t} canAppeal={props.canAppeal} />)
      )}
    </div>
  );
}
