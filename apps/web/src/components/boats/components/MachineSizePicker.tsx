import { useId } from "react";

import { cn } from "~/lib/utils";
import { hourly } from "../machine";
import type { Size } from "../types";

export function MachineSizePicker({
  sizes,
  value,
  onChange,
  ariaLabel,
  name,
  isOptionDisabled,
}: {
  readonly sizes: readonly Size[];
  readonly value: string;
  readonly onChange: (sizeId: string) => void;
  readonly ariaLabel?: string;
  readonly name?: string;
  readonly isOptionDisabled?: (size: Size) => boolean;
}) {
  const generatedName = useId();
  const groupName = name ?? generatedName;

  return (
    <div
      role={ariaLabel ? "radiogroup" : undefined}
      aria-label={ariaLabel}
      className="grid grid-cols-1 gap-2.5 sm:grid-cols-3"
    >
      {sizes.map((choice) => {
        const selected = value === choice.id;
        const disabled = isOptionDisabled ? isOptionDisabled(choice) : false;
        return (
          <label
            key={choice.id}
            className={cn(
              "group relative flex flex-col justify-between gap-2.5 rounded-lg border p-3.5 transition-all has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring",
              disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer",
              selected
                ? "border-foreground/30 bg-accent/50 text-foreground shadow-xs/5"
                : cn(
                    "border-border/60 bg-background/40 text-foreground",
                    !disabled && "hover:border-border hover:bg-accent/25",
                  ),
            )}
          >
            <input
              type="radio"
              name={groupName}
              value={choice.id}
              checked={selected}
              disabled={disabled}
              onChange={() => {
                if (choice.id !== value && !disabled) {
                  onChange(choice.id);
                }
              }}
              className="sr-only"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm font-semibold">{choice.id}</span>
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                  selected
                    ? "border-foreground bg-foreground"
                    : "border-border bg-transparent group-hover:border-muted-foreground/60",
                )}
              >
                {selected ? <span className="size-1.5 rounded-full bg-background" /> : null}
              </span>
            </div>
            <div className="space-y-0.5">
              <span className="block text-xs text-muted-foreground">{choice.spec}</span>
              <span className="block font-mono text-xs font-medium text-foreground tabular-nums">
                {hourly(choice.hourly)}
              </span>
            </div>
          </label>
        );
      })}
    </div>
  );
}
