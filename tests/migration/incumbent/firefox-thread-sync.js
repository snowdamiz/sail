export default function observeThreadSync(threadId) {
  if (window.top !== window || !/^127\.0\.0\.1(?:[1-4])?$/.test(location.hostname)) return;
  const state = { requested: 0, snapshots: 0, synchronized: 0, active: false };
  Object.defineProperty(window, "__sailCaptureSync", { value: state });
  const Socket = window.WebSocket;
  function decode(text) {
    try {
      return typeof text === "string" ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }
  window.WebSocket = class extends Socket {
    #threadRequests = new Set();
    constructor(url, ...options) {
      super(url, ...options);
      if (new URL(this.url).pathname !== "/ws") return;
      this.addEventListener("message", ({ data }) => {
        const frame = decode(data);
        if (!this.#threadRequests.has(String(frame?.requestId))) return;
        if (frame?._tag === "Chunk") {
          for (const record of frame.values) {
            if (record.kind === "snapshot") state.snapshots++;
            if (record.kind === "synchronized") {
              state.synchronized++;
              state.active = true;
            }
          }
        }
        if (frame?._tag === "Exit") {
          this.#threadRequests.delete(String(frame.requestId));
          state.active = false;
        }
      });
      this.addEventListener("close", () => {
        if (this.#threadRequests.size) state.active = false;
      });
    }
    send(data) {
      const frame = decode(data);
      if (
        frame?._tag === "Request" &&
        frame.tag === "orchestration.subscribeThread" &&
        frame.payload?.threadId === threadId &&
        frame.payload.requestCompletionMarker === true
      ) {
        this.#threadRequests.add(String(frame.id));
        state.requested++;
        state.active = false;
      }
      if (frame?._tag === "Interrupt" && this.#threadRequests.delete(String(frame.requestId))) {
        state.active = false;
      }
      return super.send(data);
    }
  };
}
