import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { MachineState } from "../types";
import { useAnimation, useDevicePixelRatio, useReducedMotion, useTheme } from "../pixel/clock";
import { Px } from "../pixel/px";
import { paintSea, seaFor } from "../pixel/paint";
import { stateTag } from "../machine";

export interface OceanBoat {
  key: string;
  name: string;
  state: MachineState;
  /** tag text instead of the state word */
  label?: string;
  /** clickable (opens its details) */
  pickable?: boolean;
}

/** The signature strip: a pixel sea with one boat per machine. */
interface Props {
  boats: OceanBoat[];
  /** key of the boat to call out (hovered row, draft boat) */
  active?: string | null;
  /** shorter strip for sub-views: keeps the boats, crops the sky */
  compact?: boolean;
  /** a pickable boat was clicked */
  onPick?: (key: string) => void;
  children?: ReactNode;
}

/** How close (CSS px) the active boat may get to the strip's edge before it scrolls into view. */
const FOLLOW_MARGIN = 40;
/** Tags keep this far (CSS px) from the sea's ends, sliding off-centre from their boat if they must. */
const TAG_INSET = 4;

export function Ocean({ boats, active, compact, onPick, children }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const buffer = useRef<Px | null>(null);
  const tags = useRef(new Map<string, HTMLSpanElement>());
  const hits = useRef(new Map<string, HTMLButtonElement>());
  const theme = useTheme();
  const reduced = useReducedMotion();
  const dpr = useDevicePixelRatio();
  const sea = useMemo(() => seaFor(boats.length, dpr), [boats.length, dpr]);
  const showAllTags = boats.length <= 4;
  const activeIndex = boats.findIndex((b) => b.key === active);

  const signature = boats.map((b) => `${b.key}:${b.state}`).join("|");

  useAnimation(
    (t) => {
      const ctx = canvas.current?.getContext("2d");
      if (!ctx) return;
      if (buffer.current?.w !== sea.w || buffer.current.h !== sea.h)
        buffer.current = new Px(sea.w, sea.h);
      const px = buffer.current;
      const worldW = sea.w * sea.scale;
      paintSea(px, sea, theme, boats, t).forEach((a, key) => {
        const x = a.x * sea.scale;
        const tag = tags.current.get(key);
        if (tag) {
          const half = tag.offsetWidth / 2;
          const tx = Math.min(Math.max(x, half + TAG_INSET), worldW - half - TAG_INSET);
          tag.style.transform = `translate(${tx}px, ${(a.y - 1) * sea.scale}px) translate(-50%, -100%)`;
        }
        const hit = hits.current.get(key);
        if (hit) hit.style.transform = `translate(${x}px, ${a.y * sea.scale}px) translate(-50%, 0)`;
      });
      px.blit(ctx);
    },
    [theme, signature, active, sea],
  );

  // a wide sea follows the boat being called out
  useEffect(() => {
    const el = scroller.current;
    const slot = activeIndex >= 0 ? sea.boats[activeIndex] : undefined;
    if (!el || !slot) return;
    const x = slot.cx * sea.scale;
    if (x >= el.scrollLeft + FOLLOW_MARGIN && x <= el.scrollLeft + el.clientWidth - FOLLOW_MARGIN)
      return;
    el.scrollTo({ left: x - el.clientWidth / 2, behavior: reduced ? "auto" : "smooth" });
  }, [activeIndex, sea, reduced]);

  return (
    <div className={`ocean${compact ? " is-compact" : ""}`}>
      <div
        ref={scroller}
        className={`ocean-scroll${sea.scrolls ? " is-scrolling" : ""}`}
        // a mouse wheel scrolls the sea sideways
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        <div
          className="ocean-world"
          style={
            {
              width: sea.w * sea.scale,
              height: sea.h * sea.scale,
              "--sea-scale": sea.scale,
            } as CSSProperties
          }
        >
          <canvas ref={canvas} width={sea.w} height={sea.h} className="ocean-canvas" aria-hidden />
          <div className="ocean-tags" aria-hidden>
            {boats.map((b) => {
              const isActive = active === b.key;
              if (!showAllTags && !isActive && b.state !== "error") return null;
              return (
                <span
                  key={b.key}
                  ref={(el) => {
                    if (el) tags.current.set(b.key, el);
                    else tags.current.delete(b.key);
                  }}
                  className={`tag tag-${b.state}${isActive ? " is-active" : ""}`}
                >
                  {b.label ?? (isActive ? b.name : stateTag(b.state))}
                </span>
              );
            })}
          </div>
          {onPick ? (
            <div className="ocean-hits" aria-hidden>
              {boats.map((b) =>
                b.pickable ? (
                  <button
                    key={b.key}
                    ref={(el) => {
                      if (el) hits.current.set(b.key, el);
                      else hits.current.delete(b.key);
                    }}
                    className="ocean-hit"
                    tabIndex={-1}
                    aria-label={`Details for ${b.name}`}
                    onClick={() => onPick(b.key)}
                  />
                ) : null,
              )}
            </div>
          ) : null}
        </div>
      </div>
      {children}
    </div>
  );
}
