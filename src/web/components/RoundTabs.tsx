import type { Round } from "../api";
import { useT } from "../i18n";

export default function RoundTabs(props: { rounds: Round[]; selected: number; onSelect: (n: number) => void; winnerLabel: (r: Round) => string }) {
  const S = useT();
  return (
    <div className="tabs" role="tablist">
      {props.rounds.map((r) => (
        <button
          key={r.round_no}
          role="tab"
          aria-selected={props.selected === r.round_no}
          className={`tab ${props.selected === r.round_no ? "active" : ""}`}
          onClick={() => props.onSelect(r.round_no)}
        >
          {S.replay.round(r.round_no)}
          {r.status === "completed" && <small> · <bdi>{props.winnerLabel(r)}</bdi></small>}
        </button>
      ))}
    </div>
  );
}
