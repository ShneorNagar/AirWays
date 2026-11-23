import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, errorMessage } from "../api";
import { useMe } from "../App";
import { LoginRequired } from "../components/Layout";
import { useT } from "../i18n";

const MAX = 1500;
type Field = "defense_prompt" | "attack_prompt";

export default function Submit() {
  const S = useT();
  const { me, loading, refresh } = useMe();
  const [defense, setDefense] = useState("");
  const [attack, setAttack] = useState("");
  const [fieldError, setFieldError] = useState<{ field: Field; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState<number | null>(null);
  const loggedIn = !!me?.user;

  useEffect(() => {
    if (!loggedIn) return;
    api
      .lastVersion()
      .then(({ version }) => {
        if (version) {
          setDefense(version.defense_prompt);
          setAttack(version.attack_prompt);
        }
      })
      .catch(() => {});
  }, [loggedIn]);

  if (loading) return <p className="muted">{S.common.loading}</p>;
  if (!loggedIn) return <LoginRequired />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    setFieldError(null);
    try {
      const res = await api.submitVersion(defense, attack);
      setQueued(res.matches_queued);
      void refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation") {
        setFieldError({ field: err.data.field as Field, code: String(err.data.code) });
      } else {
        setError(errorMessage(err, S));
      }
    } finally {
      setSending(false);
    }
  }

  if (queued !== null) {
    return (
      <div className="card center stack">
        <h1>{S.submit.queued(queued)}</h1>
        <p className="muted">{S.submit.queuedHint}</p>
        <Link className="btn primary" to="/dashboard">
          {S.submit.toDashboard}
        </Link>
      </div>
    );
  }

  const fieldMsg = (f: Field) =>
    fieldError?.field === f ? <p className="error field-error">{S.submit.fieldErrors[fieldError.code] ?? S.common.error}</p> : null;

  return (
    <form className="stack" onSubmit={onSubmit}>
      <h1>{S.submit.title}</h1>
      <PromptBox id="defense" label={S.submit.defense} hint={S.submit.defenseHint} value={defense} onChange={setDefense} invalid={fieldError?.field === "defense_prompt"}>
        {fieldMsg("defense_prompt")}
      </PromptBox>
      <PromptBox id="attack" label={S.submit.attack} hint={S.submit.attackHint} value={attack} onChange={setAttack} invalid={fieldError?.field === "attack_prompt"}>
        {fieldMsg("attack_prompt")}
      </PromptBox>
      <aside className="card rules-box">
        <h2>{S.submit.rulesTitle}</h2>
        <ul className="rules">
          {S.submit.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="muted small">{S.submit.note(me!.est_credits_per_match)}</p>
      </aside>
      {error && <p className="error">{error}</p>}
      <div>
        <button className="btn primary" type="submit" disabled={sending}>
          {sending ? S.submit.sending : S.submit.send}
        </button>
      </div>
    </form>
  );
}

function PromptBox(props: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
  children?: React.ReactNode;
}) {
  const S = useT();
  const len = props.value.trim().length;
  return (
    <div className="card field">
      <label htmlFor={props.id}>{props.label}</label>
      <p className="muted small">{props.hint}</p>
      <textarea
        id={props.id}
        rows={8}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        aria-invalid={props.invalid}
        className={props.invalid ? "invalid" : undefined}
      />
      <div className={`counter ${len > MAX ? "over" : ""}`} dir="ltr">
        {len}/{MAX}
      </div>
      {props.children}
    </div>
  );
}
