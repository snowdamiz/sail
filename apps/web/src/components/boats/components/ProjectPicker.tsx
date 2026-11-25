import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { call, errorText } from "../api";
import type { LocalProject, MachineView } from "../types";
import { PICK_PROJECT, hasRepo, homePath } from "../machine";
import { useEscape } from "./common";
import { Icon } from "./Icons";

/** "+ Add a project…": one of Sail's projects, added to the machine the way Sail does it. */
export function ProjectPicker({
  m,
  initialOpen,
  onAdd,
}: {
  m: MachineView;
  initialOpen: boolean;
  onAdd: (p: LocalProject) => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="line-add"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="plus" size={10} />
        {PICK_PROJECT.label}
      </button>
      {open ? (
        <Picker
          m={m}
          onClose={close}
          onPick={(p) => {
            close();
            onAdd(p);
          }}
        />
      ) : null}
    </>
  );
}

/** Mounted while open: every open fetches the list fresh and starts with an empty filter. */
function Picker({
  m,
  onClose,
  onPick,
}: {
  m: MachineView;
  onClose: () => void;
  onPick: (p: LocalProject) => void;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const projects = useLocalProjects();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEscape(true, onClose);

  // opened from further down (or from the row's ⋯ menu): bring the whole picker into view
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest" });
  }, []);

  const q = query.trim().toLowerCase();
  // Matches what the row shows (name and ~-path), so the home folder never matches everything.
  const shown = (projects.list ?? []).filter(
    (p) => !q || `${p.title}\n${homePath(p.path)}`.toLowerCase().includes(q),
  );
  const current = Math.min(active, Math.max(shown.length - 1, 0));
  const choose = (i: number) => {
    const p = shown[i];
    if (p && !hasRepo(m, p.repoKey)) onPick(p);
  };

  useEffect(() => {
    box.current?.querySelector(".pick-option.is-active")?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <div ref={box} className="pick">
      <label className="pick-filter">
        <span className="pick-sign" aria-hidden>
          $
        </span>
        <input
          autoFocus
          role="combobox"
          aria-label="Filter projects"
          aria-expanded
          aria-controls={id}
          aria-activedescendant={shown.length ? `${id}-${current}` : undefined}
          placeholder="filter projects"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && shown.length) {
              e.preventDefault();
              setActive((current + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(current);
            }
          }}
        />
      </label>
      <div
        id={id}
        role="listbox"
        aria-label="Projects in Sail"
        aria-busy={!projects.list && !projects.error}
      >
        <div className="pick-scroll" role="presentation">
          <ProjectList
            projects={projects}
            shown={shown}
            query={query}
            option={(p, i) => {
              const there = hasRepo(m, p.repoKey);
              return {
                id: `${id}-${i}`,
                role: "option",
                "aria-selected": i === current,
                "aria-disabled": there,
                className: `pick-option${i === current ? " is-active" : ""}${there ? " is-done" : ""}`,
                onMouseMove: () => setActive(i),
                onClick: () => choose(i),
                badge: there ? (
                  <span className="line-ok">
                    <Icon name="check" size={10} /> on {m.name}
                  </span>
                ) : null,
              };
            }}
          />
        </div>
      </div>
    </div>
  );
}

export interface LocalProjects {
  list: LocalProject[] | null;
  error: string | null;
  retry: () => void;
}

/** Sail's projects that can go to a machine, fetched once per mount. */
export function useLocalProjects(): LocalProjects {
  const [list, setList] = useState<LocalProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    call("local_projects", undefined).then(
      (p) => live && setList(p),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  return {
    list,
    error,
    retry: () => {
      setError(null);
      setAttempt((n) => n + 1);
    },
  };
}

type OptionProps = HTMLAttributes<HTMLDivElement> & { badge?: ReactNode };

/** The list body: projects, an empty or error note, or skeleton rows while loading. */
export function ProjectList({
  projects,
  shown,
  query,
  option,
}: {
  projects: LocalProjects;
  shown: LocalProject[];
  query: string;
  option: (p: LocalProject, i: number) => OptionProps;
}) {
  if (projects.error) {
    return (
      <p className="pick-note caption is-error">
        Couldn't list Sail's projects: {projects.error}
        <button type="button" className="btn btn-link" onClick={projects.retry}>
          Try again
        </button>
      </p>
    );
  }
  if (!projects.list) {
    return (
      <>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="pick-option" aria-hidden>
            <span className="pick-icon skel" />
            <span className="pick-text">
              <span className="skel" style={{ width: `${46 - i * 8}%` }} />
              <span className="skel skel-path" style={{ width: `${70 - i * 6}%` }} />
            </span>
          </div>
        ))}
      </>
    );
  }
  if (!shown.length) {
    return (
      <p className="pick-note caption">
        {query.trim()
          ? `No project matches “${query.trim()}”`
          : "No project in Sail has a git remote yet"}
      </p>
    );
  }
  return (
    <>
      {shown.map((p, i) => {
        const { badge, ...props } = option(p, i);
        return (
          <div key={p.id} {...props}>
            <ProjectIcon project={p} />
            <span className="pick-text">
              <span className="pick-title">
                <span className="pick-name">{p.title}</span>
                {badge}
              </span>
              <span className="pick-path" title={p.path}>
                <bdi>{homePath(p.path)}</bdi>
              </span>
            </span>
          </div>
        );
      })}
    </>
  );
}

/** The project's favicon from Sail, else its initial on a tile. */
function ProjectIcon({ project }: { project: LocalProject }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="pick-icon" aria-hidden>
      {project.icon && !broken ? (
        <img src={project.icon} alt="" onError={() => setBroken(true)} />
      ) : (
        project.title.trim().charAt(0).toUpperCase() || "?"
      )}
    </span>
  );
}
