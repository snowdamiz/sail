import { useGT } from "gt-react";
import { AlertTriangleIcon, CheckIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Alert, AlertAction, AlertDescription } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../ui/input-group";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Skeleton } from "../../ui/skeleton";
import { useBoatCall } from "../api";
import { hasRepo, homePath } from "../machine";
import { errorText } from "../reply";
import type { LocalProject, MachineView } from "../types";

export function ProjectPicker({
  m,
  initialOpen,
  disabled,
  onAdd,
}: {
  readonly m: MachineView;
  readonly initialOpen: boolean;
  readonly disabled: boolean;
  readonly onAdd: (project: LocalProject) => void;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(initialOpen);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="xs" variant="outline" disabled={disabled} />}>
        <PlusIcon aria-hidden="true" className="size-3.5" />
        {gt("Add a project…")}
      </PopoverTrigger>
      <PopoverPopup align="start" width="md" padding="compact">
        {open ? (
          <PickerBody
            m={m}
            onPick={(project) => {
              setOpen(false);
              onAdd(project);
            }}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

function PickerBody({
  m,
  onPick,
}: {
  readonly m: MachineView;
  readonly onPick: (project: LocalProject) => void;
}) {
  const gt = useGT();
  const listboxId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const projects = useLocalProjects();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const q = query.trim().toLowerCase();
  const shown = (projects.list ?? []).filter(
    (p) => !q || `${p.title}\n${homePath(p.path)}`.toLowerCase().includes(q),
  );
  const current = Math.min(active, Math.max(shown.length - 1, 0));

  const choose = (index: number) => {
    const project = shown[index];
    if (project && !hasRepo(m, project.repoKey)) onPick(project);
  };

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <div className="space-y-2">
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus
          size="sm"
          font="mono"
          role="combobox"
          aria-label={gt("Filter projects")}
          aria-expanded={true}
          aria-controls={listboxId}
          aria-activedescendant={shown.length ? `${listboxId}-${current}` : undefined}
          placeholder={gt("Filter projects…")}
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && shown.length) {
              event.preventDefault();
              setActive(
                (current + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length,
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(current);
            }
          }}
        />
      </InputGroup>

      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label={gt("Projects in Sail")}
        aria-busy={!projects.list && !projects.error}
        className="max-h-60 space-y-0.5 overflow-y-auto"
      >
        <ProjectList
          projects={projects}
          shown={shown}
          query={query}
          option={(project, index) => {
            const attached = hasRepo(m, project.repoKey);
            const isActive = index === current;
            return {
              id: `${listboxId}-${index}`,
              role: "option",
              "aria-selected": isActive,
              "aria-disabled": attached,
              "data-active": isActive ? "true" : undefined,
              className: cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
                attached
                  ? "cursor-default opacity-60"
                  : isActive
                    ? "cursor-pointer bg-accent text-accent-foreground"
                    : "cursor-pointer hover:bg-accent/60",
              ),
              onMouseMove: () => setActive(index),
              onClick: () => choose(index),
              badge: attached ? (
                <Badge size="sm" variant="success">
                  <CheckIcon aria-hidden="true" className="size-3" />
                  {gt("on {name}", { name: m.name })}
                </Badge>
              ) : null,
            };
          }}
        />
      </div>
    </div>
  );
}

export interface LocalProjects {
  readonly list: LocalProject[] | null;
  readonly error: string | null;
  readonly retry: () => void;
}

export function useLocalProjects(): LocalProjects {
  const call = useBoatCall();
  const [list, setList] = useState<LocalProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void call("local_projects", undefined).then(
      ({ data }) => {
        if (live) setList(data);
      },
      (err) => {
        if (live) setError(errorText(err));
      },
    );
    return () => {
      live = false;
    };
  }, [attempt, call]);

  return {
    list,
    error,
    retry: () => {
      setError(null);
      setAttempt((n) => n + 1);
    },
  };
}

type OptionProps = HTMLAttributes<HTMLDivElement> & {
  badge?: ReactNode;
  leading?: ReactNode;
  "data-active"?: string;
};

export function ProjectList({
  projects,
  shown,
  query,
  option,
}: {
  readonly projects: LocalProjects;
  readonly shown: readonly LocalProject[];
  readonly query: string;
  readonly option: (project: LocalProject, index: number) => OptionProps;
}) {
  const gt = useGT();

  if (projects.error) {
    return (
      <Alert variant="error" className="my-1">
        <AlertTriangleIcon aria-hidden="true" />
        <AlertDescription>
          {gt("Couldn't list Sail's projects: {error}", { error: projects.error })}
        </AlertDescription>
        <AlertAction>
          <Button size="xs" variant="outline" onClick={projects.retry}>
            {gt("Try again")}
          </Button>
        </AlertAction>
      </Alert>
    );
  }

  if (!projects.list) {
    return (
      <div className="space-y-2 p-1" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-2.5 px-1 py-1">
            <Skeleton shape="card" className="size-6 shrink-0" />
            <div className="min-w-0 flex-1 space-y-1">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-44" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!shown.length) {
    return (
      <p className="px-2 py-4 text-center text-xs text-muted-foreground">
        {query.trim()
          ? gt("No project matches “{query}”", { query: query.trim() })
          : gt("No project in Sail has a git remote yet")}
      </p>
    );
  }

  return (
    <>
      {shown.map((project, index) => {
        const { badge, leading, ...props } = option(project, index);
        return (
          <div key={project.id} {...props}>
            {leading}
            <ProjectIcon project={project} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-foreground">
                  {project.title}
                </span>
                {badge}
              </span>
              <span
                className="block truncate font-mono text-xs text-muted-foreground"
                title={project.path}
              >
                <bdi>{homePath(project.path)}</bdi>
              </span>
            </span>
          </div>
        );
      })}
    </>
  );
}

function ProjectIcon({ project }: { readonly project: LocalProject }) {
  const [broken, setBroken] = useState(false);
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/50 text-xs font-medium text-muted-foreground"
    >
      {project.icon && !broken ? (
        <img
          src={project.icon}
          alt=""
          className="size-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        project.title.trim().charAt(0).toUpperCase() || "?"
      )}
    </span>
  );
}
