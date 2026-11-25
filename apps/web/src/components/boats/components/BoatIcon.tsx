import { useRef } from "react";
import type { MachineState } from "../types";
import { useAnimation, useTheme } from "../pixel/clock";
import { ICON_H, ICON_W, paintBoatIcon } from "../pixel/paint";
import { Px } from "../pixel/px";

/** A machine's boat on its own patch of water, for list rows. */
export function BoatIcon({ state, seed }: { state: MachineState; seed: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const buffer = useRef<Px | null>(null);
  const theme = useTheme();

  useAnimation(
    (t) => {
      const ctx = canvas.current?.getContext("2d");
      if (!ctx) return;
      const px = (buffer.current ??= new Px(ICON_W, ICON_H));
      paintBoatIcon(px, theme, state, seed, t);
      px.blit(ctx);
    },
    [theme, state, seed],
  );

  return <canvas ref={canvas} width={ICON_W} height={ICON_H} className="boat-icon" aria-hidden />;
}
