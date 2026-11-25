import { SAIL_HULL_PATH, SAIL_JIB_PATH, SAIL_MAIN_PATH } from "@t3tools/shared/sailBrand";
import type { SVGProps } from "react";

export function SailBrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="18 16 92 98" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d={SAIL_MAIN_PATH} fill="var(--color-sky-400)" />
      <path d={SAIL_JIB_PATH} fill="currentColor" />
      <path d={SAIL_HULL_PATH} fill="var(--color-sky-500)" />
    </svg>
  );
}
