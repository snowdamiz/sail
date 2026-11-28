import { useGT } from "gt-react";

import { cn } from "~/lib/utils";
import { SettingsGroup } from "../../settings/SettingsGroup";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { money } from "../machine";
import type { UiState } from "../types";

export function Costs({ costs }: { readonly costs: UiState["costs"] }) {
  const gt = useGT();
  const ratio = costs.startsLimit > 0 ? costs.startsToday / costs.startsLimit : 0;
  const nearLimit = ratio >= 0.8;

  return (
    <footer aria-label={gt("Costs")}>
      <SettingsGroup divided={false} className="overflow-hidden bg-card">
        <div className="grid grid-cols-1 divide-y divide-border/50 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="flex flex-col gap-0.5 px-4 py-3">
            <span className="text-xs text-muted-foreground">{gt("Today")}</span>
            <span className="font-mono text-sm font-medium text-foreground tabular-nums">
              {money(costs.today)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 px-4 py-3">
            <span className="text-xs text-muted-foreground">{gt("This month")}</span>
            <span className="font-mono text-sm font-medium text-foreground tabular-nums">
              {money(costs.month)}
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <div
                  tabIndex={0}
                  className="flex flex-col gap-0.5 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
            >
              <span className="text-xs text-muted-foreground">{gt("Starts today")}</span>
              <span
                className={cn(
                  "font-mono text-sm font-medium tabular-nums",
                  nearLimit ? "text-warning-foreground" : "text-foreground",
                )}
              >
                {costs.startsToday}
                <span className="text-muted-foreground">/{costs.startsLimit}</span>
              </span>
            </TooltipTrigger>
            <TooltipPopup>{gt("Machine starts used today / daily limit")}</TooltipPopup>
          </Tooltip>
        </div>
      </SettingsGroup>
    </footer>
  );
}
