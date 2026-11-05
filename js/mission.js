/** Live mission / task progress — who is active, who processed what, delivered? */

const OPEN_STATES = new Set(["pending", "in_progress", "blocked"]);

export function createMission({
  rootEl,
  onChange = null,
  onPause = null,
  onStop = null,
  getKanban = null,
} = {}) {
  if (!rootEl) {
    return {
      start() {},
      ensureStep() {},
      setActive() {},
      setActivity() {},
      markStep() {},
      syncFromKanban() {},
      setDelivered() {},
      setOpen() {},
      setNextPing() {},
      setPinging() {},
      pause() {},
      clear() {},
      restore() {},
      getState: () => null,
      isOpen: () => false,
      isPaused: () => false,
    };
  }

  let mission = null;
  let tickTimer = null;

  rootEl.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-mission-act]");
    if (!btn || !rootEl.contains(btn)) return;
    const act = btn.dataset.missionAct;
    if (act === "pause") onPause?.();
    else if (act === "stop" || act === "remove") onStop?.();
  });

  function notify() {
    try {
      onChange?.(mission);
    } catch {
      /* persistence must never break the UI */
    }
  }

  function stopTick() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function startTick() {
    stopTick();
    if (!mission || mission.delivered) return;
    tickTimer = setInterval(() => {
      if (!mission || mission.delivered) {
        stopTick();
        return;
      }
      ensureDom();
    }, 1000);
  }

  function formatCountdown(ms) {
    if (ms == null || ms <= 0) return "now";
    const s = Math.ceil(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}:${String(r).padStart(2, "0")}` : `0:${String(r).padStart(2, "0")}`;
  }

  function ensureDom() {
    rootEl.hidden = !mission;
    if (!mission) {
      rootEl.innerHTML = "";
      window.dispatchEvent(new Event("resize"));
      return;
    }

    rootEl.innerHTML = "";
    rootEl.className =
      "mission" +
      (mission.delivered ? " mission--delivered" : "") +
      (mission.paused ? " mission--paused" : "") +
      (mission.pinging ? " mission--pinging" : "");

    const head = document.createElement("div");
    head.className = "mission__head";

    const title = document.createElement("p");
    title.className = "mission__title";
    title.textContent = mission.title;

    const badge = document.createElement("span");
    const badgeKind = mission.delivered
      ? "delivered"
      : mission.paused
        ? "paused"
        : mission.taskState || "pending";
    badge.className = "mission__badge mission__badge--" + badgeKind;
    badge.textContent = mission.delivered
      ? "DELIVERED"
      : mission.paused
        ? "PAUSED"
        : String(mission.taskState || "pending").replace("_", " ").toUpperCase();

    const actions = document.createElement("div");
    actions.className = "mission__actions";
    if (!mission.delivered && !mission.paused) {
      const pauseBtn = document.createElement("button");
      pauseBtn.type = "button";
      pauseBtn.className = "btn-ghost mission__act";
      pauseBtn.dataset.missionAct = "pause";
      pauseBtn.title = "Pause this run and free the dock for a new order";
      pauseBtn.textContent = "Pause";
      const stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.className = "btn-ghost mission__act";
      stopBtn.dataset.missionAct = "stop";
      stopBtn.title = "Stop and remove this task";
      stopBtn.textContent = "Stop & remove";
      actions.append(pauseBtn, stopBtn);
    } else if (mission.paused) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn-ghost mission__act";
      removeBtn.dataset.missionAct = "remove";
      removeBtn.title = "Remove the paused task";
      removeBtn.textContent = "Remove";
      actions.append(removeBtn);
    } else if (mission.delivered) {
      const dismissBtn = document.createElement("button");
      dismissBtn.type = "button";
      dismissBtn.className = "btn-ghost mission__act";
      dismissBtn.dataset.missionAct = "remove";
      dismissBtn.title = "Clear the mission bar";
      dismissBtn.textContent = "Dismiss";
      actions.append(dismissBtn);
    }

    head.append(title, badge, actions);

    const active = document.createElement("p");
    active.className = "mission__active";
    if (mission.paused) {
      active.textContent =
        "Paused — dock is free. Send a new order anytime, or Remove this task.";
    } else if (mission.pinging) {
      const step = mission.steps.find((s) => s.id === mission.activeId);
      const prof = step ? profileLine(step) : "";
      active.innerHTML = `<span class="mission__pulse"></span> Progress ping · <strong>${
        step?.title || "agents"
      }</strong>${prof ? ` · <code>${prof}</code>` : ""}`;
    } else if (mission.activeId) {
      const step = mission.steps.find((s) => s.id === mission.activeId);
      const prof = step ? profileLine(step) : "";
      const act = mission.activity;
      const doing = act?.label || phaseLabel(mission.phase);
      const elapsed =
        act?.startedAt && !act.endedAt
          ? ` · ${formatCountdown(Date.now() - act.startedAt)}`
          : "";
      const tokens =
        act?.tokensIn != null || act?.tokensOut != null
          ? ` · in ${act.tokensIn ?? "—"} · out ${act.tokensOut ?? "—"}`
          : "";
      active.innerHTML = `<span class="mission__pulse"></span> Active · <strong>${
        step?.title || mission.activeId
      }</strong> · ${doing}${
        prof ? ` · <code>${prof}</code>` : ""
      }${elapsed}${tokens}`;
    } else if (mission.delivered) {
      active.textContent = "Mission closed — board has the final status.";
    } else {
      active.textContent = "Open mission — waiting on progress.";
    }

    // Parallel-friendly board — not a fake linear pipeline
    const track = document.createElement("div");
    track.className = "mission__board";
    const doneCount = mission.steps.filter((s) =>
      ["done", "reported"].includes(s.status)
    ).length;
    // Prefer factory kanban card completion — ping "active" steps made this look stuck at 0%
    const cards = (getKanban?.()?.snapshot?.() || []).filter(
      (c) => c && c.kind !== "main"
    );
    const cardsDone = cards.filter((c) => c.status === "done").length;
    const pct = cards.length
      ? Math.round((cardsDone / cards.length) * 100)
      : mission.steps.length
        ? Math.round((doneCount / mission.steps.length) * 100)
        : 0;

    const groups = [
      {
        id: "done",
        label: "Done",
        match: (s) => s.status === "done" || s.status === "reported",
      },
      {
        id: "active",
        label: "Active",
        // Don't keep done/waiting roles in Active just because activeId points at them
        match: (s) =>
          !["done", "reported", "waiting", "hold"].includes(s.status) &&
          (s.status === "active" || s.id === mission.activeId),
      },
      {
        id: "waiting",
        label: "Waiting",
        match: (s) => s.status === "waiting" || s.status === "hold",
      },
      {
        id: "queued",
        label: "Queued",
        match: (s) => s.status === "queued",
      },
    ];
    const placed = new Set();
    for (const g of groups) {
      const members = mission.steps.filter((s) => {
        if (placed.has(s.id)) return false;
        if (!g.match(s)) return false;
        placed.add(s.id);
        return true;
      });
      if (!members.length) continue;
      const row = document.createElement("div");
      row.className = `mission__group mission__group--${g.id}`;
      const head = document.createElement("span");
      head.className = "mission__group-label";
      head.textContent = g.label;
      const pills = document.createElement("div");
      pills.className = "mission__pills";
      for (const step of members) {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className =
          "mission__pill mission__pill--" +
          (g.id === "active" && step.id === mission.activeId
            ? "active"
            : g.id);
        const short =
          g.id === "waiting" && !step._expanded
            ? "waiting…"
            : step.note
              ? String(step.note).replace(/^Waiting on:\s*/i, "").slice(0, 42)
              : step.title;
        const dot = document.createElement("span");
        dot.className = "mission__pill-dot";
        dot.setAttribute("aria-hidden", "true");
        const name = document.createElement("span");
        name.className = "mission__pill-name";
        name.textContent = step.title;
        const detail = document.createElement("span");
        detail.className = "mission__pill-detail";
        detail.textContent = short;
        pill.append(dot, name, detail);
        pill.title =
          g.id === "waiting"
            ? step._expanded
              ? "Click to collapse"
              : "Click to show what they’re waiting on"
            : `${step.title}${step.note ? ` — ${step.note}` : ""}`;
        if (g.id === "waiting") {
          pill.addEventListener("click", () => {
            step._expanded = !step._expanded;
            ensureDom();
          });
        }
        pills.appendChild(pill);
      }
      row.append(head, pills);
      track.appendChild(row);
    }

    const barWrap = document.createElement("div");
    barWrap.className = "mission__bar-wrap";
    const bar = document.createElement("div");
    bar.className = "mission__bar";
    bar.style.width = `${mission.delivered ? 100 : Math.max(8, pct)}%`;
    barWrap.append(bar);

    const meta = document.createElement("p");
    meta.className = "mission__meta";
    if (mission.delivered) {
      meta.textContent = `Delivered to board · ${mission.taskState || "done"}`;
    } else if (mission.paused) {
      meta.textContent = cards.length
        ? `${pct}% cards when paused · ${cardsDone}/${cards.length} · pings stopped`
        : `${pct}% processed when paused · ${doneCount}/${mission.steps.length} roles · pings stopped`;
    } else {
      const left =
        mission.nextPingAt != null
          ? formatCountdown(mission.nextPingAt - Date.now())
          : "—";
      meta.textContent = cards.length
        ? `${pct}% cards · ${cardsDone}/${cards.length} done · next progress ping ${left}`
        : `${pct}% processed · ${doneCount}/${mission.steps.length} roles · next progress ping ${left}`;
    }

    const snippet = document.createElement("p");
    snippet.className = "mission__activity";
    if (mission.activity?.snippet) {
      snippet.textContent = mission.activity.snippet;
    } else if (mission.activity?.kind === "api") {
      snippet.textContent =
        "Hermes call in flight — no reply yet. This is one API turn, not a hidden extra call.";
    } else {
      snippet.hidden = true;
    }

    rootEl.append(head, active, snippet, track, barWrap, meta);
    window.dispatchEvent(new Event("resize"));
    notify();
  }

  function phaseLabel(phase) {
    const map = {
      intake: "taking the request",
      graph: "deciding the next handoff",
      evaluate: "reviewing the work",
      verify: "verifying for the board",
      ping: "progress check",
      working: "working",
    };
    return map[phase] || phase || "working";
  }

  function profileLine(step) {
    if (!step?.hermesProfile) return "";
    return step.hermesProfile;
  }

  function stepMeta(s = {}) {
    return {
      hermesProfile: s.hermesProfile || null,
      provider: s.provider || null,
      model: s.model || null,
    };
  }

  function start({ title, steps, startId }) {
    mission = {
      missionId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: (title || "Mission").slice(0, 120),
      taskState: "pending",
      phase: "down",
      startedAt: Date.now(),
      activeId: startId || steps?.[0]?.id || null,
      delivered: false,
      paused: false,
      pinging: false,
      nextPingAt: null,
      pingCount: 0,
      activity: null,
      steps: (steps || []).map((s) => ({
        id: s.id,
        title: s.title,
        status: s.id === startId ? "active" : "queued",
        taskState: null,
        note: "",
        ...stepMeta(s),
      })),
    };
    ensureDom();
    startTick();
  }

  function ensureStep({ id, title, hermesProfile, provider, model }) {
    if (!mission || !id) return;
    const existing = mission.steps.find((s) => s.id === id);
    if (existing) {
      if (hermesProfile) existing.hermesProfile = hermesProfile;
      if (provider) existing.provider = provider;
      if (model) existing.model = model;
      if (title) existing.title = title;
      ensureDom();
      return;
    }
    mission.steps.push({
      id,
      title: title || id,
      status: "queued",
      taskState: null,
      note: "",
      ...stepMeta({ hermesProfile, provider, model }),
    });
  }

  function setActivity(activity) {
    if (!mission) return;
    mission.activity = activity || null;
    ensureDom();
  }

  function setActive(roleId, phase) {
    if (!mission) return;
    mission.activeId = roleId;
    mission.phase = phase || mission.phase;
    for (const s of mission.steps) {
      if (s.id === roleId && s.status === "queued") s.status = "active";
    }
    ensureDom();
  }

  function markStep(roleId, { status, taskState, note, rollUp = true } = {}) {
    if (!mission) return;
    const step = mission.steps.find((s) => s.id === roleId);
    if (step) {
      if (status) step.status = status;
      if (taskState) {
        step.taskState = taskState;
        // Pings must pass rollUp:false — otherwise TASK_STATE: done closes the
        // mission without a CEO board DELIVERED report.
        if (rollUp) mission.taskState = taskState;
      }
      if (note) step.note = note;
    }
    ensureDom();
  }

  /**
   * Reconcile mission pills with factory kanban — clears stale Active/Waiting
   * when every card for a role (or the whole board) is already done.
   */
  function syncFromKanban(cards = []) {
    if (!mission || mission.delivered || mission.paused) return;
    const subs = (cards || []).filter((c) => c && c.kind !== "main");
    if (!subs.length) return;

    const byRole = new Map();
    for (const c of subs) {
      if (!c.assigneeId) continue;
      const bucket = byRole.get(c.assigneeId) || {
        doing: 0,
        ready: 0,
        blocked: 0,
        review: 0,
        done: 0,
        open: 0,
      };
      if (c.status === "doing") bucket.doing += 1;
      else if (c.status === "todo") bucket.ready += 1;
      else if (c.status === "blocked") bucket.blocked += 1;
      else if (c.status === "review") bucket.review += 1;
      else if (c.status === "done") bucket.done += 1;
      if (c.status !== "done") bucket.open += 1;
      byRole.set(c.assigneeId, bucket);
    }

    const allDone = subs.every((c) => c.status === "done");
    for (const step of mission.steps) {
      const b = byRole.get(step.id);
      if (!b) {
        if (allDone && ["active", "waiting", "hold", "queued"].includes(step.status)) {
          step.status = "done";
        }
        continue;
      }
      if (b.doing || b.review) {
        step.status = "active";
        if (b.doing) step.note = step.note || "Working";
      } else if (b.blocked && !b.ready) {
        step.status = "waiting";
      } else if (b.ready) {
        step.status = "queued";
        step.note = step.note?.startsWith("Ready:")
          ? step.note
          : `Ready (${b.ready})`;
      } else if (b.open === 0 && b.done > 0) {
        step.status = "done";
      }
    }

    if (allDone) {
      mission.activeId = null;
      mission.phase = mission.taskState === "done" ? "verify" : "open";
      for (const step of mission.steps) {
        if (["active", "waiting", "hold", "queued"].includes(step.status)) {
          step.status = "done";
        }
      }
    } else if (
      mission.activeId &&
      ["done", "reported", "waiting", "hold"].includes(
        mission.steps.find((s) => s.id === mission.activeId)?.status
      )
    ) {
      const working = mission.steps.find((s) => s.status === "active");
      mission.activeId = working?.id || null;
    }
    ensureDom();
  }

  function setDelivered(taskState) {
    if (!mission) return;
    mission.delivered = true;
    mission.deliveredAt = Date.now();
    mission.pinging = false;
    mission.activeId = null;
    mission.phase = "delivered";
    mission.nextPingAt = null;
    if (taskState) mission.taskState = taskState;
    for (const s of mission.steps) {
      if (s.status === "active" || s.status === "queued") s.status = "done";
    }
    stopTick();
    ensureDom();
  }

  /** Mission still open (not done) — keep ping schedule alive */
  function setOpen(taskState) {
    if (!mission) return;
    mission.delivered = false;
    mission.paused = false;
    mission.pinging = false;
    mission.activeId = null;
    mission.phase = "open";
    if (taskState) mission.taskState = taskState;
    ensureDom();
    startTick();
  }

  function setNextPing(ts) {
    if (!mission || mission.delivered || mission.paused) return;
    mission.nextPingAt = ts;
    ensureDom();
  }

  function setPinging(v) {
    if (!mission || mission.paused) return;
    mission.pinging = Boolean(v);
    if (v) mission.pingCount = (mission.pingCount || 0) + 1;
    ensureDom();
  }

  /** Freeze the mission bar; dock can take a new order. */
  function pause() {
    if (!mission || mission.delivered) return;
    mission.paused = true;
    mission.pinging = false;
    mission.nextPingAt = null;
    mission.activity = null;
    mission.phase = "paused";
    mission.activeId = null;
    stopTick();
    ensureDom();
  }

  function clear() {
    mission = null;
    stopTick();
    ensureDom();
  }

  /** Rehydrate a persisted mission after a page refresh. */
  function restore(state) {
    if (!state || typeof state !== "object" || !Array.isArray(state.steps)) {
      return;
    }
    mission = {
      pingCount: 0,
      nextPingAt: null,
      activeId: null,
      paused: Boolean(state.paused),
      phase: state.delivered
        ? "delivered"
        : state.paused
          ? "paused"
          : "restored",
      ...state,
      // Never restore mid-ping — a dead tab left pinging:true and looked frozen
      pinging: false,
      paused: Boolean(state.paused),
      activeId: state.delivered || state.paused ? null : state.activeId || null,
    };
    ensureDom();
    if (!mission.delivered && !mission.paused) startTick();
  }

  function isOpen() {
    // Stay open until CEO board delivery — taskState "done" alone is not enough
    if (!mission || mission.delivered || mission.paused) return false;
    return true;
  }

  function isPaused() {
    return Boolean(mission && mission.paused && !mission.delivered);
  }

  ensureDom();

  return {
    start,
    ensureStep,
    setActive,
    setActivity,
    markStep,
    syncFromKanban,
    setDelivered,
    setOpen,
    setNextPing,
    setPinging,
    pause,
    clear,
    restore,
    getState: () => mission,
    isOpen,
    isPaused,
  };
}
