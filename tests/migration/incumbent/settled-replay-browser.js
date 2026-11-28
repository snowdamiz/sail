(async () => {
  if (document.visibilityState !== "visible") {
    throw new Error("Activate the fixture tab before capturing it");
  }
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const transitions = document
    .getAnimations()
    .filter(
      (animation) =>
        animation.playState === "running" &&
        Number.isFinite(animation.effect?.getComputedTiming().endTime),
    );
  await Promise.allSettled(transitions.map((animation) => animation.finished));

  const main = document.querySelector("main");
  const transcriptCode = main?.querySelector(".chat-markdown-shiki pre");
  const codeText = transcriptCode?.textContent.trim();
  const composer = main?.querySelector('[contenteditable="true"]');
  const focused = document.activeElement;
  const visible = (selector) =>
    [...document.querySelectorAll(selector)].filter((element) => element.getClientRects().length);
  const threadTitle = main?.querySelector("h2")?.textContent;
  const composerName = composer?.getAttribute("aria-label");
  const focusName = focused?.getAttribute("aria-label") ?? focused?.textContent;
  const tableRows = main?.querySelector("table")?.rows.length;
  const menuCount = visible('[role="menu"]').length;
  const stopVisible = visible('[aria-label="Stop generation"]').length > 0;
  const browser = navigator.userAgent.match(/Chrome\/[^ ]+/)?.[0];
  if (
    threadTitle !== "Compatibility replay" ||
    composerName !== "Message Compatibility replay" ||
    !main?.innerText.includes("This turn is a replay.") ||
    !transcriptCode?.getClientRects().length ||
    codeText !== "clamp(12, 0, 10); // 10\nclamp(-3, 0, 10); // 0" ||
    tableRows !== 4 ||
    stopVisible ||
    menuCount !== 0 ||
    focused?.tagName !== "BUTTON" ||
    focusName !== "Attach files" ||
    !browser ||
    !visualViewport
  ) {
    throw new Error("Expected the settled compatibility replay with Attach files focused");
  }

  return {
    profile: {
      browser,
      locale: document.documentElement.lang,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
      motion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "standard",
      viewport: {
        width: innerWidth,
        height: innerHeight,
        scale: devicePixelRatio,
        zoom: visualViewport.scale,
      },
      fonts: [
        getComputedStyle(document.body).fontFamily,
        getComputedStyle(transcriptCode).fontFamily,
      ],
    },
    trace: [
      {
        action: "openDirectThreadUrl",
        observed: { threadTitle, replyVisible: true, codeText, stopVisible, tableRows },
      },
      {
        action: "tabToAttachFiles",
        observed: { composerName, focusName, focusRole: "button", menuCount },
      },
    ],
  };
})();
