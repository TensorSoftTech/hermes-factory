/**
 * Per-manager kanban.
 *
 * Board request → one MAIN card (owned by the manager) → SUB tasks assigned
 * to executors. Subs may depend on other subs; when a dep hits "done",
 * dependents unblock (event-driven).
 */

const COLUMNS = [
  { id: "todo", label: "To do" },
  { id: "blocked", label: "Blocked" },
  { id: "doing", label: "Doing" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

const RANK = { todo: 0, blocked: 0, doing: 1, review: 2, done: 3 };

function newId(prefix = "c") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeDepends(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x || "").trim()).filter(Boolean))];
}

export function createKanban({ overlay, onChange, onResetTasks } = {}) {
  let cards = [];
  let openManagerId = null;

  function notify() {
    try {
      onChange?.();
    } catch {
      /* persistence must not break the board */
    }
  }

  function get(id) {
    return cards.find((c) => c.id === id) || null;
  }

  function byManager(managerId) {
    return cards.filter((c) => c.managerId === managerId);
  }

  function depsMet(card) {
    const deps = normalizeDepends(card.dependsOn);
    if (!deps.length) return true;
    return deps.every((id) => get(id)?.status === "done");
  }

  /** Cards ready to start (todo only — blocked stays waiting on deps / failures). */
  function readySubs(managerId) {
    return byManager(managerId).filter(
      (c) =>
        c.kind !== "main" &&
        c.assigneeId &&
        c.status === "todo" &&
        depsMet(c)
    );
  }

  /** True when blocked only because upstream deps are unfinished (not API failure). */
  function isDepBlocked(card) {
    if (!card || card.kind === "main") return false;
    if (card.status !== "blocked" && card.status !== "todo") return false;
    if (isApiFailed(card)) return false;
    const deps = normalizeDepends(card.dependsOn);
    if (!deps.length) return false;
    return deps.some((id) => get(id)?.status !== "done");
  }

  function isApiFailed(card) {
    return /recovery ping to retry|API\/process failed|reopened for manager|Manager retry after kanban/i.test(
      card?.note || ""
    );
  }

  function openSubs(managerId) {
    return byManager(managerId).filter(
      (c) => c.kind !== "main" && c.status !== "done"
    );
  }

  function mainOf(managerId) {
    return byManager(managerId).find((c) => c.kind === "main" && c.status !== "done") || null;
  }

  function refreshBlocked(managerId = null) {
    const pool = managerId ? byManager(managerId) : cards;
    for (const card of pool) {
      if (card.kind === "main") continue;
      if (card.status === "doing" || card.status === "review" || card.status === "done") {
        continue;
      }
      const ready = depsMet(card);
      const next = ready ? "todo" : "blocked";
      if (card.status !== next) card.status = next;
      if (!ready && normalizeDepends(card.dependsOn).length) {
        const waiting = normalizeDepends(card.dependsOn)
          .filter((id) => get(id)?.status !== "done")
          .map((id) => get(id)?.title || id)
          .slice(0, 3);
        card.note = waiting.length ? `Waiting on: ${waiting.join(", ")}` : card.note;
      }
    }
  }

  /**
   * Mark a card done and unblock dependents. Returns newly-ready sub cards.
   */
  function complete(id, { note } = {}) {
    const card = get(id);
    if (!card) return [];
    card.status = "done";
    if (note) card.note = String(note).slice(0, 280);
    refreshBlocked(card.managerId);
    // If all subs under this main are done, close the main
    if (card.parentId) {
      const siblings = cards.filter(
        (c) => c.parentId === card.parentId && c.kind !== "main"
      );
      if (siblings.length && siblings.every((c) => c.status === "done")) {
        const main = get(card.parentId);
        if (main) {
          main.status = "done";
          main.note = "All subtasks done";
        }
      }
    }
    notify();
    if (overlay && !overlay.hidden) render(overlay._template, openManagerId);
    return readySubs(card.managerId).filter((c) => c.status === "todo");
  }

  function isFrozen(card) {
    if (!card || card.kind === "main" || card.status === "done") return false;
    if (card.status === "blocked") return true;
    if (isDepBlocked(card)) return true;
    if (isApiFailed(card)) return true;
    return /waiting on|frozen|stuck|API\/process failed|recovery ping to retry/i.test(
      card.note || ""
    );
  }

  function setStatus(id, status, { gateAllow = false } = {}) {
    const card = get(id);
    if (!card || !COLUMNS.some((c) => c.id === status)) return;
    if (status === "done") {
      // Frozen/blocked cards need an explicit gate (confirm) before force-done
      if (isFrozen(card) && !gateAllow) {
        const ok = window.confirm(
          `This card looks frozen/blocked.\n\n“${card.title}”\n\nOpen the gate and mark it done anyway?\n(Same as CTO saying GATE: allow)`
        );
        if (!ok) {
          if (overlay && !overlay.hidden) render(overlay._template, openManagerId);
          return;
        }
        card.note = "Manual GATE: allow → forced done (was frozen)";
      }
      complete(id, {
        note: card.note || undefined,
      });
      return;
    }
    card.status = status;
    // Manual CTO moves: "doing"/"review" stick; todo/blocked re-check deps
    if (status === "todo" || status === "blocked") {
      refreshBlocked(card.managerId);
    }
    notify();
    if (overlay && !overlay.hidden) render(overlay._template, openManagerId);
  }

  function patch(id, fields = {}) {
    const card = get(id);
    if (!card) return null;
    if (fields.assigneeId !== undefined) card.assigneeId = fields.assigneeId;
    if (fields.status && COLUMNS.some((c) => c.id === fields.status)) {
      // Never promote a dep-waiting card to doing/review via automated patch
      if (
        (fields.status === "doing" || fields.status === "review") &&
        isDepBlocked(card) &&
        fields._force !== true
      ) {
        /* keep blocked/todo — note may still update below */
      } else {
        card.status = fields.status;
      }
    }
    if (fields.note !== undefined) card.note = String(fields.note).slice(0, 280);
    if (fields.dependsOn) card.dependsOn = normalizeDepends(fields.dependsOn);
    if (fields.title) card.title = String(fields.title).slice(0, 180);
    if (card.status === "todo" || card.status === "blocked") {
      refreshBlocked(card.managerId);
    }
    notify();
    if (overlay && !overlay.hidden) render(overlay._template, openManagerId);
    return card;
  }

  function removeOpenByTitle(managerId, title) {
    const key = String(title || "").slice(0, 80);
    cards = cards.filter(
      (c) =>
        !(
          c.managerId === managerId &&
          String(c.title || "").slice(0, 80) === key &&
          c.status !== "done"
        )
    );
    notify();
  }

  function place(card) {
    if (card.id) {
      const existing = get(card.id);
      if (existing) {
        return patch(card.id, card) || existing;
      }
    }
    const key = String(card.title || "").slice(0, 80);
    // Prefer same assignee + title so report/QA place does not steal a
    // different position's dep-waiting card that shares the board title.
    let existing = cards.find(
      (c) =>
        c.managerId === card.managerId &&
        c.kind !== "main" &&
        card.assigneeId &&
        c.assigneeId === card.assigneeId &&
        String(c.title || "").slice(0, 80) === key &&
        c.status !== "done"
    );
    if (!existing) {
      existing = cards.find(
        (c) =>
          c.managerId === card.managerId &&
          c.kind !== "main" &&
          String(c.title || "").slice(0, 80) === key &&
          c.status !== "done"
      );
    }
    if (!existing && card.kind !== "main") {
      existing = cards.find(
        (c) =>
          c.managerId === card.managerId &&
          !c.assigneeId &&
          c.kind !== "main" &&
          c.status !== "done"
      );
    }
    if (existing) {
      // Reports/QA must not yank a card out of dependency wait into doing
      if (
        isDepBlocked(existing) &&
        (card.status === "doing" || card.status === "review")
      ) {
        return patch(existing.id, {
          note: card.note,
          assigneeId: card.assigneeId ?? existing.assigneeId,
        }) || existing;
      }
      return patch(existing.id, card) || existing;
    }
    return add(card);
  }

  function add(card) {
    const dependsOn = normalizeDepends(card.dependsOn);
    let status = COLUMNS.some((c) => c.id === card.status) ? card.status : "todo";
    if (card.kind !== "main" && dependsOn.length && status === "todo") {
      // Will be corrected by refreshBlocked; start blocked until deps land
      status = "blocked";
    }
    const entry = {
      id: card.id || newId(card.kind === "main" ? "main" : "sub"),
      kind: card.kind === "main" ? "main" : "sub",
      parentId: card.parentId || null,
      managerId: card.managerId,
      assigneeId: card.assigneeId || null,
      title: String(card.title || "Task").slice(0, 180),
      status,
      dependsOn,
      source: card.source || "manual",
      note: card.note ? String(card.note).slice(0, 280) : "",
      createdAt: card.createdAt || Date.now(),
    };
    cards.unshift(entry);
    if (cards.length > 200) cards.length = 200;
    refreshBlocked(entry.managerId);
    notify();
    if (overlay && !overlay.hidden) render(overlay._template, openManagerId);
    return entry;
  }

  /** Create MAIN + SUB cards from a CTO plan. */
  function addPlan({ managerId, mainTitle, tasks, source = "cto" }) {
    const main = add({
      kind: "main",
      managerId,
      assigneeId: managerId,
      title: String(mainTitle || "Board request").slice(0, 180),
      status: "doing",
      source,
      note: "Manager owns delivery — subtasks below",
    });
    const created = [];
    // First pass: create without deps resolved to ids
    const raw = (tasks || []).map((t, i) => ({
      ...t,
      _idx: i + 1,
      tempId: newId("sub"),
    }));
    for (const t of raw) {
      const depIds = [];
      for (const ref of normalizeDepends(t.dependsOn)) {
        // "#1" / "1" → prior task index; otherwise match role id of earlier task
        const num = String(ref).replace(/^#/, "");
        if (/^\d+$/.test(num)) {
          const prior = raw.find((x) => x._idx === Number(num));
          if (prior) depIds.push(prior.tempId);
          continue;
        }
        const prior = raw.find(
          (x) => x._idx < t._idx && (x.assigneeId === ref || x.id === ref)
        );
        if (prior) depIds.push(prior.tempId);
      }
      const sub = add({
        id: t.tempId,
        kind: "sub",
        parentId: main.id,
        managerId,
        assigneeId: t.assigneeId || null,
        title: t.title,
        dependsOn: depIds,
        status: depIds.length ? "blocked" : "todo",
        source,
        note: t.note || "",
      });
      created.push(sub);
    }
    refreshBlocked(managerId);
    notify();
    if (overlay && !overlay.hidden) render(overlay._template, openManagerId);
    return { main, subs: created };
  }

  function snapshot() {
    return cards.slice(0, 200);
  }

  function clear(managerId = null) {
    if (managerId == null || managerId === "") {
      cards = [];
    } else {
      cards = cards.filter((c) => c.managerId !== managerId);
    }
    notify();
    if (overlay && !overlay.hidden) render(overlay._template, openManagerId);
  }

  function clearAll() {
    clear(null);
  }

  function restore(saved) {
    const raw = Array.isArray(saved) ? saved.filter((c) => c && c.id && c.managerId) : [];
    const kept = [];
    for (const card of raw) {
      const normalized = {
        ...card,
        kind: card.kind === "main" ? "main" : "sub",
        dependsOn: normalizeDepends(card.dependsOn),
        parentId: card.parentId || null,
        note: card.note || "",
      };
      const key = String(normalized.title || "").slice(0, 80);
      const prev = kept.find(
        (c) =>
          c.managerId === normalized.managerId &&
          c.kind === normalized.kind &&
          String(c.title || "").slice(0, 80) === key
      );
      if (!prev) {
        kept.push(normalized);
        continue;
      }
      if (normalized.assigneeId && !prev.assigneeId) prev.assigneeId = normalized.assigneeId;
      if ((RANK[normalized.status] || 0) > (RANK[prev.status] || 0)) {
        prev.status = normalized.status;
      }
      if (normalized.dependsOn?.length) prev.dependsOn = normalized.dependsOn;
      if (normalized.parentId) prev.parentId = normalized.parentId;
    }
    cards = kept;
    refreshBlocked();
  }

  function managersOf(template) {
    return (template?.roles || []).filter((r) => r.roleKind === "manager");
  }

  function executorsOf(template, managerId) {
    return (template?.roles || []).filter(
      (r) => r.roleKind === "executor" && r.takesOrdersFrom === managerId
    );
  }

  function titleOf(template, id) {
    return template?.roles?.find((r) => r.id === id)?.title || id || "—";
  }

  function depLabel(template, card) {
    const deps = normalizeDepends(card.dependsOn);
    if (!deps.length) return "";
    return deps
      .map((id) => {
        const d = get(id);
        if (!d) return id;
        const who = d.assigneeId ? titleOf(template, d.assigneeId) : "";
        return who ? `${d.title} (${who})` : d.title;
      })
      .join(" · ");
  }

  function ageLabel(ts) {
    if (!ts) return "";
    const ms = Date.now() - (Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000);
    if (!Number.isFinite(ms) || ms < 0) return "";
    const m = Math.floor(ms / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  async function refreshHermesLegacy() {
    const wrap = overlay?.querySelector("[data-kanban-hermes-legacy]");
    const list = overlay?.querySelector("[data-kanban-hermes-list]");
    if (!wrap || !list) return;
    list.innerHTML = "";
    try {
      const res = await fetch("/api/hermes-tasks");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      if (!tasks.length) {
        wrap.hidden = true;
        return;
      }
      wrap.hidden = false;
      const title = wrap.querySelector(".kanban-legacy__title");
      if (title) {
        const runN = data.runningCount || tasks.filter((t) => t.running).length;
        title.textContent =
          runN > 0
            ? `Hermes Agent: ${runN} running · ${data.openCount || tasks.length} open`
            : `Hermes Agent: ${data.openCount || tasks.length} open (none running)`;
      }
      for (const t of tasks.slice(0, 12)) {
        const li = document.createElement("li");
        li.className =
          "kanban-legacy__item" +
          (t.running ? " is-running" : t.status === "ready" ? " is-ready" : "");
        const badge = document.createElement("span");
        badge.className = "kanban-legacy__badge";
        badge.textContent = t.running
          ? "RUNNING"
          : String(t.status || "open").toUpperCase();
        const text = document.createElement("span");
        text.className = "kanban-legacy__text";
        const when = ageLabel(t.startedAt || t.createdAt);
        text.textContent = [
          t.id,
          t.title,
          t.assignee && `→ ${t.assignee}`,
          t.profile && t.profile !== "default" && `profile ${t.profile}`,
          t.workerPid && `pid ${t.workerPid}`,
          when,
        ]
          .filter(Boolean)
          .join(" · ");
        text.title = t.lastError || text.textContent;
        li.append(badge, text);
        list.appendChild(li);
      }
    } catch (err) {
      wrap.hidden = false;
      const li = document.createElement("li");
      li.className = "kanban-legacy__item is-error";
      li.textContent =
        String(err?.message || err).includes("Failed to fetch") ||
        String(err?.message || err).includes("NetworkError")
          ? "Bridge offline — start the factory server to see Hermes Agent tasks."
          : `Could not load Hermes Agent tasks: ${String(err?.message || err).slice(0, 120)}`;
      list.appendChild(li);
    }
  }

  function render(template, managerId) {
    if (!overlay) return;
    const body = overlay.querySelector("[data-kanban-body]");
    const select = overlay.querySelector("[data-kanban-manager]");
    if (!body || !select) return;
    const managers = managersOf(template);
    const current = managerId || openManagerId || managers[0]?.id || "";
    openManagerId = current;
    select.innerHTML = "";
    for (const m of managers) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.title;
      if (m.id === current) opt.selected = true;
      select.appendChild(opt);
    }
    refreshBlocked(current);
    const mine = byManager(current);
    const executors = executorsOf(template, current);
    body.innerHTML = "";
    refreshHermesLegacy();

    // Main task strip
    const mains = mine.filter((c) => c.kind === "main");
    if (mains.length) {
      const strip = document.createElement("div");
      strip.className = "kanban-main";
      for (const card of mains) {
        const el = document.createElement("div");
        el.className = "kanban-main__card" + (card.status === "done" ? " is-done" : "");
        const label = document.createElement("p");
        label.className = "kanban-main__label";
        label.textContent = "Main · board request";
        const title = document.createElement("p");
        title.className = "kanban-main__title";
        title.textContent = card.title;
        const meta = document.createElement("p");
        meta.className = "kanban-main__meta";
        const open = openSubs(current).length;
        meta.textContent = `${card.status} · ${open} subtask(s) open · owner ${titleOf(template, card.assigneeId || current)}`;
        el.append(label, title, meta);
        strip.appendChild(el);
      }
      body.appendChild(strip);
    }

    for (const col of COLUMNS) {
      const section = document.createElement("section");
      section.className = "kanban-col";
      const h = document.createElement("h3");
      h.textContent = col.label;
      const list = document.createElement("ol");
      for (const card of mine.filter((c) => c.kind !== "main" && c.status === col.id)) {
        const li = document.createElement("li");
        li.className = "kanban-card";
        if (card.status === "doing") li.classList.add("is-running");
        if (card.dependsOn?.length) li.classList.add("has-deps");
        const title = document.createElement("p");
        title.className = "kanban-card__title";
        title.textContent = card.title;
        if (card.status === "doing") {
          const live = document.createElement("span");
          live.className = "kanban-card__live";
          live.textContent = "RUNNING";
          title.append(" ", live);
        }
        const who = document.createElement("p");
        who.className = "kanban-card__who";
        who.textContent = card.assigneeId
          ? titleOf(template, card.assigneeId)
          : "Unassigned";
        li.append(title, who);
        const deps = depLabel(template, card);
        if (deps) {
          const dep = document.createElement("p");
          dep.className = "kanban-card__deps";
          dep.textContent =
            card.status === "blocked" || card.status === "todo"
              ? `Depends on: ${deps}`
              : `Dep: ${deps}`;
          li.appendChild(dep);
        }
        if (card.note) {
          const note = document.createElement("p");
          note.className = "kanban-card__note";
          note.textContent = card.note;
          li.appendChild(note);
        }
        const status = document.createElement("select");
        status.className = "kanban-card__status";
        for (const c of COLUMNS) {
          const opt = document.createElement("option");
          opt.value = c.id;
          opt.textContent = c.label;
          if (c.id === card.status) opt.selected = true;
          status.appendChild(opt);
        }
        status.addEventListener("change", () => {
          setStatus(card.id, status.value);
          // Re-render so a cancelled gate confirm restores the old status in the select
          if (overlay && !overlay.hidden) render(overlay._template, openManagerId);
        });
        if (isFrozen(card)) {
          const gate = document.createElement("p");
          gate.className = "kanban-card__gate";
          gate.textContent = "Frozen — done needs gate";
          li.appendChild(gate);
          li.classList.add("is-frozen");
        }
        li.appendChild(status);
        list.appendChild(li);
      }
      if (!list.children.length) {
        const empty = document.createElement("p");
        empty.className = "kanban-col__empty";
        empty.textContent = "Empty";
        section.append(h, empty);
      } else {
        section.append(h, list);
      }
      body.appendChild(section);
    }
    const assignee = overlay.querySelector("[data-kanban-assignee]");
    if (assignee) {
      assignee.innerHTML = "";
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "Unassigned";
      assignee.appendChild(none);
      for (const ex of executors) {
        const opt = document.createElement("option");
        opt.value = ex.id;
        opt.textContent = ex.title;
        assignee.appendChild(opt);
      }
    }
    overlay.dataset.managerId = current;
    overlay._template = template;
  }

  function open(template, managerId) {
    if (!overlay) return;
    overlay.hidden = false;
    overlay.classList.add("is-open");
    overlay.setAttribute("aria-hidden", "false");
    render(template, managerId);
  }

  function close() {
    overlay?.classList.remove("is-open");
    overlay?.setAttribute("aria-hidden", "true");
    if (overlay) overlay.hidden = true;
  }

  overlay?.querySelector("[data-kanban-close]")?.addEventListener("click", close);
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay
    ?.querySelector("[data-kanban-hermes-refresh]")
    ?.addEventListener("click", () => {
      refreshHermesLegacy();
    });
  overlay
    ?.querySelector("[data-kanban-hermes-clear]")
    ?.addEventListener("click", async () => {
      if (
        !window.confirm(
          "Archive/cancel all leftover Hermes Agent (t_*) tasks?\n\nThis does not clear the factory board — only old Hermes kanban workers."
        )
      ) {
        return;
      }
      const btn = overlay.querySelector("[data-kanban-hermes-clear]");
      if (btn) btn.disabled = true;
      try {
        const res = await fetch("/api/hermes-tasks/clear", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          window.alert(data.error || `Clear failed (${res.status})`);
        } else {
          const n = (data.cleared || []).length;
          const left = data.remaining ?? "?";
          window.alert(
            n
              ? `Cleared ${n} Hermes Agent task(s). ${left} still open.`
              : data.message || "Nothing to clear."
          );
        }
      } catch (err) {
        window.alert(String(err?.message || err));
      } finally {
        if (btn) btn.disabled = false;
        refreshHermesLegacy();
      }
    });
  overlay?.querySelector("[data-kanban-manager]")?.addEventListener("change", (e) => {
    render(overlay._template, e.target.value);
  });
  overlay?.querySelector("[data-kanban-add]")?.addEventListener("click", () => {
    const title = overlay.querySelector("[data-kanban-title]")?.value?.trim();
    const managerId = overlay.querySelector("[data-kanban-manager]")?.value;
    const assigneeId = overlay.querySelector("[data-kanban-assignee]")?.value || null;
    if (!title || !managerId) return;
    const main = mainOf(managerId);
    add({
      kind: "sub",
      parentId: main?.id || null,
      managerId,
      assigneeId,
      title,
      status: "todo",
      source: "board",
    });
    overlay.querySelector("[data-kanban-title]").value = "";
  });
  overlay?.querySelector("[data-kanban-clear]")?.addEventListener("click", () => {
    const managerId = overlay.querySelector("[data-kanban-manager]")?.value;
    if (!managerId) return;
    if (!window.confirm("Clear all cards for this manager?")) return;
    clear(managerId);
  });
  overlay?.querySelector("[data-kanban-clear-all]")?.addEventListener("click", () => {
    if (
      !window.confirm(
        "Stop & remove? This abandons the current run, clears every kanban card, and lets you give a new order."
      )
    ) {
      return;
    }
    try {
      onResetTasks?.();
    } catch {
      /* reset must not break the board */
    }
    if (!onResetTasks) clearAll();
    else if (overlay && !overlay.hidden) render(overlay._template, openManagerId);
  });

  return {
    add,
    addPlan,
    place,
    patch,
    get,
    complete,
    removeOpenByTitle,
    setStatus,
    readySubs,
    openSubs,
    mainOf,
    refreshBlocked,
    isDepBlocked,
    isApiFailed,
    isFrozen,
    clear,
    clearAll,
    snapshot,
    restore,
    open,
    close,
    render,
  };
}
