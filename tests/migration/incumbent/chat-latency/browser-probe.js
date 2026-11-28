export default async function captureChatLatency(thread) {
  const prompt = "Give me a short tour";
  const ending = "This turn is a replay. It costs nothing, so send it again as often as you need.";
  function require(condition, note) {
    if (!condition) throw new Error(note);
  }

  function until(check, label, timeout = 12_000) {
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(test);
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error("Timed out waiting for " + label));
      }, timeout);
      function test() {
        const value = check();
        if (!value) return;
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      }
      observer.observe(document.documentElement, {
        subtree: true,
        attributes: true,
        childList: true,
        characterData: true,
      });
      test();
    });
  }

  function visible(el) {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight;
  }

  function messageRows(role) {
    return [...document.querySelectorAll('main [data-message-role="' + role + '"]')];
  }

  function syncStatus() {
    const status = document.querySelector("main [data-composer-sync-status]");
    return status && visible(status)
      ? {
          phase: status.getAttribute("data-composer-sync-status"),
          text: status.textContent.trim(),
        }
      : null;
  }

  function reconnectNotice() {
    const alert = [...document.querySelectorAll('[role="alert"]')].find(
      (item) => visible(item) && item.textContent.includes("Compatibility host is reconnecting"),
    );
    return alert?.innerText.trim() || null;
  }

  async function control(action) {
    const response = await fetch("/__sail_latency/" + action + "?thread=" + thread, {
      method: "POST",
    });
    const result = await response.json();
    require(response.ok, action + ": " + (result.error ?? response.status));
    return result;
  }

  require(location.pathname.endsWith("/" + thread), "Unexpected thread route");
  require(document.visibilityState === "visible", "The capture needs an active tab");
  const composer = await until(
    () => document.querySelector('main [contenteditable="true"]'),
    "the empty composer",
  );
  require(messageRows("user").length === 0, "Start with an unused thread");
  composer.focus();
  require(document.execCommand("insertText", false, prompt), "Could not enter the prompt");
  const send = await until(() => {
    const button = document.querySelector('main button[aria-label="Submit message"]');
    return button && !button.disabled && !syncStatus() && button;
  }, "the enabled Send action");
  const submitted = performance.now();
  send.click();

  const first = await until(() => {
    const assistant = messageRows("assistant").find((el) => visible(el) && el.textContent.trim());
    if (!assistant) return null;
    return { at: performance.now(), text: assistant.textContent.trim() };
  }, "visible assistant text");
  const replyText = first.text.replace(/^T3 Code\s*/, "");
  require(replyText.length > 0 &&
    "The project has a single math module. I will add a clamp helper beside sum.".startsWith(
      replyText,
    ), "Expected nonempty text from the first Replay reply");
  const cut = await control("cut");
  const offline = await until(reconnectNotice, "the reconnect indicator");
  const settled = await control("wait");
  const requestedRestore = performance.now();
  const restored = await control("restore");
  require(restored.blockedAttempts > 0, "The browser did not attempt to reconnect while blocked");
  const rendered = await until(
    () => {
      if (
        syncStatus() ||
        reconnectNotice() ||
        document.querySelector('main button[aria-label="Stop generation"]')
      )
        return null;
      const assistant = messageRows("assistant").filter((el) => el.textContent.includes(ending));
      if (assistant.length !== 1 || !visible(assistant[0])) return null;
      const rows = messageRows("user").filter((el) => el.textContent.includes(prompt));
      if (rows.length !== 1) return null;
      const code = assistant[0].querySelector(".chat-markdown-shiki pre")?.textContent.trim();
      if (code !== "clamp(12, 0, 10); // 10\nclamp(-3, 0, 10); // 0") return null;
      const tableRows = assistant[0].querySelector("table")?.rows.length;
      return tableRows === 4
        ? { at: performance.now(), userRows: rows.length, replyRows: assistant.length, tableRows }
        : null;
    },
    "the settled reply after reconnect",
    24_000,
  );
  return {
    thread,
    promptToVisibleTextMs: first.at - submitted,
    restoreRequestToCurrentTranscriptMs: rendered.at - requestedRestore,
    firstText: first.text,
    cut,
    offline,
    settled,
    restored,
    view: [innerWidth, innerHeight, devicePixelRatio],
    userAgent: navigator.userAgent,
    observed: {
      userRows: rendered.userRows,
      replyRows: rendered.replyRows,
      tableRows: rendered.tableRows,
    },
  };
}
