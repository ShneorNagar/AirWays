import { useState, type FormEvent } from "react";
import { api, errorMessage, type Turn } from "../api";
import { useT } from "../i18n";

export default function TurnCard({ turn, canAppeal }: { turn: Turn; canAppeal: boolean }) {
  const S = useT();
  const cracked = turn.guess_correct === true;
  return (
    <article className={`turn ${cracked ? "turn-cracked" : ""}`}>
      <header className="turn-head">
        <span className="turn-no">
          {cracked && "🔓 "}
          {S.replay.turn(turn.turn_no)}
        </span>
        <span className={`badge task-${turn.task}`}>{S.replay.tasks[turn.task]}</span>
        {turn.guess !== null && (
          <span className={`chip guess ${turn.guess_correct === true ? "ok" : turn.guess_correct === false ? "bad" : "na"}`}>
            {S.replay.guess}: <bdi>{turn.guess}</bdi>{" "}
            {turn.guess_correct === true ? "✅" : turn.guess_correct === false ? "❌" : `(${S.replay.noGuessesLeft})`}
          </span>
        )}
      </header>
      <div className="turn-block">
        <div className="turn-label">{S.replay.content}</div>
        <div className="text" dir="auto">{turn.content || "—"}</div>
      </div>
      {cracked ? (
        <div className="cracked-banner">{S.replay.cracked}</div>
      ) : (
        <>
          <div className="turn-block">
            <div className="turn-label">{S.replay.reply}</div>
            <div className="text reply" dir="auto">{turn.reply || "—"}</div>
          </div>
          {turn.complied !== null && (
            <div className={`verdict ${turn.complied ? "ok" : "strike"}`}>
              {turn.complied ? S.replay.complied : `${S.replay.strike}${turn.reason ? ` — ${turn.reason}` : ""}`}
            </div>
          )}
          {canAppeal && turn.complied === false && <AppealForm turnId={turn.turn_id} />}
        </>
      )}
    </article>
  );
}

function AppealForm({ turnId }: { turnId: string }) {
  const S = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return;
    setState("sending");
    setError(null);
    try {
      await api.appeal(turnId, reason);
      setState("sent");
    } catch (err) {
      setError(errorMessage(err, S));
      setState("idle");
    }
  }

  if (state === "sent") return <p className="muted small">✔ {S.replay.appealSent}</p>;
  if (!open)
    return (
      <button className="btn small" onClick={() => setOpen(true)}>
        {S.replay.appeal}
      </button>
    );
  return (
    <form className="appeal" onSubmit={submit}>
      <label className="small" htmlFor={`appeal-${turnId}`}>
        {S.replay.appealReason}
      </label>
      <textarea id={`appeal-${turnId}`} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && <p className="error small">{error}</p>}
      <div className="actions">
        <button className="btn primary small" type="submit" disabled={state === "sending" || !reason.trim()}>
          {S.common.send}
        </button>
        <button className="btn small" type="button" onClick={() => setOpen(false)}>
          {S.common.cancel}
        </button>
      </div>
    </form>
  );
}
