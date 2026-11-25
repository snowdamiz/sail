import type { UiState } from "../types";
import { money } from "../machine";

export function Costs({ costs }: { costs: UiState["costs"] }) {
  const ratio = costs.startsLimit > 0 ? costs.startsToday / costs.startsLimit : 0;
  return (
    <footer className="costs" aria-label="Costs">
      <div className="cost">
        <span className="caption">today</span>
        <span className="cost-value">{money(costs.today)}</span>
      </div>
      <div className="cost">
        <span className="caption">this month</span>
        <span className="cost-value">{money(costs.month)}</span>
      </div>
      <div
        className={`cost${ratio >= 0.8 ? " is-warn" : ""}`}
        title="Machine starts used today / daily limit"
      >
        <span className="caption">starts today</span>
        <span className="cost-value">
          {costs.startsToday}
          <span className="cost-of">/{costs.startsLimit}</span>
        </span>
      </div>
    </footer>
  );
}
