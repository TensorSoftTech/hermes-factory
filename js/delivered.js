/** "Delivered" button → history overlay of completed tasks (server-persisted) */

import { loadDelivered } from "./persist.js?v=state-history-1";

function formatWhen(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatDuration(startedAt, deliveredAt) {
  if (!startedAt || !deliveredAt) return "";
  const s = Math.max(0, Math.round((deliveredAt - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function createDeliveredPanel({
  buttonEl,
  overlayEl,
  listEl,
  runningEl = null,
  getMission = null,
}) {
  if (!overlayEl || !listEl) return { open: async () => {}, refresh: async () => {} };

  function renderRunning() {
    if (!runningEl) return;
    const mission = getMission?.();
    if (!mission || mission.delivered) {
      runningEl.hidden = true;
      runningEl.innerHTML = "";
      return;
    }
    runningEl.hidden = false;
    runningEl.innerHTML = "";
    const card = document.createElement("article");
    card.className = "delivered__entry delivered__entry--running";
    const title = document.createElement("p");
    title.className = "delivered__entry-title";
    title.textContent = mission.title || "Open task";
    const meta = document.createElement("p");
    meta.className = "delivered__when";
    const active = (mission.steps || []).find((s) => s.id === mission.activeId);
    const state = String(mission.taskState || "in_progress").replace("_", " ");
    if (mission.paused) {
      meta.textContent = `Paused · ${state} — dock free for a new order`;
    } else {
      meta.textContent = active
        ? `Running · ${state} · active ${active.title}`
        : `Running · ${state}`;
    }
    card.append(title, meta);
    runningEl.appendChild(card);
  }

  async function refresh() {
    renderRunning();
    const entries = await loadDelivered();
    listEl.innerHTML = "";
    if (!entries.length) {
      const p = document.createElement("p");
      p.className = "delivered__empty";
      p.textContent =
        "Nothing delivered yet — completed missions land here and survive refreshes.";
      listEl.appendChild(p);
      return;
    }
    for (const e of entries) {
      const li = document.createElement("li");
      li.className = "delivered__entry";

      const head = document.createElement("div");
      head.className = "delivered__entry-head";
      const title = document.createElement("p");
      title.className = "delivered__entry-title";
      title.textContent = e.title || "(untitled task)";
      title.title = e.title || "";
      const badge = document.createElement("span");
      badge.className = "delivered__badge";
      badge.textContent = e.taskState === "done" ? "DELIVERED" : String(e.taskState || "").toUpperCase();
      badge.dataset.state = e.taskState || "done";
      const when = document.createElement("span");
      when.className = "delivered__when";
      const dur = formatDuration(e.startedAt, e.deliveredAt);
      when.textContent = [formatWhen(e.deliveredAt), dur && `took ${dur}`]
        .filter(Boolean)
        .join(" · ");
      head.append(title, badge, when);

      li.appendChild(head);

      if (Array.isArray(e.roles) && e.roles.length) {
        const trail = document.createElement("details");
        trail.className = "delivered__trail";
        const sum = document.createElement("summary");
        sum.textContent = `${e.roles.length} role${e.roles.length > 1 ? "s" : ""} worked on it`;
        trail.appendChild(sum);
        const ol = document.createElement("ol");
        for (const r of e.roles) {
          const step = document.createElement("li");
          step.className = "delivered__role";
          const name = document.createElement("strong");
          name.textContent = r.title || r.id;
          const meta = document.createElement("span");
          meta.className = "delivered__role-meta";
          meta.textContent = [r.state, r.hermesProfile && `profile ${r.hermesProfile}`]
            .filter(Boolean)
            .join(" · ");
          step.append(name, meta);
          if (r.note) {
            const note = document.createElement("p");
            note.className = "delivered__role-note";
            note.textContent = r.note;
            step.appendChild(note);
          }
          ol.appendChild(step);
        }
        trail.appendChild(ol);
        li.appendChild(trail);
      }

      if (e.report) {
        const rep = document.createElement("details");
        rep.className = "delivered__report";
        const sum = document.createElement("summary");
        sum.textContent = "Board delivery report";
        const pre = document.createElement("pre");
        pre.textContent = e.report;
        rep.append(sum, pre);
        li.appendChild(rep);
      }

      listEl.appendChild(li);
    }
  }

  function open() {
    overlayEl.classList.add("is-open");
    overlayEl.removeAttribute("hidden");
    overlayEl.setAttribute("aria-hidden", "false");
    refresh();
  }

  function close() {
    overlayEl.classList.remove("is-open");
    overlayEl.setAttribute("aria-hidden", "true");
  }

  buttonEl?.addEventListener("click", open);
  overlayEl.querySelector("#delivered-close")?.addEventListener("click", close);
  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl) close();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlayEl.classList.contains("is-open")) close();
  });
  window.addEventListener("hf-history", () => {
    if (overlayEl.classList.contains("is-open")) refresh();
  });

  return { open, refresh, close };
}
