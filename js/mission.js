/** Live mission / task progress — who is active, who processed what, delivered? */

const OPEN_STATES = new Set(["pending", "in_progress", "blocked"]);

export function createMission({ rootEl }) {
  if (!rootEl) {
    return {
      start() {},
      ensureStep() {},
      setActive() {},
      markStep() {},
      setDelivered() {},
      setOpen() {},
      setNextPing() {},
      setPinging() {},
      clear() {},
      getState: () => null,
      isOpen: () => false,
    };
  }

  let mission = null;
  let tickTimer = null;

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
      (mission.pinging ? " mission--pinging" : "");

    const head = document.createElement("div");
    head.className = "mission__head";

    const title = document.createElement("p");
    title.className = "mission__title";
    title.textContent = mission.title;

    const badge = document.createElement("span");
    badge.className =
      "mission__badge mission__badge--" +
      (mission.delivered ? "delivered" : mission.taskState || "pending");
    badge.textContent = mission.delivered
      ? "DELIVERED"
      : String(mission.taskState || "pending").replace("_", " ").toUpperCase();

    head.append(title, badge);

    const active = document.createElement("p");
    active.className = "mission__active";
    if (mission.pinging) {
      const step = mission.steps.find((s) => s.id === mission.activeId);
      const prof = step ? profileLine(step) : "";
      active.innerHTML = `<span class="mission__pulse"></span> Progress ping · <strong>${
        step?.title || "agents"
      }</strong>${prof ? ` · <code>${prof}</code>` : ""}`;
    } else if (mission.activeId) {
      const step = mission.steps.find((s) => s.id === mission.activeId);
      const prof = step ? profileLine(step) : "";
      active.innerHTML = `<span class="mission__pulse"></span> Active · <strong>${
        step?.title || mission.activeId
      }</strong> · ${mission.phase || "working"}${
        prof ? ` · <code>${prof}</code>` : ""
      }`;
    } else if (mission.delivered) {
      active.textContent = "Mission closed — board has the final status.";
    } else {
      active.textContent = "Open mission — waiting on progress.";
    }

    const track = document.createElement("ol");
    track.className = "mission__track";
    const doneCount = mission.steps.filter((s) =>
      ["done", "hold", "reported"].includes(s.status)
    ).length;
    const pct = mission.steps.length
      ? Math.round((doneCount / mission.steps.length) * 100)
      : 0;

    mission.steps.forEach((step, i) => {
      const li = document.createElement("li");
      li.className =
        "mission__step mission__step--" +
        step.status +
        (step.id === mission.activeId ? " is-active" : "");
      li.title = step.note || step.title;

      const node = document.createElement("div");
      node.className = "mission__node";
      node.textContent =
        step.status === "done" || step.status === "reported"
          ? "✓"
          : step.status === "hold"
            ? "■"
            : step.status === "active"
              ? "●"
              : String(i + 1);

      const label = document.createElement("span");
      label.className = "mission__step-label";
      label.textContent = step.title;

      const profile = document.createElement("span");
      profile.className = "mission__step-profile";
      profile.textContent = step.hermesProfile
        ? `profile ${step.hermesProfile}`
        : "profile ?";
      profile.title = `Hermes profile: ${step.hermesProfile || "?"}`;

      const state = document.createElement("span");
      state.className = "mission__step-state";
      state.textContent = step.taskState
        ? step.taskState.replace("_", " ")
        : step.status;

      li.append(node, label, profile, state);
      track.appendChild(li);

      if (i < mission.steps.length - 1) {
        const rail = document.createElement("li");
        rail.className =
          "mission__rail" +
          (["done", "reported", "hold"].includes(step.status)
            ? " mission__rail--lit"
            : "");
        rail.setAttribute("aria-hidden", "true");
        track.appendChild(rail);
      }
    });

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
    } else {
      const left =
        mission.nextPingAt != null
          ? formatCountdown(mission.nextPingAt - Date.now())
          : "—";
      meta.textContent = `${pct}% processed · ${doneCount}/${mission.steps.length} roles · next progress ping ${left}`;
    }

    rootEl.append(head, active, track, barWrap, meta);
    window.dispatchEvent(new Event("resize"));
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
      title: (title || "Mission").slice(0, 120),
      taskState: "pending",
      phase: "down",
      activeId: startId || steps?.[0]?.id || null,
      delivered: false,
      pinging: false,
      nextPingAt: null,
      pingCount: 0,
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

  function setActive(roleId, phase) {
    if (!mission) return;
    mission.activeId = roleId;
    mission.phase = phase || mission.phase;
    for (const s of mission.steps) {
      if (s.id === roleId && s.status === "queued") s.status = "active";
    }
    ensureDom();
  }

  function markStep(roleId, { status, taskState, note } = {}) {
    if (!mission) return;
    const step = mission.steps.find((s) => s.id === roleId);
    if (step) {
      if (status) step.status = status;
      if (taskState) {
        step.taskState = taskState;
        mission.taskState = taskState;
      }
      if (note) step.note = note;
    }
    ensureDom();
  }

  function setDelivered(taskState) {
    if (!mission) return;
    mission.delivered = true;
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
    mission.pinging = false;
    mission.activeId = null;
    mission.phase = "open";
    if (taskState) mission.taskState = taskState;
    ensureDom();
    startTick();
  }

  function setNextPing(ts) {
    if (!mission || mission.delivered) return;
    mission.nextPingAt = ts;
    ensureDom();
  }

  function setPinging(v) {
    if (!mission) return;
    mission.pinging = Boolean(v);
    if (v) mission.pingCount = (mission.pingCount || 0) + 1;
    ensureDom();
  }

  function clear() {
    mission = null;
    stopTick();
    ensureDom();
  }

  function isOpen() {
    if (!mission || mission.delivered) return false;
    const st = mission.taskState || "pending";
    return OPEN_STATES.has(st) || st !== "done";
  }

  ensureDom();

  return {
    start,
    ensureStep,
    setActive,
    markStep,
    setDelivered,
    setOpen,
    setNextPing,
    setPinging,
    clear,
    getState: () => mission,
    isOpen,
  };
}
