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
              "relative flex flex-col gap-0.5 rounded-lg border px-3.5 py-3 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring",
              disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer",
              selected
                ? "border-ring bg-accent/60 text-foreground"
                : cn(
                    "border-border/70 bg-background/60 text-foreground",
                    !disabled && "hover:bg-accent/30",
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
            <span className="font-mono text-sm font-medium">{choice.id}</span>
            <span className="text-xs text-muted-foreground">{choice.spec}</span>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {hourly(choice.hourly)}
            </span>
          </label>
        );
      })}
    </div>
  );
}
