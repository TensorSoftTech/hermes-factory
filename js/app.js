import { createOffice } from "./office.js?v=bubble-click-4";
import { createAgents, swatchDataUrl } from "./agents.js?v=bubble-click-4";
import {
  createComms,
  renderRoster,
  syncRosterStatus,
} from "./comms.js?v=bubble-click-4";
import { createStats } from "./stats.js?v=bubble-click-4";
import { createMission } from "./mission.js?v=bubble-click-4";
import { createCommand } from "./command.js?v=bubble-click-4";
import { createSettings } from "./settings.js?v=bubble-click-4";
import {
  listTemplates,
  getTemplate,
  refreshTemplates,
  applySettingsToTemplate,
} from "./registry.js?v=bubble-click-4";
import { applyTheme, DEFAULT_THEME_ID } from "./themes.js?v=bubble-click-4";

const canvas = document.getElementById("office-canvas");
const rosterList = document.getElementById("roster-list");
const feedList = document.getElementById("feed-list");
const speechLayer = document.getElementById("speech-layer");
const templateLabel = document.getElementById("template-label");
const sessionStatsEl = document.getElementById("session-stats");
const usageTableEl = document.getElementById("usage-table");
const apiHistoryEl = document.getElementById("api-history");
const busyEl = document.getElementById("factory-busy");
const employeeCard = document.getElementById("employee-card");
const employeeCardClose = document.getElementById("employee-card-close");
let selectedEmployeeId = null;

const state = {
  settings: {
    templateId: "software-company",
    parentProfile: "default",
    roleProfiles: {},
  },
  profiles: [],
  template: null,
  office: null,
  agents: null,
  stats: null,
  mission: null,
  comms: null,
  edgeEvents: [],
};

state.mission = createMission({
  rootEl: document.getElementById("mission-root"),
});

function deskTile(deskId) {
  const desk = state.template?.desks?.find((d) => d.id === deskId);
  return desk ? desk.tile : null;
}

const command = createCommand({
  getTemplate: () => state.template,
  getSettings: () => state.settings,
  getAgents: () => state.agents,
  getOffice: () => state.office,
  getComms: () => state.comms,
  getStats: () => state.stats,
  getEdgeEvents: () => state.edgeEvents,
  getMission: () => state.mission,
  deskTile,
  sessionEl: sessionStatsEl,
  usageEl: usageTableEl,
  historyEl: apiHistoryEl,
  onBusy: (v) => {
    if (busyEl) busyEl.hidden = !v;
  },
});

function mountTemplate(rawTemplate, settings, { force = false } = {}) {
  // Remount mid-run wipes agents + clears mission bar — refuse unless forced (boot)
  if (!force && (command.isBusy?.() || state.mission?.isOpen?.())) {
    throw Object.assign(
      new Error(
        "Task still running — finish or wait before remounting the floor"
      ),
      { code: "BUSY_REMOUNT" }
    );
  }

  const template = applySettingsToTemplate(
    rawTemplate,
    settings,
    state.profiles
  );
  state.template = template;
  state.settings = settings;
  templateLabel.textContent = `${template.name} · parent ${settings.parentProfile || "default"}`;

  state.office = createOffice(canvas, template);
  state.agents = createAgents(template, {
    avatarStyle: settings.avatarStyle || "alien",
  });
  if (!state.stats) {
    state.stats = createStats(template);
    wireCallDetail(state.stats);
  } else {
    state.stats.rebuild(template);
  }
  state.stats.syncRoleMeta(template);

  state.comms = createComms({
    feedEl: feedList,
    speechLayerEl: speechLayer,
    agents: state.agents,
    onBubbleClick: (agentId, action) => {
      if (action === "dismiss") {
        state.agents?.clearBubble?.(agentId);
        return;
      }
      if (action === "board-reply") openBoardReply(agentId);
    },
  });
  state.edgeEvents.length = 0;
  state.comms.clearFeed();
  state.mission?.clear();

  renderRoster(rosterList, state.agents, swatchDataUrl, settings.avatarStyle || "alien");
  wireRosterClicks();
  closeEmployeeCard();
  command.refreshAssignee();
  command.refreshStats();
  // layout after the stage has real dimensions
  requestAnimationFrame(() => {
    state.office?.resize?.();
    state.office?.drawFloor();
    state.agents?.drawAll(canvas.getContext("2d"), state.office);
  });
}

function setEmp(sel, text) {
  const node = employeeCard?.querySelector(`[data-emp="${sel}"]`);
  if (node) node.textContent = text ?? "";
}

function closeEmployeeCard() {
  selectedEmployeeId = null;
  if (employeeCard) employeeCard.hidden = true;
}

function openEmployeeCard(agentId) {
  const agent = state.agents?.byId?.(agentId);
  const stats = state.stats?.agentStats?.(agentId);
  if (!agent || !employeeCard) return;
  selectedEmployeeId = agentId;

  const kind = agent.roleKind || "executor";
  setEmp("title", agent.title);
  setEmp(
    "sub",
    `${kind} · profile ${agent.hermesProfile || "default"} · ${agent.status}`
  );
  setEmp("desc", agent.description || "No description yet.");
  setEmp("tasks", String(stats?.tasks ?? stats?.tasksDone ?? 0));
  setEmp("calls", String(stats?.calls ?? 0));
  setEmp("tok-in", String(stats?.tokensIn ?? 0));
  setEmp("tok-out", String(stats?.tokensOut ?? 0));
  setEmp(
    "ok-err",
    `${stats?.okCalls ?? 0} / ${stats?.errCalls ?? 0}`
  );
  setEmp(
    "latency",
    stats?.avgLatencyMs != null
      ? state.stats.formatMs(stats.avgLatencyMs)
      : "—"
  );

  const recentEl = employeeCard.querySelector('[data-emp="recent"]');
  if (recentEl) {
    recentEl.innerHTML = "";
    const recent = stats?.recent || [];
    if (!recent.length) {
      const p = document.createElement("p");
      p.className = "employee-card__empty";
      p.textContent = "No Hermes runs for this employee yet.";
      recentEl.appendChild(p);
    } else {
      for (const entry of recent) {
        const li = document.createElement("li");
        li.dataset.ok = entry.ok ? "1" : "0";
        const kind = entry.isTask ? "task" : "chat";
        li.textContent = `#${entry.id} ${kind} · in ${entry.tokensIn} · out ${entry.tokensOut} · ${state.stats.formatMs(entry.latencyMs)}`;
        li.title = "Open full call";
        li.addEventListener("click", () => state.stats?.openDetail?.(entry.id));
        recentEl.appendChild(li);
      }
    }
  }

  employeeCard.hidden = false;
}

function refreshEmployeeCard() {
  if (selectedEmployeeId && employeeCard && !employeeCard.hidden) {
    openEmployeeCard(selectedEmployeeId);
  }
}

function wireRosterClicks() {
  rosterList?.querySelectorAll(".roster__item").forEach((li) => {
    li.style.cursor = "pointer";
    li.title = "Show employee stats";
    li.addEventListener("click", () => {
      const id = li.dataset.id;
      if (id) openEmployeeCard(id);
    });
  });
}

employeeCardClose?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeEmployeeCard();
});

const boardReplyOverlay = document.getElementById("board-reply-overlay");
const boardReplyReport = document.getElementById("board-reply-report");
const boardReplyInput = document.getElementById("board-reply-input");
const boardReplyCancel = document.getElementById("board-reply-cancel");
const boardReplySend = document.getElementById("board-reply-send");

function openBoardReply(agentId) {
  const ctx = command.getBoardReplyContext?.() || {};
  if (boardReplyReport) {
    boardReplyReport.textContent =
      ctx.report || "(No CEO report captured yet.)";
  }
  if (boardReplyInput) boardReplyInput.value = "";
  boardReplyOverlay?.classList.add("is-open");
  boardReplyOverlay?.setAttribute("aria-hidden", "false");
  boardReplyOverlay?.removeAttribute("hidden");
  boardReplyInput?.focus();
  // Keep sticky until send / cancel / × — agentId is the CEO who raised it
  void agentId;
}

function closeBoardReply() {
  boardReplyOverlay?.classList.remove("is-open");
  boardReplyOverlay?.setAttribute("aria-hidden", "true");
}

boardReplyCancel?.addEventListener("click", () => {
  const ctx = command.getBoardReplyContext?.() || {};
  if (ctx.orchId) state.agents?.clearBubble?.(ctx.orchId);
  closeBoardReply();
});

boardReplySend?.addEventListener("click", async () => {
  const text = boardReplyInput?.value?.trim();
  if (!text) return;
  closeBoardReply();
  try {
    await command.sendBoardReply(text);
  } catch (err) {
    console.error("[board-reply]", err);
  }
});

boardReplyOverlay?.addEventListener("click", (e) => {
  if (e.target === boardReplyOverlay) closeBoardReply();
});

canvas?.addEventListener("click", (e) => {
  if (!state.office || !state.agents) return;
  const { x, y } = state.office.clientToLocal(e.clientX, e.clientY);
  const hit = state.agents.hitTest(x, y, state.office);
  if (hit) openEmployeeCard(hit.id);
  else closeEmployeeCard();
});

canvas?.addEventListener("mousemove", (e) => {
  if (!state.office || !state.agents || !canvas) return;
  const { x, y } = state.office.clientToLocal(e.clientX, e.clientY);
  const hit = state.agents.hitTest(x, y, state.office);
  canvas.classList.toggle("is-hover-agent", Boolean(hit));
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.office || !state.agents) return;
    state.office.resize();
    state.office.drawFloor();
    state.agents.drawAll(canvas.getContext("2d"), state.office);
  }, 80);
});

function wireCallDetail(stats) {
  const overlay = document.getElementById("call-overlay");
  const closeBtn = document.getElementById("call-detail-close");
  if (!overlay || !stats) return;

  function openOverlay() {
    overlay.classList.add("is-open");
    overlay.setAttribute("aria-hidden", "false");
  }
  function closeOverlay() {
    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
  }

  stats.bindDetailUi(overlay, () => {
    // reset to overview tab each open
    overlay.querySelectorAll(".call-detail__tab").forEach((tab) => {
      const on = tab.dataset.tab === "overview";
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    });
    overlay.querySelectorAll(".call-detail__panel").forEach((panel) => {
      const on = panel.dataset.panel === "overview";
      panel.hidden = !on;
      panel.classList.toggle("is-active", on);
    });
    openOverlay();
  });

  overlay.querySelectorAll(".call-detail__tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const id = tab.dataset.tab;
      overlay.querySelectorAll(".call-detail__tab").forEach((t) => {
        const on = t.dataset.tab === id;
        t.classList.toggle("is-active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      overlay.querySelectorAll(".call-detail__panel").forEach((panel) => {
        const on = panel.dataset.panel === id;
        panel.hidden = !on;
        panel.classList.toggle("is-active", on);
      });
    });
  });

  closeBtn?.addEventListener("click", closeOverlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeOverlay();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("is-open")) {
      closeOverlay();
    }
  });
}

createSettings({
  getState: () => ({
    template: state.template,
    templateList: listTemplates(),
    getTemplate,
  }),
  isBusy: () => Boolean(command.isBusy?.() || state.mission?.isOpen?.()),
  onApply: async (saved) => {
    state.settings = saved;
    applyTheme(saved.themeId || DEFAULT_THEME_ID);
    try {
      const data = await fetch("/api/profiles").then((r) => r.json());
      state.profiles = data.profiles || [];
    } catch {
      /* keep */
    }
    await refreshTemplates();
    const tmpl = getTemplate(saved.templateId);
    if (!tmpl) throw new Error(`Template not found: ${saved.templateId}`);
    // Theme already applied above; remount only when idle so mission/agents stay up
    if (command.isBusy?.() || state.mission?.isOpen?.()) {
      state.settings = saved;
      command.refreshAssignee?.();
      throw Object.assign(
        new Error(
          "Saved to disk — floor NOT remounted (task/mission still active). Save & apply again when idle to remount."
        ),
        { code: "SOFT_APPLY", soft: true }
      );
    }
    mountTemplate(tmpl, saved);
  },
});

let lastTs = performance.now();
let lastCardRefresh = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (!state.agents || !state.office || !state.comms) return;
  const dt = Math.min(48, now - lastTs);
  lastTs = now;
  state.agents.update(dt);
  state.office.drawFloor();
  state.comms.drawEdges(
    canvas.getContext("2d"),
    state.office,
    state.edgeEvents,
    performance.now()
  );
  const anchors = state.agents.drawAll(canvas.getContext("2d"), state.office);
  state.comms.renderBubbles(anchors);
  syncRosterStatus(rosterList, state.agents);
  if (selectedEmployeeId && now - lastCardRefresh > 800) {
    lastCardRefresh = now;
    refreshEmployeeCard();
  }
}
requestAnimationFrame(frame);

function showRosterLoading(msg) {
  if (!rosterList) return;
  rosterList.innerHTML = `<li class="roster__item" style="opacity:0.7;cursor:default">${msg}</li>`;
}

async function boot() {
  showRosterLoading("Loading employees…");
  try {
    const health = await fetch("/api/health").then((r) => r.json());
    if (!health.ok) throw new Error("bridge unhealthy");
  } catch {
    document.body.innerHTML = `
      <main style="font-family:system-ui;padding:2rem;max-width:36rem;margin:auto;color:#f2e8d5;background:#1a1410;min-height:100vh">
        <h1>Bridge not running</h1>
        <p>Hermes Factory needs the local bridge on <strong>port 8787</strong> (not a plain static server).</p>
        <pre style="background:#2a2018;padding:1rem;overflow:auto">cd hermes-factory
python3 server/bridge.py</pre>
        <p>Then open <a href="http://127.0.0.1:8787" style="color:#e8a838">http://127.0.0.1:8787</a></p>
      </main>`;
    return;
  }

  const [settings, profilesPayload] = await Promise.all([
    fetch("/api/settings").then((r) => {
      if (!r.ok) throw new Error(`settings ${r.status}`);
      return r.json();
    }),
    fetch("/api/profiles").then((r) => {
      if (!r.ok) throw new Error(`profiles ${r.status}`);
      return r.json();
    }),
    refreshTemplates(),
  ]);
  const themeId = settings.themeId || DEFAULT_THEME_ID;
  applyTheme(themeId);
  state.profiles = profilesPayload.profiles || [];
  const byId = Object.fromEntries(state.profiles.map((p) => [p.id, p]));

  let raw = getTemplate(settings.templateId) || getTemplate("software-company");
  if (!raw?.roles?.length) {
    throw new Error("No templates available — check ~/.hermes-factory/templates");
  }

  const needsSeed =
    !settings.roleProfiles || !Object.keys(settings.roleProfiles).length;

  settings.roleProfiles = Object.fromEntries(
    (raw.roles || []).map((r) => {
      const existing = settings.roleProfiles?.[r.id] || {};
      const hermesProfile =
        existing.hermesProfile ||
        r.hermesProfile ||
        settings.parentProfile ||
        "default";
      const live = byId[hermesProfile];
      return [
        r.id,
        {
          hermesProfile,
          provider: live?.provider || "unknown",
          model: live?.model || "unknown",
        },
      ];
    })
  );

  if (needsSeed) {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  }

  mountTemplate(raw, settings, { force: true });
  if (!state.agents?.list?.length) {
    throw new Error("Mount produced no employees");
  }
  document.getElementById("chat-input")?.focus();
}

boot().catch((err) => {
  console.error("[boot]", err);
  setStatusFatal(err);
  showRosterLoading(`Boot failed: ${err.message || err}`);
});

function setStatusFatal(err) {
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<p style="background:#c62828;color:#fff;padding:0.75rem;margin:0;font-family:system-ui;z-index:9999;position:relative">Boot error: ${String(
      err.message || err
    )} — open <a href="http://127.0.0.1:8787" style="color:#fff">http://127.0.0.1:8787</a> (bridge), hard-refresh.</p>`
  );
}
