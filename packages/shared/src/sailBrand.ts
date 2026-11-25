export const SAIL_BACKGROUND = "#091524";
export const SAIL_BACKGROUND_TOP = "#10253F";
export const SAIL_BORDER = "#7DD3FC";
export const SAIL_PRIMARY = "#38BDF8";
export const SAIL_SECONDARY = "#E0F2FE";
export const SAIL_WAKE = "#0EA5E9";

/**
 * Geometric dual-sail + hull mark on a 128x128 viewBox.
 * Main spinnaker (right), forward jib (left), and sleek hull arc below.
 */
export const SAIL_MAIN_PATH =
  "M66 20C82 37 96 60 98 86L66 86Z";
export const SAIL_JIB_PATH =
  "M58 34C46 50 35 67 28 86L58 86Z";
export const SAIL_HULL_PATH =
  "M22 93C38 103 88 103 106 93C98 105 82 110 64 110C46 110 30 105 22 93Z";

export const SAIL_MARK_PATH = `${SAIL_MAIN_PATH} ${SAIL_JIB_PATH} ${SAIL_HULL_PATH}`;

export const SAIL_LOGO_CONTENT = [
  `<defs><linearGradient id="sail-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${SAIL_BACKGROUND_TOP}"/><stop offset="100%" stop-color="${SAIL_BACKGROUND}"/></linearGradient></defs>`,
  `<rect width="128" height="128" rx="28" fill="url(#sail-bg)"/>`,
  `<rect x=".5" y=".5" width="127" height="127" rx="27.5" fill="none" stroke="${SAIL_BORDER}" stroke-opacity=".18"/>`,
  `<path d="${SAIL_MAIN_PATH}" fill="${SAIL_PRIMARY}"/>`,
  `<path d="${SAIL_JIB_PATH}" fill="${SAIL_SECONDARY}"/>`,
  `<path d="${SAIL_HULL_PATH}" fill="${SAIL_WAKE}"/>`,
].join("");

export const SAIL_LOGO_SVG = `<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">${SAIL_LOGO_CONTENT}</svg>`;

export const SAIL_NIGHTLY_LOGO_CONTENT = [
  `<defs><linearGradient id="sail-bg-n" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1E1B4B"/><stop offset="100%" stop-color="#0B1120"/></linearGradient></defs>`,
  `<rect width="128" height="128" rx="28" fill="url(#sail-bg-n)"/>`,
  `<rect x=".5" y=".5" width="127" height="127" rx="27.5" fill="none" stroke="#A78BFA" stroke-opacity=".22"/>`,
  `<path d="${SAIL_MAIN_PATH}" fill="#818CF8"/>`,
  `<path d="${SAIL_JIB_PATH}" fill="#E0E7FF"/>`,
  `<path d="${SAIL_HULL_PATH}" fill="#38BDF8"/>`,
].join("");

export const SAIL_NIGHTLY_LOGO_SVG = `<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">${SAIL_NIGHTLY_LOGO_CONTENT}</svg>`;

export const SAIL_DEV_LOGO_CONTENT = [
  `<defs><linearGradient id="sail-bg-d" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0F354A"/><stop offset="100%" stop-color="#082032"/></linearGradient></defs>`,
  `<rect width="128" height="128" rx="28" fill="url(#sail-bg-d)"/>`,
  `<rect x=".5" y=".5" width="127" height="127" rx="27.5" fill="none" stroke="#2DD4BF" stroke-opacity=".24"/>`,
  `<path d="${SAIL_MAIN_PATH}" fill="#2DD4BF"/>`,
  `<path d="${SAIL_JIB_PATH}" fill="#CCFBF1"/>`,
  `<path d="${SAIL_HULL_PATH}" fill="#38BDF8"/>`,
].join("");

export const SAIL_DEV_LOGO_SVG = `<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">${SAIL_DEV_LOGO_CONTENT}</svg>`;
