const root = document.documentElement;
const status = document.querySelector("#status");
const params = new URLSearchParams(location.search);
const backend = params.get("backend") ?? "auto";
root.dataset.graphics = backend;

const incumbent = params.get("incumbent");
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
if (incumbent && loopback.has(location.hostname)) {
  if (URL.canParse(incumbent)) {
    const target = new URL(incumbent);
    if (
      ["http:", "https:"].includes(target.protocol) &&
      loopback.has(target.hostname) &&
      target.origin !== location.origin &&
      !target.username &&
      !target.password
    ) {
      document.querySelector("#incumbent").href = target.href;
    }
  }
}

const timeout = setTimeout(() => {
  status.textContent = "The Sail GPUI preview is taking longer than expected.";
}, 15000);

try {
  const { default: init, start } = await import("./sail_client.js");
  await init();
  await start(backend);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  root.dataset.status = "ready";
} catch (error) {
  root.dataset.error ??= "startup";
  root.dataset.status = "failed";
  status.textContent = "The Sail GPUI preview could not start.";
  console.error(error);
} finally {
  clearTimeout(timeout);
}
