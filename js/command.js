/**
 * Operator dock → real Hermes profiles via bridge /api/run
 *
 * Role-kind graph (not a fixed pipeline):
 *   Board ⇄ Orchestrator ⇄ Manager → Executor ⇄ Manager (interval progress)
 *                                         ↓
 *                                    Evaluator → Manager
 * Manager chooses: DELEGATE to executor OR REPORT_UP to orchestrator.
 * Executor property: while working, report progress at intervals to
 * takesOrdersFrom (who gave the order) — then hand off to evaluator.
 * Orchestrator is start + end (verify + DELIVERED to board).
 */

import { runHermes, profileForRole } from "./hermes.js";
import {
  normalizeBossId,
  roleById,
  roleTitle,
  normalizeRoleKind,
  roleKindLabel,
  delegateCandidates,
  evaluatorForExecutor,
  orderGiverForExecutor,
  reportUpTarget,
} from "./registry.js";

const MAX_HOPS = 16;
const PROGRESS_PING_MS = 60_000;
/** Extra work+report cycles if still in_progress after the first (max total = 1 + this) */
const EXECUTOR_EXTRA_PROGRESS = 1;

function orgLine(template, role) {
  const kind = normalizeRoleKind(role.roleKind, {
    isOrchestrator: role.id === template.orchestratorRoleId,
  });
  const orders = roleTitle(template, normalizeBossId(role.takesOrdersFrom));
  const reports = roleTitle(template, normalizeBossId(role.reportsTo));
  const base = `Your role kind is ${roleKindLabel(kind)} (${kind}). You take orders from ${orders}. You report to ${reports}.`;
  if (kind !== "executor") return base;
  return `${base} As an executor, after you work you report progress to ${orders} (who gave you the order) before QC.`;
}

function parseTaskState(text, fallback = "in_progress") {
  const m = String(text).match(
    /TASK_STATE:\s*(pending|in_progress|blocked|done)/i
  );
  if (!m) return fallback;
  return m[1].toLowerCase();
}

function parseChainAction(text, allowedIds) {
  if (/\bDONE\b/i.test(text) && !/DELEGATE:\s*[a-z0-9_-]+/i.test(text)) {
    return { type: "done", id: null };
  }
  const m = String(text).match(/DELEGATE:\s*([a-z0-9_-]+)/i);
  if (!m) return { type: "done", id: null };
  const id = m[1].toLowerCase();
  if (!allowedIds.includes(id)) return { type: "done", id: null };
  return { type: "delegate", id };
}

/** Manager graph choice: DELEGATE executor | REPORT_UP | HOLD */
function parseManagerGraphAction(text, executorIds) {
  const del = String(text).match(/DELEGATE:\s*([a-z0-9_-]+)/i);
  if (del) {
    const id = del[1].toLowerCase();
    if (executorIds.includes(id)) return { type: "delegate", id };
  }
  if (/\bHOLD\b/i.test(text) && !/REPORT_UP\s*:/i.test(text)) {
    return { type: "hold", state: parseTaskState(text, "in_progress") };
  }
  const up = String(text).match(
    /REPORT_UP:\s*(pending|in_progress|blocked|done)/i
  );
  if (up) return { type: "report_up", state: up[1].toLowerCase() };
  // Default: if they named a valid executor anywhere as DELEGATE miss, report up
  return {
    type: "report_up",
    state: parseTaskState(text, "in_progress"),
  };
}

function leafWorkPrompt(
  template,
  role,
  brief,
  { fromBoard = false, fromRole = null, round = 1 } = {}
) {
  const orderGiver = orderGiverForExecutor(template, role.id);
  const orderGiverTitle =
    orderGiver?.title ||
    fromRole?.title ||
    roleTitle(template, normalizeBossId(role.takesOrdersFrom)) ||
    "your manager";
  const assigner = fromBoard
    ? "the board"
    : fromRole
      ? `${fromRole.title} (your order-giver)`
      : orderGiverTitle;
  const evaluator = evaluatorForExecutor(template, role.id);
  const finishHint = evaluator
    ? `When ready for QC set TASK_STATE: done (you will report to ${orderGiverTitle} first, then ${evaluator.title}).`
    : `When finished set TASK_STATE: done.`;
  return [
    `You are the ${role.title} in a software company agent factory.`,
    orgLine(template, role),
    `You are an executor — you own the hands-on work.`,
    `After this reply you walk over and report to ${orderGiverTitle} (who gave you the order).`,
    `${assigner.charAt(0).toUpperCase() + assigner.slice(1)} assigned this (round ${round}):`,
    brief,
    `Reply with 2-4 sentences: progress, blockers, next step.`,
    finishHint,
    `End with exactly: TASK_STATE: <pending|in_progress|blocked|done>`,
  ].join("\n");
}

function orchestratorChoosePrompt(
  template,
  role,
  brief,
  candidates,
  { fromBoard = false } = {}
) {
  const titles = candidates
    .map((r) => `${r.title} (${r.id})`)
    .join(", ");
  const ids = candidates.map((r) => r.id).join(", ");
  return [
    `You are the ${role.title}, the orchestrator.`,
    orgLine(template, role),
    fromBoard ? "The board just messaged you." : "You need to route this work.",
    `You talk to managers. Pick who handles this next, or own a quick reply yourself.`,
    `Managers: ${titles}.`,
    `Reply briefly (2-4 sentences).`,
    `Then end with exactly one of:`,
    `  DELEGATE: <role_id>   — talk to that manager (valid: ${ids})`,
    `  DONE                  — you handle it; no manager handoff`,
    `Also include: TASK_STATE: <pending|in_progress|blocked|done>`,
    ``,
    `Context:`,
    brief,
  ].join("\n");
}

/**
 * Manager decision node on the graph:
 * edge → executor (DELEGATE) OR edge → orchestrator (REPORT_UP).
 * May have several executors (e.g. multiple software engineers) — pick one id.
 */
function managerDecidePrompt(
  template,
  role,
  brief,
  executors,
  upTarget,
  { fromBoard = false, fromRole = null, afterEval = false } = {}
) {
  const titles = executors
    .map((r) => `${r.title} (${r.id})`)
    .join(", ");
  const ids = executors.map((r) => r.id).join(", ");
  const upTitle = upTarget?.title || "orchestrator";
  const source = afterEval
    ? `${fromRole?.title || "Evaluator"} just returned QC results to you.`
    : fromBoard
      ? "The board (via orchestrator) just messaged you."
      : fromRole
        ? `${fromRole.title} just handed you this.`
        : "You were handed this work.";
  const multi =
    executors.length > 1
      ? `You have ${executors.length} executors — pick the best one for this work (use their role_id exactly).`
      : "";
  return [
    `You are the ${role.title}, a manager node in the org graph.`,
    orgLine(template, role),
    source,
    `Your edges: send work to an executor, OR report up to ${upTitle} (orchestrator).`,
    `Executors go to QC/QA automatically — you do not talk to evaluators directly.`,
    executors.length
      ? `Valid executors: ${titles}.`
      : `No executors available — report up or HOLD.`,
    multi,
    `Reply briefly (2-4 sentences) with your decision and task view.`,
    `Then end with exactly one of:`,
    executors.length
      ? `  DELEGATE: <role_id>   — assign one executor (valid: ${ids})`
      : `  (no DELEGATE options)`,
    `  REPORT_UP: <pending|in_progress|blocked|done>  — escalate to ${upTitle}`,
    `  HOLD  — stay here; do not report up yet`,
    `Also include: TASK_STATE: <pending|in_progress|blocked|done>`,
    ``,
    `Context:`,
    brief,
  ]
    .filter(Boolean)
    .join("\n");
}

function evaluatorValidatePrompt(
  template,
  role,
  boardMessage,
  fromRole,
  executorReply,
  executorState
) {
  const manager = roleTitle(template, normalizeBossId(role.reportsTo));
  return [
    `You are the ${role.title}, the evaluator (QC / QA).`,
    orgLine(template, role),
    `You always sit between the executor and the manager.`,
    `Original board request:`,
    boardMessage,
    ``,
    `Executor ${fromRole.title} just finished their work.`,
    `Their TASK_STATE: ${executorState}`,
    `Their message:`,
    executorReply,
    ``,
    `Validate the work. Add findings, missing info, risks, and a clear recommendation.`,
    `Write 3-6 sentences for ${manager}.`,
    `End with exactly: TASK_STATE: <pending|in_progress|blocked|done>`,
  ].join("\n");
}

function orchestratorIntakeFromManagerPrompt(
  template,
  role,
  boardMessage,
  fromRole,
  subordinateReply,
  subordinateState
) {
  return [
    `You are the ${role.title}, the orchestrator.`,
    orgLine(template, role),
    `Original board request:`,
    boardMessage,
    ``,
    `Manager ${fromRole.title} just reported up to you.`,
    `Their TASK_STATE: ${subordinateState}`,
    `Their message:`,
    subordinateReply,
    ``,
    `Write 2-4 sentences summarizing status at company level.`,
    `End with: TASK_STATE: <pending|in_progress|blocked|done>`,
  ].join("\n");
}

function pathSummaryLines(path, template) {
  if (!path?.length) return "(no chain steps recorded)";
  return path
    .map((step, i) => {
      const title = roleTitle(template, step.id);
      return `${i + 1}. ${title} (${step.id}) · TASK_STATE ${step.state}\n   ${String(
        step.reply || ""
      ).slice(0, 280)}`;
    })
    .join("\n");
}

/**
 * Board target (CEO) must verify work and send a delivery report to the board
 * before a mission can be marked delivered.
 */
function ceoVerifyDeliverPrompt(
  template,
  role,
  boardMessage,
  rolledState,
  path,
  profileId
) {
  return [
    `You are the ${role.title}, the board contact.`,
    `Hermes profile: ${profileId || role.hermesProfile || "default"}.`,
    orgLine(template, role),
    ``,
    `Your org rolled up TASK_STATE: ${rolledState}.`,
    `Original board request:`,
    boardMessage,
    ``,
    `Chain of work (who did what):`,
    pathSummaryLines(path, template),
    ``,
    `VERIFY before you report to the board:`,
    `- Confirm whether the work is actually complete`,
    `- Summarize what was done, where (systems / areas / artifacts), and by whom`,
    `- Call out gaps, risks, or follow-ups`,
    ``,
    `Write a board delivery report (4-8 sentences): verification + what / where / who / outcome.`,
    `If it is NOT truly finished, keep it open (in_progress or blocked) — do not fake done.`,
    `End with exactly these two lines:`,
    `TASK_STATE: <pending|in_progress|blocked|done>`,
    `DELIVERED: <yes|no>`,
  ].join("\n");
}

function parseDelivered(text) {
  const m = String(text).match(/DELIVERED:\s*(yes|no)/i);
  if (!m) return null;
  return m[1].toLowerCase() === "yes";
}

function progressPingPrompt(template, role, boardMessage, lastState, pingCount, profileId) {
  return [
    `You are the ${role.title}.`,
    orgLine(template, role),
    `You are running as Hermes profile: ${profileId || role.hermesProfile || "default"}.`,
    `PROGRESS PING #${pingCount} — about 1 minute has passed and this task is still not finished.`,
    `Original board request:`,
    boardMessage,
    ``,
    `Last known TASK_STATE: ${lastState || "in_progress"}`,
    `Reply with 2-4 sentences: where is the progress right now? What is blocking? What is next?`,
    `End with exactly: TASK_STATE: <pending|in_progress|blocked|done>`,
  ].join("\n");
}

export function createCommand(ctx) {
  const {
    getTemplate,
    getSettings,
    getAgents,
    getOffice,
    getComms,
    getStats,
    getEdgeEvents,
    getMission,
    deskTile,
    sessionEl,
    usageEl,
    historyEl,
    onBusy,
  } = ctx;

  const chatForm = document.getElementById("chat-form");
  const taskForm = document.getElementById("task-form");
  const chatInput = document.getElementById("chat-input");
  const taskInput = document.getElementById("task-input");
  const taskAssignee = document.getElementById("task-assignee");
  const chatHint = document.getElementById("chat-hint");
  const chatModeBtn = document.getElementById("chat-mode-btn");
  const modeBtns = document.querySelectorAll(".command__mode");
  let busy = false;
  let pingTimer = null;
  /** @type {{ id: string, title: string }[]} */
  let lastPathRoles = [];
  let lastBoardMessage = "";
  let lastBoardReport = "";
  let lastOrchId = null;

  function clearProgressPing() {
    if (pingTimer) {
      clearTimeout(pingTimer);
      pingTimer = null;
    }
    getMission()?.setNextPing?.(null);
  }

  function scheduleProgressPing() {
    clearProgressPing();
    const mission = getMission?.();
    if (!mission?.isOpen?.()) return;
    const at = Date.now() + PROGRESS_PING_MS;
    mission.setNextPing?.(at);
    pingTimer = setTimeout(() => {
      pingTimer = null;
      runProgressPing().catch((err) => {
        console.error("[progress-ping]", err);
        scheduleProgressPing();
      });
    }, PROGRESS_PING_MS);
  }

  function settleMission(state, { held = false } = {}) {
    const mission = getMission?.();
    if (!mission) return;
    if (!held && state === "done") {
      clearProgressPing();
      mission.setDelivered(state);
      return;
    }
    mission.setOpen(state || "in_progress");
    scheduleProgressPing();
  }

  function roleProfileMeta(roleId) {
    const template = getTemplate();
    const settings = getSettings();
    const agents = getAgents();
    const agent = agents?.byId?.(roleId);
    const role = roleById(template, roleId) || agent;
    const profile = profileForRole(template, settings, roleId);
    return {
      id: roleId,
      title: role?.title || agent?.title || roleId,
      hermesProfile: profile,
      provider: agent?.provider || role?.provider || null,
      model: agent?.model || role?.model || null,
    };
  }

  function refreshChatCopy() {
    const template = getTemplate();
    if (!template?.roles?.length) return;
    const orchId = template.orchestratorRoleId || "ceo";
    const orch = roleById(template, orchId);
    const title = orch?.title || orchId;
    const managers = delegateCandidates(template, orchId);
    if (chatModeBtn) chatModeBtn.textContent = `Talk to ${title}`;
    if (chatHint) {
      const mgr = managers.length
        ? managers.map((r) => r.title).join("/")
        : "managers";
      chatHint.innerHTML = `Graph: Board ⇄ <strong>${title}</strong> ⇄ ${mgr} → executor ⇄ order-giver (interval progress) → QC → manager (more work <em>or</em> report up) → ${title} verifies.`;
    }
    if (chatInput) {
      chatInput.placeholder = `Message the ${title} profile…`;
    }
  }

  function refreshAssignee() {
    const template = getTemplate();
    if (!template?.roles?.length || !taskAssignee) return;
    const orch = template.orchestratorRoleId || "ceo";
    taskAssignee.innerHTML = "";
    for (const role of template.roles) {
      const opt = document.createElement("option");
      opt.value = role.id;
      const kind = normalizeRoleKind(role.roleKind, {
        isOrchestrator: role.id === orch,
      });
      const orders = roleTitle(template, normalizeBossId(role.takesOrdersFrom));
      opt.textContent =
        role.id === orch
          ? `${role.title} · orchestrator`
          : `${role.title} · ${kind} ← ${orders}`;
      if (role.id === orch) opt.selected = true;
      taskAssignee.appendChild(opt);
    }
    refreshChatCopy();
  }

  refreshAssignee();

  modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      modeBtns.forEach((b) => {
        const on = b.dataset.mode === mode;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      if (chatForm) chatForm.hidden = mode !== "chat";
      if (taskForm) taskForm.hidden = mode !== "task";
      if (mode === "chat") chatInput?.focus();
      else taskInput?.focus();
    });
  });

  function pushEdge(from, to, text) {
    const record = { from, to, text, _wall: performance.now() };
    getEdgeEvents()?.push(record);
    getComms()?.pushFeed?.({ from, to, text, at: "now" });
  }

  function refreshStats() {
    const stats = getStats();
    stats.renderSession(sessionEl);
    stats.renderUsage(usageEl);
    stats.renderHistory(historyEl);
  }

  function setBusy(v) {
    busy = v;
    if (chatInput) chatInput.disabled = v;
    if (taskInput) taskInput.disabled = v;
    if (taskAssignee) taskAssignee.disabled = v;
    onBusy?.(v);
  }

  function recordFromResult(roleId, prompt, result, { isTask = false, ok = true } = {}) {
    const stats = getStats();
    stats.recordCall(roleId, {
      prompt,
      reply: result?.reply || "",
      isTask,
      ok,
      error: result?.error || null,
      usage: result?.usage ?? null,
      profile: result?.profile || null,
      latencyMs: result?.clientLatencyMs ?? result?.latencyMs ?? null,
      clientLatencyMs: result?.clientLatencyMs ?? null,
      bridgeLatencyMs: result?.bridgeLatencyMs ?? result?.latencyMs ?? null,
      httpStatus: result?.httpStatus ?? null,
      requestHeaders: result?.requestHeaders ?? null,
      responseHeaders: result?.responseHeaders ?? null,
      stderr: result?.stderr || "",
      cmd: result?.cmd ?? null,
      returncode: result?.returncode ?? null,
      raw: result ?? null,
    });
    refreshStats();
  }

  async function runRole(roleId, prompt, { isTask = false } = {}) {
    const template = getTemplate();
    const settings = getSettings();
    const agents = getAgents();
    const profile = profileForRole(template, settings, roleId);
    agents.setStatus(roleId, "working");
    try {
      const result = await runHermes({ profile, prompt });
      const reply = result.reply || "";
      agents.say(roleId, reply.slice(0, 140));
      recordFromResult(roleId, prompt, result, { isTask, ok: true });
      return { ...result, profile };
    } catch (err) {
      const data = err.data || {
        ok: false,
        error: err.message,
        reply: "",
        profile,
        prompt,
      };
      recordFromResult(roleId, prompt, data, { isTask, ok: false });
      throw err;
    }
  }

  async function runOrgChain({ startId, boardMessage, fromBoard = true }) {
    const template = getTemplate();
    const agents = getAgents();
    const office = getOffice();
    const mission = getMission?.();
    const boardOrigin = fromBoard;
    const startRole = roleById(template, startId) || agents.byId(startId);

    clearProgressPing();
    lastBoardMessage = boardMessage;
    lastPathRoles = [roleProfileMeta(startId)];

    mission?.start({
      title: boardMessage,
      startId,
      steps: lastPathRoles,
    });

    /** @type {{ id: string, reply: string, state: string }[]} */
    const path = [];

    function ensurePathRole(roleId) {
      const meta = roleProfileMeta(roleId);
      mission?.ensureStep(meta);
      if (!lastPathRoles.some((r) => r.id === roleId)) {
        lastPathRoles.push(meta);
      }
      return meta;
    }

    function liveOffice() {
      return getOffice?.() || office;
    }

    function homeTile(roleOrAgent) {
      if (!roleOrAgent) return null;
      const desk = deskTile(roleOrAgent.desk);
      if (desk) return desk;
      const home = roleOrAgent.home;
      return Array.isArray(home) ? home : null;
    }

    function walkToward(fromId, toId, note) {
      const to = agents.byId(toId) || roleById(template, toId);
      if (!to) return;
      ensurePathRole(toId);
      const dest = homeTile(to);
      if (dest) agents.walkTo(fromId, dest, liveOffice());
      pushEdge(fromId, toId, note || `→ ${to.title}`);
    }

    function walkHome(id) {
      const who = agents.byId(id) || roleById(template, id);
      const dest = homeTile(who);
      if (dest) agents.walkTo(id, dest, liveOffice());
    }

    /** Wait until agent path is empty (arrived) or timeout */
    function waitForArrival(id, timeoutMs = 14000) {
      return new Promise((resolve) => {
        const t0 = performance.now();
        // Let walkTo assign the path before the first empty-path check
        let seen = false;
        const tick = () => {
          const a = agents.byId(id);
          if (!a) return resolve();
          if (a.path?.length) seen = true;
          if (seen && !a.path.length) return resolve();
          if (!seen && performance.now() - t0 > 120) return resolve();
          if (performance.now() - t0 > timeoutMs) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }

    /** Walk home and wait. working=true when about to do their Hermes turn. */
    async function goToOwnDesk(id, { working = true } = {}) {
      walkHome(id);
      await waitForArrival(id);
      agents.setStatus(id, working ? "working" : "idle");
    }

    /**
     * Strict handoff sequence:
     * 1) agent 2 is at their own desk (waiting)
     * 2) agent 1 walks to agent 2
     * 3) agent 1 returns home
     * 4) only then does the caller continue → agent 2 starts their task
     */
    async function handoffAndReturn(fromId, toId, note) {
      // Receiver waits at their desk — not working yet
      await goToOwnDesk(toId, { working: false });
      walkToward(fromId, toId, note);
      await waitForArrival(fromId);
      walkHome(fromId);
      await waitForArrival(fromId);
      agents.setStatus(fromId, "idle");
    }

    async function sendEveryoneHome() {
      const o = liveOffice();
      const ids = new Set(path.map((s) => s.id));
      ids.add(startId);
      for (const id of ids) {
        const who = agents.byId(id) || roleById(template, id);
        const dest = homeTile(who);
        if (dest) agents.walkTo(id, dest, o);
      }
      await Promise.all([...ids].map((id) => waitForArrival(id)));
    }

    let currentId = startId;
    let priorRole = null;
    let brief = boardMessage;
    let handedFromBoard = fromBoard;
    let afterEval = false;
    let rolledState = "in_progress";
    let rolledReply = "";
    let held = false;
    let reachedOrchestratorUp = false;

    // Graph walk: orch → manager ⇄ (executor → evaluator → manager) → orch
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const currentRole =
        roleById(template, currentId) || agents.byId(currentId);
      if (!currentRole) break;

      const kind = normalizeRoleKind(currentRole.roleKind, {
        isOrchestrator: currentId === template.orchestratorRoleId,
      });
      ensurePathRole(currentId);
      mission?.setActive(
        currentId,
        hop === 0 ? "intake" : kind === "evaluator" ? "evaluate" : "graph"
      );

      // Always work from your own desk before speaking / deciding
      await goToOwnDesk(currentId);

      // —— Orchestrator (start): pick a manager ——
      if (kind === "orchestrator" && !reachedOrchestratorUp) {
        const candidates = delegateCandidates(template, currentId);
        const prompt = candidates.length
          ? orchestratorChoosePrompt(template, currentRole, brief, candidates, {
              fromBoard: handedFromBoard,
            })
          : leafWorkPrompt(template, currentRole, brief, {
              fromBoard: handedFromBoard,
              fromRole: priorRole,
            });
        const { reply } = await runRole(currentId, prompt, { isTask: true });
        const state = parseTaskState(reply, "pending");
        pushEdge(
          currentId,
          hop === 0 && boardOrigin ? "you" : priorRole?.id || "you",
          `[${state}] ${reply}`
        );
        path.push({ id: currentId, reply, state });
        rolledState = state;
        rolledReply = reply;
        mission?.markStep(currentId, {
          status: "done",
          taskState: state,
          note: reply.slice(0, 160),
        });

        const action = candidates.length
          ? parseChainAction(
              reply,
              candidates.map((r) => r.id)
            )
          : { type: "done", id: null };
        agents.setStatus(currentId, "idle");
        if (action.type !== "delegate" || !action.id) break;

        await handoffAndReturn(
          currentId,
          action.id,
          `Talking to → ${roleTitle(template, action.id)}`
        );
        brief = [
          `Original board request:\n${boardMessage}`,
          ``,
          `${currentRole.title} decided to involve ${roleTitle(template, action.id)}.`,
          `${currentRole.title} said:\n${reply}`,
        ].join("\n");
        priorRole = currentRole;
        handedFromBoard = false;
        afterEval = false;
        currentId = action.id;
        continue;
      }

      // —— Manager: DELEGATE executor OR REPORT_UP orchestrator ——
      if (kind === "manager") {
        const executors = delegateCandidates(template, currentId);
        const upTarget = reportUpTarget(template, currentId);
        const prompt = managerDecidePrompt(
          template,
          currentRole,
          brief,
          executors,
          upTarget,
          {
            fromBoard: handedFromBoard,
            fromRole: priorRole,
            afterEval,
          }
        );
        const { reply } = await runRole(currentId, prompt, { isTask: true });
        const state = parseTaskState(reply, "in_progress");
        pushEdge(
          currentId,
          priorRole?.id || upTarget?.id || "you",
          `[${state}] ${reply}`
        );
        path.push({ id: currentId, reply, state });
        rolledState = state;
        rolledReply = reply;

        const action = parseManagerGraphAction(
          reply,
          executors.map((r) => r.id)
        );

        if (action.type === "hold") {
          held = true;
          mission?.markStep(currentId, {
            status: "hold",
            taskState: state,
            note: "HOLD — stay at manager",
          });
          pushEdge(
            currentId,
            upTarget?.id || "you",
            `HOLD [${state}] — not reporting up`
          );
          agents.setStatus(currentId, "idle");
          break;
        }

        if (action.type === "delegate" && action.id) {
          mission?.markStep(currentId, {
            status: "done",
            taskState: state,
            note: `DELEGATE → ${action.id}`,
          });
          await handoffAndReturn(
            currentId,
            action.id,
            `Assign → ${roleTitle(template, action.id)}`
          );
          brief = [
            `Original board request:\n${boardMessage}`,
            ``,
            `${currentRole.title} assigned work to ${roleTitle(template, action.id)}.`,
            `${currentRole.title} said:\n${reply}`,
          ].join("\n");
          priorRole = currentRole;
          handedFromBoard = false;
          afterEval = false;
          agents.setStatus(currentId, "idle");
          currentId = action.id;
          continue;
        }

        // REPORT_UP → orchestrator
        const upId = upTarget?.id;
        mission?.markStep(currentId, {
          status: "reported",
          taskState: action.state || state,
          note: `REPORT_UP ${action.state || state}`,
        });
        rolledState = action.state || state;
        if (!upId) {
          agents.setStatus(currentId, "idle");
          walkHome(currentId);
          reachedOrchestratorUp = true;
          break;
        }
        await handoffAndReturn(
          currentId,
          upId,
          `REPORT_UP [${rolledState}] → ${roleTitle(template, upId)}`
        );
        brief = [
          `Original board request:\n${boardMessage}`,
          ``,
          `${currentRole.title} reported up.`,
          `TASK_STATE: ${rolledState}`,
          `${currentRole.title} said:\n${reply}`,
        ].join("\n");
        priorRole = currentRole;
        afterEval = false;
        agents.setStatus(currentId, "idle");
        currentId = upId;
        reachedOrchestratorUp = true;
        continue;
      }

      // —— Executor: work → report to order-giver → (maybe more) → QC ——
      if (kind === "executor") {
        const orderGiver = orderGiverForExecutor(template, currentId);
        const orderGiverId = orderGiver?.id || null;
        const orderGiverTitle = orderGiver?.title || "manager";
        let state = "in_progress";
        let reply = "";
        const progressNotes = [];
        const maxRounds = 1 + EXECUTOR_EXTRA_PROGRESS;

        for (let round = 1; round <= maxRounds; round++) {
          await goToOwnDesk(currentId);
          agents.say(currentId, `Working (r${round})…`, 4000);
          const prompt = leafWorkPrompt(template, currentRole, brief, {
            fromBoard: handedFromBoard,
            fromRole: priorRole,
            round,
          });
          const result = await runRole(currentId, prompt, { isTask: true });
          reply = result.reply;
          state = parseTaskState(reply, "in_progress");
          progressNotes.push(`[r${round} · ${state}] ${reply}`);
          pushEdge(
            currentId,
            orderGiverId || priorRole?.id || "you",
            `[${state}] ${reply}`
          );
          path.push({ id: currentId, reply, state });
          rolledState = state;
          rolledReply = reply;
          mission?.markStep(currentId, {
            status: state === "done" ? "done" : "active",
            taskState: state,
            note: reply.slice(0, 160),
          });
          agents.setStatus(currentId, "idle");

          // Executor property: always report to who gave the order
          if (orderGiverId) {
            agents.say(
              currentId,
              `Progress → ${orderGiverTitle}`,
              2500
            );
            await handoffAndReturn(
              currentId,
              orderGiverId,
              `Progress → ${orderGiverTitle}`
            );
          }

          if (state === "done" || state === "blocked" || round >= maxRounds) {
            break;
          }
          brief = [
            `Original board request:\n${boardMessage}`,
            ``,
            `You already reported to ${orderGiverTitle}. Keep working.`,
            `Last update:\n${reply}`,
            `TASK_STATE: ${state}`,
          ].join("\n");
          handedFromBoard = false;
        }

        const evaluator = evaluatorForExecutor(template, currentId);
        if (!evaluator) {
          if (!orderGiverId) break;
          brief = [
            `Original board request:\n${boardMessage}`,
            ``,
            `Executor ${currentRole.title} finished (no evaluator).`,
            `TASK_STATE: ${state}`,
            `Progress trail:\n${progressNotes.join("\n")}`,
          ].join("\n");
          priorRole = currentRole;
          afterEval = false;
          currentId = orderGiverId;
          continue;
        }

        await handoffAndReturn(
          currentId,
          evaluator.id,
          `QC handoff → ${evaluator.title}`
        );
        brief = [
          `Original board request:\n${boardMessage}`,
          ``,
          `Executor ${currentRole.title} finished — send to QC.`,
          `TASK_STATE: ${state}`,
          `Progress trail:\n${progressNotes.join("\n")}`,
        ].join("\n");
        priorRole = currentRole;
        handedFromBoard = false;
        afterEval = false;
        currentId = evaluator.id;
        continue;
      }

      // —— Evaluator: validate, forced edge → manager ——
      if (kind === "evaluator") {
        const execRole = priorRole;
        const execEntry = [...path].reverse().find((p) => {
          const r = roleById(template, p.id);
          return normalizeRoleKind(r?.roleKind) === "executor";
        });
        const prompt = evaluatorValidatePrompt(
          template,
          currentRole,
          boardMessage,
          execRole || { title: "Executor" },
          execEntry?.reply || brief,
          execEntry?.state || rolledState
        );
        const { reply } = await runRole(currentId, prompt, { isTask: true });
        const state = parseTaskState(reply, rolledState);
        const managerId =
          normalizeBossId(currentRole.reportsTo) ||
          normalizeBossId(currentRole.takesOrdersFrom);
        pushEdge(currentId, managerId || "you", `[${state}] ${reply}`);
        path.push({ id: currentId, reply, state });
        rolledState = state;
        rolledReply = reply;
        mission?.markStep(currentId, {
          status: "done",
          taskState: state,
          note: reply.slice(0, 160),
        });
        agents.setStatus(currentId, "idle");

        if (!managerId) break;
        await handoffAndReturn(
          currentId,
          managerId,
          `QC → ${roleTitle(template, managerId)}`
        );
        brief = [
          `Original board request:\n${boardMessage}`,
          ``,
          `Evaluator ${currentRole.title} validated work.`,
          `TASK_STATE: ${state}`,
          `${currentRole.title} said:\n${reply}`,
        ].join("\n");
        priorRole = currentRole;
        afterEval = true;
        currentId = managerId;
        continue;
      }

      // —— Orchestrator after REPORT_UP: intake, then verify ——
      if (kind === "orchestrator" && reachedOrchestratorUp) {
        const prompt = orchestratorIntakeFromManagerPrompt(
          template,
          currentRole,
          boardMessage,
          priorRole || { title: "Manager" },
          rolledReply || brief,
          rolledState
        );
        const { reply } = await runRole(currentId, prompt, { isTask: true });
        const state = parseTaskState(reply, rolledState);
        pushEdge(currentId, "you", `[${state}] ${reply}`);
        path.push({ id: currentId, reply, state });
        rolledState = state;
        rolledReply = reply;
        mission?.markStep(currentId, {
          status: "reported",
          taskState: state,
          note: reply.slice(0, 160),
        });
        agents.setStatus(currentId, "idle");
        break;
      }

      break;
    }

    if (held) {
      mission?.markStep(path[0]?.id || startId, {
        status: "hold",
        taskState: rolledState,
      });
    }

    // Board target always verifies + reports to the board (unless HOLD stopped the chain)
    let deliveredOk = false;
    if (boardOrigin && !held) {
      const topRole = roleById(template, startId) || agents.byId(startId);
      if (topRole) {
        const meta = roleProfileMeta(startId);
        mission?.ensureStep(meta);
        mission?.setActive(startId, "verify");
        pushEdge(startId, "you", `CEO verifying & preparing board report…`);
        const { reply } = await runRole(
          startId,
          ceoVerifyDeliverPrompt(
            template,
            { ...topRole, ...meta },
            boardMessage,
            rolledState,
            path,
            meta.hermesProfile
          ),
          { isTask: true }
        );
        const state = parseTaskState(reply, rolledState);
        const wantsDeliver = parseDelivered(reply);
        rolledState = state;
        rolledReply = reply;
        // Require explicit DELIVERED: yes after verification
        deliveredOk = state === "done" && wantsDeliver === true;

        pushEdge(
          startId,
          "you",
          `[${state}${deliveredOk ? " · DELIVERED" : " · NOT DELIVERED"}] ${reply}`
        );
        mission?.markStep(startId, {
          status: deliveredOk ? "reported" : "active",
          taskState: state,
          note: deliveredOk ? "Verified board report" : "Verification — still open",
        });
        agents.setStatus(startId, "idle");
      }
    }

    // Everyone walks back to their own desk
    await sendEveryoneHome();

    lastOrchId = startId;
    lastBoardReport = rolledReply || lastBoardMessage;

    // Auto green check bubble on CEO — no need to click the avatar first
    if (boardOrigin) {
      const label = deliveredOk
        ? "Task done — check & reply to board"
        : "Task update — check & reply to board";
      agents.saySticky?.(startId, label, "board-reply", "check");
      walkHome(startId);
    }

    if (deliveredOk) {
      clearProgressPing();
      getMission?.()?.setDelivered(rolledState);
    } else {
      settleMission(rolledState || path[path.length - 1]?.state || "in_progress", {
        held,
      });
    }
  }

  function getBoardReplyContext() {
    return {
      orchId: lastOrchId || getTemplate()?.orchestratorRoleId,
      report: lastBoardReport || "",
      boardMessage: lastBoardMessage || "",
    };
  }

  async function sendBoardReply(text) {
    const msg = String(text || "").trim();
    if (!msg || busy) return null;
    const template = getTemplate();
    const orchId =
      lastOrchId || template?.orchestratorRoleId || "ceo";
    const agents = getAgents();
    agents.clearBubble?.(orchId);
    pushEdge("you", orchId, `Board reply: ${msg}`);
    setBusy(true);
    try {
      await runOrgChain({
        startId: orchId,
        boardMessage: [
          lastBoardMessage
            ? `Previous board request:\n${lastBoardMessage}\n`
            : "",
          lastBoardReport
            ? `CEO’s last report to the board:\n${lastBoardReport}\n`
            : "",
          `Board reply / next order:\n${msg}`,
        ]
          .filter(Boolean)
          .join("\n"),
        fromBoard: true,
      });
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function runProgressPing() {
    const mission = getMission?.();
    const m = mission?.getState?.();
    if (!m || !mission?.isOpen?.()) {
      clearProgressPing();
      return;
    }
    if (busy) {
      scheduleProgressPing();
      return;
    }

    const template = getTemplate();
    const agents = getAgents();
    const targets = [];
    // Prefer last person on the path who isn't done; also ping board target
    for (let i = lastPathRoles.length - 1; i >= 0; i--) {
      const r = lastPathRoles[i];
      const step = m.steps.find((s) => s.id === r.id);
      if (step?.taskState === "done") continue;
      targets.push(r);
      if (targets.length >= 2) break;
    }
    if (!targets.length && lastPathRoles.length) {
      targets.push(lastPathRoles[lastPathRoles.length - 1]);
    }

    mission.setPinging?.(true);
    setBusy(true);
    pushEdge("system", "you", `Progress ping — checking unfinished work…`);

    let latest = m.taskState || "in_progress";
    const pingPath = lastPathRoles.map((r) => ({
      id: r.id,
      state: m.steps.find((s) => s.id === r.id)?.taskState || latest,
      reply: m.steps.find((s) => s.id === r.id)?.note || "",
    }));
    try {
      for (const t of targets) {
        const role = roleById(template, t.id) || agents.byId(t.id);
        if (!role) continue;
        const meta = roleProfileMeta(t.id);
        mission.ensureStep(meta);
        mission.setActive(t.id, "ping");
        pushEdge(
          "system",
          t.id,
          `Ping → Hermes profile · ${meta.hermesProfile}`
        );
        const { reply } = await runRole(
          t.id,
          progressPingPrompt(
            template,
            { ...role, ...meta },
            lastBoardMessage || m.title,
            latest,
            (m.pingCount || 0) + 1,
            meta.hermesProfile
          ),
          { isTask: true }
        );
        const state = parseTaskState(reply, latest);
        latest = state;
        mission.markStep(t.id, {
          status: state === "done" ? "done" : "active",
          taskState: state,
          note: `ping: ${reply.slice(0, 120)}`,
        });
        const reportTo = normalizeBossId(role.reportsTo) || "you";
        pushEdge(t.id, reportTo, `[ping · ${state}] ${reply}`);
        agents.setStatus(t.id, "idle");
        const step = pingPath.find((p) => p.id === t.id);
        if (step) {
          step.state = state;
          step.reply = reply;
        } else {
          pingPath.push({ id: t.id, state, reply });
        }
        if (state === "done") break;
      }

      // If agents claim done, CEO must verify and send the board report
      if (latest === "done") {
        const orch =
          getTemplate()?.orchestratorRoleId || lastPathRoles[0]?.id;
        if (orch) {
          const topRole = roleById(template, orch) || agents.byId(orch);
          const meta = roleProfileMeta(orch);
          mission.ensureStep(meta);
          mission.setActive(orch, "verify");
          pushEdge(orch, "you", `CEO verifying & preparing board report…`);
          const { reply } = await runRole(
            orch,
            ceoVerifyDeliverPrompt(
              template,
              { ...topRole, ...meta },
              lastBoardMessage || m.title,
              latest,
              pingPath,
              meta.hermesProfile
            ),
            { isTask: true }
          );
          const state = parseTaskState(reply, latest);
          const wantsDeliver = parseDelivered(reply);
          latest = state;
          const deliveredOk = state === "done" && wantsDeliver === true;
          pushEdge(
            orch,
            "you",
            `[${state}${deliveredOk ? " · DELIVERED" : " · NOT DELIVERED"}] ${reply}`
          );
          mission.markStep(orch, {
            status: deliveredOk ? "reported" : "active",
            taskState: state,
            note: deliveredOk
              ? "Verified board report"
              : "Verification — still open",
          });
          agents.setStatus(orch, "idle");
          if (deliveredOk) {
            clearProgressPing();
            mission.setDelivered(state);
            return;
          }
        }
      }
    } finally {
      mission.setPinging?.(false);
      setBusy(false);
    }

    settleMission(latest);
  }

  chatForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const text = chatInput?.value.trim();
    if (!text) return;
    chatInput.value = "";

    const template = getTemplate();
    if (!template?.roles?.length) {
      pushEdge("system", "you", "Factory not loaded yet — refresh the page.");
      return;
    }
    const orch = template.orchestratorRoleId || "ceo";

    pushEdge("you", orch, text);
    setBusy(true);
    try {
      await runOrgChain({
        startId: orch,
        boardMessage: text,
        fromBoard: true,
      });
    } catch (err) {
      const msg = err.message || String(err);
      pushEdge(orch, "you", `Hermes error: ${msg}`);
      getAgents()?.setStatus(orch, "blocked");
      getAgents()?.say(orch, "blocked");
    } finally {
      setBusy(false);
    }
  });

  taskForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const text = taskInput?.value.trim();
    const assigneeId = taskAssignee?.value;
    if (!text || !assigneeId) return;
    taskInput.value = "";

    const agents = getAgents();
    const office = getOffice();
    if (!agents || !templateReady()) {
      pushEdge("system", "you", "Factory not loaded yet — refresh the page.");
      return;
    }
    const assignee = agents.byId(assigneeId);
    if (!assignee) return;

    pushEdge("you", assigneeId, `TASK: ${text}`);
    const dest = deskTile(assignee.desk) || assignee.home;
    if (dest) agents.walkTo(assigneeId, dest, getOffice?.() || office);

    setBusy(true);
    try {
      await runOrgChain({
        startId: assigneeId,
        boardMessage: text,
        fromBoard: true,
      });
    } catch (err) {
      const msg = err.message || String(err);
      pushEdge(assigneeId, "you", `Hermes error: ${msg}`);
      agents.setStatus(assigneeId, "blocked");
    } finally {
      setBusy(false);
    }
  });

  function templateReady() {
    return Boolean(getTemplate()?.roles?.length);
  }

  return {
    refreshStats,
    refreshAssignee,
    setBusy,
    isBusy: () => busy,
    getBoardReplyContext,
    sendBoardReply,
  };
}
