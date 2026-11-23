import type { Round } from "../api";
import { S } from "../strings";

export default function RoundTabs(props: { rounds: Round[]; selected: number; onSelect: (n: number) => void; winnerLabel: (r: Round) => string }) {
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
          {r.status === "completed" && <small> · {props.winnerLabel(r)}</small>}
        </button>
      ))}
    </div>
  );
}
