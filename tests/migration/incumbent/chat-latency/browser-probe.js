export default async function captureChatLatency(thread) {
  const prompt = "Give me a short tour";
  const ending = "This turn is a replay. It costs nothing, so send it again as often as you need.";
  const firstReply = "The project has a single math module. I will add a clamp helper beside sum.";
  const completedReply =
    "Done I added clamp next to sum and the tests pass. Reads the manifest first " +
    "Asks before it writes Streams a terminal result clamp(12, 0, 10); // 10 " +
    "clamp(-3, 0, 10); // 0 Step Tool Result Read read 1 file Edit edit +4 lines " +
    "Test execute 12 passed " +
    ending;
  const expectedMessages = [
    ["user", prompt],
    ["assistant", firstReply],
    ["assistant", completedReply],
  ];
  const expectedCells = [
    ["Step", "Tool", "Result"],
    ["Read", "read", "1 file"],
    ["Edit", "edit", "+4 lines"],
    ["Test", "execute", "12 passed"],
  ];
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
        try {
          const value = check();
          if (!value) return;
          resolve(value);
        } catch (error) {
          reject(error);
        }
        observer.disconnect();
        clearTimeout(timer);
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

  function messageText(row) {
    return row.querySelector(".chat-markdown")?.innerText.replace(/\s+/g, " ").trim();
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
    firstReply.startsWith(replyText), "Expected nonempty text from the first Replay reply");
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
      const table = assistant[0].querySelector("table");
      if (!table) return null;
      const cells = [...table.rows].map((row) =>
        [...row.cells].map((cell) => cell.innerText.trim()),
      );
      require(JSON.stringify(cells) ===
        JSON.stringify(expectedCells), "Unexpected Replay table cells");
      return {
        at: performance.now(),
        userRows: rows.length,
        replyRows: assistant.length,
        tableRows: cells.length,
        cells,
      };
    },
    "the settled reply after reconnect",
    24_000,
  );
  const work = [...document.querySelectorAll("main button[aria-expanded]")].find((button) =>
    button.innerText.startsWith("Worked for "),
  );
  require(work, "Expected the completed Replay work group");
  if (work.getAttribute("aria-expanded") === "false") work.click();
  const transcript = await until(() => {
    const rows = [...document.querySelectorAll("main [data-message-role]")];
    if (work.getAttribute("aria-expanded") !== "true" || rows.length < expectedMessages.length)
      return null;
    return rows.map((row) => [row.dataset.messageRole, messageText(row)]);
  }, "the expanded Replay transcript");
  require(JSON.stringify(transcript) ===
    JSON.stringify(expectedMessages), "The reconnected browser transcript differs from Replay");
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
      cells: rendered.cells,
      transcript,
    },
  };
}
