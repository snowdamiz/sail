import { useGT } from "gt-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { money } from "../machine";
import type { UiState } from "../types";

export function Costs({ costs }: { readonly costs: UiState["costs"] }) {
  const gt = useGT();
  const ratio = costs.startsLimit > 0 ? Math.min(1, costs.startsToday / costs.startsLimit) : 0;
  const nearLimit = ratio >= 0.8;

  return (
    <footer aria-label={gt("Costs")} className="border-t border-border/50 px-3 pt-5 sm:px-4">
      <div className="grid grid-cols-2 items-start gap-x-8 gap-y-4 sm:grid-cols-3">
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">{gt("Today")}</div>
          <div className="text-base font-semibold tracking-tight text-foreground tabular-nums">
            {money(costs.today)}
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">{gt("This month")}</div>
          <div className="text-base font-semibold tracking-tight text-foreground tabular-nums">
            {money(costs.month)}
          </div>
        </div>

        <Tooltip>
          <TooltipTrigger
            render={
              <div
                tabIndex={0}
                className="col-span-2 max-w-48 space-y-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:col-span-1"
              />
            }
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-muted-foreground">{gt("Starts today")}</span>
              <span
                className={cn(
                  "font-mono text-xs font-medium tabular-nums",
                  nearLimit ? "text-warning-foreground" : "text-foreground",
                )}
              >
                {costs.startsToday}
                <span className="text-muted-foreground">/{costs.startsLimit}</span>
              </span>
            </div>
            <div
              role="meter"
              aria-label={gt("Starts today")}
              aria-valuemin={0}
              aria-valuemax={costs.startsLimit}
              aria-valuenow={costs.startsToday}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <span
                className={cn(
                  "block h-full rounded-full transition-[width] duration-200",
                  nearLimit ? "bg-warning" : "bg-foreground/65",
                )}
                style={{ width: `${ratio * 100}%` }}
              />
            </div>
          </TooltipTrigger>
          <TooltipPopup side="top">{gt("Machine starts used today / daily limit")}</TooltipPopup>
        </Tooltip>
      </div>
    </footer>
  );
}
