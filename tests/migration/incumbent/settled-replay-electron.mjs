import * as NodeEvents from "node:events";
import * as NodeTimersPromises from "node:timers/promises";

const args = process.argv.slice(2);
const blurComposer = args[0] === "--blur-composer";
const [portText, environmentId, threadId] = args.slice(blurComposer ? 1 : 0);
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !!environmentId !== !!threadId) {
  throw new Error(
    "Usage: node settled-replay-electron.mjs [--blur-composer] <fixture DevTools port> [environment ID and thread ID]",
  );
}

const host = `127.0.0.1:${port}`;
const pages = await fetch(`http://${host}/json/list`, { signal: AbortSignal.timeout(3000) }).then(
  (response) => response.json(),
);
const windows = pages.filter((page) => page.type === "page" && page.url.startsWith("sail://app/"));
const endpoint = windows[0]?.webSocketDebuggerUrl;
if (windows.length !== 1 || !endpoint?.startsWith(`ws://${host}/`)) {
  throw new Error("Expected one packaged Sail window on the fixture's loopback DevTools port");
}

const socket = new WebSocket(endpoint);
await NodeEvents.once(socket, "open", { signal: AbortSignal.timeout(3000) });
let requestId = 0;

async function call(method, params) {
  const id = ++requestId;
  const deadline = AbortSignal.timeout(3000);
  socket.send(JSON.stringify({ id, method, params }));
  while (true) {
    const [event] = await NodeEvents.once(socket, "message", { signal: deadline });
    const message = JSON.parse(event.data);
    if (message.id !== id) continue;
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result;
  }
}

async function evaluate(fn) {
  const value = await call("Runtime.evaluate", {
    expression: `(${fn.toString()})()`,
    returnByValue: true,
  });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.text);
  return value.result.value;
}

function observe() {
  const main = document.querySelector("main");
  const sidebar = document.querySelector('[aria-label="Toggle main sidebar"]');
  const details = main?.querySelector('[aria-label="Toggle thread details panel"]');
  const composer = main?.querySelector('[contenteditable="true"]');
  const code = main?.querySelector(".chat-markdown-shiki pre");
  const actions = [...(main?.querySelectorAll('[aria-label="Copy message"]') ?? [])].find(
    (element) => element.getBoundingClientRect().width > 0,
  )?.parentElement;
  return {
    title: main?.querySelector("h2")?.textContent,
    replyVisible: main?.innerText.includes("This turn is a replay."),
    code: code?.textContent.trim(),
    tableRows: main?.querySelector("table")?.rows.length,
    composerFocused: composer ? document.activeElement === composer : null,
    sidebarOpen: sidebar ? sidebar.getAttribute("aria-pressed") === "true" : null,
    detailsOpen: details ? details.getAttribute("aria-pressed") === "true" : null,
    actionsOpacity: actions ? getComputedStyle(actions).opacity : null,
    actionsHovered: actions?.parentElement?.matches(":hover") ?? false,
    menuOpen: [...document.querySelectorAll('[role="menu"]')].some(
      (el) => el.getClientRects().length,
    ),
    viewport: {
      width: innerWidth,
      height: innerHeight,
      scale: devicePixelRatio,
      zoom: visualViewport?.scale,
    },
    locale: document.documentElement.lang,
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    motion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "standard",
    fonts: code
      ? [getComputedStyle(document.body).fontFamily, getComputedStyle(code).fontFamily]
      : [],
  };
}

try {
  if (environmentId && threadId) {
    const fragment = [environmentId, threadId].map(encodeURIComponent).join("/");
    await call("Page.navigate", { url: `sail://app/#/${fragment}` });
  }
  if (blurComposer) {
    await evaluate(() => {
      if (document.activeElement?.matches("main [contenteditable=true]")) {
        document.activeElement.blur();
      }
    });
  }
  const deadline = Date.now() + 8000;
  let captured = false;
  let lastState;
  while (Date.now() < deadline) {
    const state = await evaluate(observe);
    lastState = state;
    if (
      state.title === "Compatibility replay" &&
      state.replyVisible &&
      state.code === "clamp(12, 0, 10); // 10\nclamp(-3, 0, 10); // 0" &&
      state.tableRows === 4 &&
      state.sidebarOpen === false &&
      state.detailsOpen === false &&
      state.composerFocused === false &&
      !state.menuOpen &&
      state.actionsOpacity === "1" &&
      state.actionsHovered
    ) {
      process.stdout.write(`${JSON.stringify(state)}\n`);
      captured = true;
      break;
    }
    await NodeTimersPromises.setTimeout(50);
  }
  if (!captured) {
    throw new Error(
      `The Electron settled hover fixture did not reach the capture state ${JSON.stringify({
        replyVisible: lastState?.replyVisible,
        composerFocused: lastState?.composerFocused,
        sidebarOpen: lastState?.sidebarOpen,
        detailsOpen: lastState?.detailsOpen,
        actionsOpacity: lastState?.actionsOpacity,
        actionsHovered: lastState?.actionsHovered,
      })}`,
    );
  }
} finally {
  socket.close();
}
