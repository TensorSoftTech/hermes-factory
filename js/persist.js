/**
 * Refresh-safe state persistence.
 *
 * The page snapshots its live task/session state to the bridge
 * (PUT /api/state → ~/.hermes-factory/state.json) so a browser refresh
 * restores the mission bar, board context, and run history instead of
 * wiping everything. Writes are debounced; a flush fires on pagehide.
 */

const DEBOUNCE_MS = 700;

export function createPersist({ snapshot }) {
  let timer = null;
  let dirty = false;

  async function load() {
    try {
      const res = await fetch("/api/state");
      if (!res.ok) return null;
      const data = await res.json();
      return data && typeof data === "object" ? data : null;
    } catch {
      return null;
    }
  }

  async function write(keepalive = false) {
    dirty = false;
    try {
      await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot() || {}),
        keepalive,
      });
    } catch {
      /* best-effort — local bridge may be mid-restart */
    }
  }

  function saveLater() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (dirty) write(false);
    }, DEBOUNCE_MS);
  }

  function saveNow() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return write(false);
  }

  // Flush before the tab goes away (keepalive lets the request outlive it)
  window.addEventListener("pagehide", () => {
    if (dirty) write(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && dirty) write(true);
  });

  return { load, saveLater, saveNow };
}

/** Delivered-task history (server-side ~/.hermes-factory/history.json). */
export async function loadDelivered() {
  try {
    const res = await fetch("/api/history");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

export async function appendDelivered(entry) {
  try {
    const res = await fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    return res.ok;
  } catch {
    return false;
  }
}
