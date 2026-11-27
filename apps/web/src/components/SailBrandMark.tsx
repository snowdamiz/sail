import { SAIL_BACKGROUND, SAIL_ICON_RADIUS, SAIL_MARK_PATHS } from "@t3tools/shared/sailBrand";
import type { SVGProps } from "react";

export function SailBrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
      <rect width={128} height={128} rx={SAIL_ICON_RADIUS} fill={SAIL_BACKGROUND} />
      {SAIL_MARK_PATHS.map(({ d, fill }) => (
        <path key={d} d={d} fill={fill} />
      ))}
    </svg>
  );
}
