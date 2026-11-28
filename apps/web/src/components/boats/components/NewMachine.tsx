import { useGT } from "gt-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { SettingsGroup } from "../../settings/SettingsGroup";
import { Button } from "../../ui/button";
import { CheckboxMark } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { useBoatAccess } from "../access";
import { NAME_RE, cleanName, suggestName } from "../machine";
import type { UiState } from "../types";
import { MachineSizePicker } from "./MachineSizePicker";
import { ProjectList, useLocalProjects } from "./ProjectPicker";

export interface CreateMachineInput {
  readonly name: string;
  readonly size: string;
  readonly projects: string[];
}

function LocalProjectsSection({
  picked,
  onToggle,
}: {
  readonly picked: readonly string[];
  readonly onToggle: (id: string) => void;
}) {
  const gt = useGT();
  const projects = useLocalProjects();

  return (
    <SettingsGroup divided={false} className="bg-card">
      <div className="p-4 sm:p-5">
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-foreground">{gt("Projects")}</legend>
          <p className="text-xs text-muted-foreground">
            {gt("Optional · cloned from git once it's up, .env files included")}
          </p>
          <div
            role="group"
            aria-label={gt("Projects to add")}
            className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-border/60 bg-background/50 p-1"
          >
            <ProjectList
              projects={projects}
              shown={projects.list ?? []}
              query=""
              option={(project) => {
                const on = picked.includes(project.id);
                const sameRepo =
                  !on &&
                  (projects.list ?? []).some(
                    (other) => other.repoKey === project.repoKey && picked.includes(other.id),
                  );
                const flip = () => {
                  if (!sameRepo) onToggle(project.id);
                };
                return {
                  role: "checkbox",
                  tabIndex: 0,
                  "aria-checked": on,
                  "aria-disabled": sameRepo,
                  className: cn(
                    "flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    sameRepo
                      ? "cursor-not-allowed opacity-55"
                      : on
                        ? "cursor-pointer bg-accent/60"
                        : "cursor-pointer hover:bg-accent/40",
                  ),
                  onClick: flip,
                  onKeyDown: (event: KeyboardEvent) => {
                    if (event.key === " " || event.key === "Enter") {
                      event.preventDefault();
                      flip();
                    }
                  },
                  leading: <CheckboxMark checked={on} />,
                };
              }}
            />
          </div>
        </fieldset>
      </div>
    </SettingsGroup>
  );
}

export function NewMachine({
  state,
  supportsLocalProjects,
  canCreate,
  onCreate,
  onCancel,
}: {
  readonly state: UiState;
  readonly supportsLocalProjects: boolean;
  readonly canCreate: boolean;
  readonly onCreate: (input: CreateMachineInput) => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  const access = useBoatAccess();
  const taken = state.machines.map((m) => m.name);
  const [name, setName] = useState(() => suggestName(taken));
  const [size, setSize] = useState(() =>
    state.sizes.some((s) => s.id === "default") ? "default" : (state.sizes[0]?.id ?? ""),
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<string[]>([]);

  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- selects the suggested machine name in the input DOM node on mount
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const problem = !name
    ? gt("Give it a name")
    : !NAME_RE.test(name)
      ? gt("Start with a letter or number")
      : taken.includes(name)
        ? gt("You already have a machine with this name")
        : null;

  const selectedProjects = supportsLocalProjects ? picked : [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!problem && size && canCreate) {
      onCreate({ name, size, projects: selectedProjects });
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <SettingsGroup divided={false} className="bg-card">
        <div className="space-y-2 p-4 sm:p-5">
          <Label htmlFor="machine-name">{gt("Name")}</Label>
          <Input
            id="machine-name"
            ref={inputRef}
            font="mono"
            aria-describedby="machine-name-hint"
            aria-invalid={!!problem}
            value={name}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setName(cleanName(event.target.value))}
          />
          <p
            id="machine-name-hint"
            className={cn(
              "text-xs",
              problem && name ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {problem ?? gt("Shows up under this name in Sail")}
          </p>
        </div>
      </SettingsGroup>

      <SettingsGroup divided={false} className="bg-card">
        <div className="p-4 sm:p-5">
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-foreground">{gt("Size")}</legend>
            <MachineSizePicker sizes={state.sizes} value={size} onChange={setSize} name="size" />
            <p className="text-xs text-muted-foreground">
              {gt("Billed only while awake · sleeps 3 min after agents finish · resize anytime")}
            </p>
          </fieldset>
        </div>
      </SettingsGroup>

      {supportsLocalProjects ? <LocalProjectsSection picked={picked} onToggle={toggle} /> : null}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <p className="text-xs text-muted-foreground">
          {selectedProjects.length > 0
            ? selectedProjects.length === 1
              ? gt("Takes about a minute, then 1 project.")
              : gt("Takes about a minute, then {count} projects.", {
                  count: selectedProjects.length,
                })
            : gt("Takes about a minute.")}
          {access.onHost ? ` ${gt("Sail will ask to add it.")}` : ""}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {gt("Cancel")}
          </Button>
          <Button
            type="submit"
            variant="default"
            size="sm"
            disabled={!!problem || !size || !canCreate}
          >
            {gt("Launch machine")}
          </Button>
        </div>
      </div>
    </form>
  );
}
