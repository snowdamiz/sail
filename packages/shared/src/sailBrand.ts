export const SAIL_BACKGROUND = "#1C1C1C";
export const SAIL_CYAN = "#00E5FC";
export const SAIL_ICON_RADIUS = 26;

export const SAIL_MARK_PATHS = [
  {
    d: "M69.4 35.4C49.2 42.4 24.7 60.1 19 91.8C28.2 89.2 38.1 87.8 47.8 87.6C50.7 67.6 58.6 49.6 69.4 35.4Z",
    fill: SAIL_CYAN,
  },
  {
    d: "M102 18.2C77.5 30.6 58.8 56.3 52.2 92C68 91.4 86.2 88.6 100.8 83.6C91.9 60.8 93.4 42.3 102 18.2Z",
    fill: "#F8FAFC",
  },
  {
    d: "M29.4 97.2C59.2 96.6 86.6 92.7 109.6 87.6L101.8 96.6C99.9 98.7 97.5 99.7 92.7 100.6C73.4 104.1 54.9 104.9 36.2 102.9C33.4 102.7 31.8 100.1 29.4 97.2Z",
    fill: SAIL_CYAN,
  },
];

export const SAIL_MARK_CONTENT = SAIL_MARK_PATHS.map(
  ({ d, fill }) => `<path d="${d}" fill="${fill}"/>`,
).join("");

export const SAIL_LOGO_CONTENT = `<rect width="128" height="128" rx="${SAIL_ICON_RADIUS}" fill="${SAIL_BACKGROUND}"/>${SAIL_MARK_CONTENT}`;

export const SAIL_LOGO_SVG = `<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">${SAIL_LOGO_CONTENT}</svg>`;
