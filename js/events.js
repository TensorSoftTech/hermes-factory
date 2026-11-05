/**
 * Factory WebSocket event bus client.
 * Server pushes mission / kanban / agent / feed / busy patches.
 */

export function createEventBus({ onEvent } = {}) {
  let ws = null;
  let closed = false;
  let retryMs = 800;
  let timer = null;

  function url() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws/events`;
  }

  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(url());
    } catch (err) {
      console.warn("[events] connect failed", err);
      scheduleReconnect();
      return;
    }
    ws.addEventListener("open", () => {
      retryMs = 800;
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      try {
        onEvent?.(msg);
      } catch (err) {
        console.error("[events] handler", err);
      }
    });
    ws.addEventListener("close", () => {
      ws = null;
      if (!closed) scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    });
  }

  function scheduleReconnect() {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      retryMs = Math.min(12_000, Math.floor(retryMs * 1.6));
      connect();
    }, retryMs);
  }

  function stop() {
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }

  connect();
  return { stop, reconnect: connect };
}
