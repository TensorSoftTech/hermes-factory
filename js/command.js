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

import { runHermes, profileForRole } from "./hermes.js?v=enforce-settings-1";
import { appendDelivered } from "./persist.js?v=state-history-1";
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
/** Orchestrator + manager recovery ping interval (1–2 min). */
const PROGRESS_PING_MS = 90_000;
/** Extra work cycles before the CTO report. QA follows that report — the model must not postpone QC. */
const EXECUTOR_EXTRA_PROGRESS = 0;

function candidateLine(role) {
  const desc = String(role?.description || "")
    .replace(/\s+/g, " ")
    .trim();
  const short = desc.length > 160 ? `${desc.slice(0, 157)}…` : desc;
  return short
    ? `${role.title} (${role.id}) — ${short}`
    : `${role.title} (${role.id})`;
}

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
    ? `You do not decide when QC happens. After this reply you report to ${orderGiverTitle}. The factory then sends the work to ${evaluator.title}. Do not say you will hand to QA later. Set TASK_STATE: done if the work exists, even if it is not smoke-tested yet. QA does that check.`
    : `When finished set TASK_STATE: done.`;
  return [
    `You are the ${role.title} in a software company agent factory.`,
    orgLine(template, role),
    role.description ? `Your job: ${role.description}` : "",
    `You are an executor — you own the hands-on work.`,
    `Cleanup is part of the task. If you started a server, listener, watcher, or other process, stop it. Then double-check it is gone. Say what you stopped, or that nothing was running.`,
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
  const titles = candidates.map((r) => candidateLine(r)).join("\n  ");
  const ids = candidates.map((r) => r.id).join(", ");
  return [
    `You are the ${role.title}, the orchestrator.`,
    orgLine(template, role),
    fromBoard ? "The board just messaged you." : "You need to route this work.",
    `You talk to managers. Pick who handles this next, or own a quick reply yourself.`,
    `Managers:\n  ${titles}`,
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
  { fromBoard = false, fromRole = null, afterEval = false, split = false } = {}
) {
  const titles = executors.map((r) => candidateLine(r)).join("\n  ");
  const ids = executors.map((r) => r.id).join(", ");
  const upTitle = upTarget?.title || "orchestrator";
  const source = afterEval
    ? `${fromRole?.title || "Evaluator"} just returned QC results to you.`
    : fromBoard
      ? "The board (via orchestrator) just messaged you."
      : fromRole
        ? `${fromRole.title} just handed you this.`
        : "You were handed this work.";
  const multi = split
    ? [
        `You own the factory kanban. The board request becomes ONE main card that YOU own, then smaller subtasks for TEMPLATE POSITIONS (executors below).`,
        `You alone decide which position does what. The factory will run each position's Hermes profile from Settings (local AI) — do NOT create Hermes Agent kanban cards / t_* tasks (those use default/Nous and 402). Do NOT assign role ids (swe, architect) as Hermes profiles.`,
        `Dependencies (AFTER) sequence work: when one position finishes, dependents start.`,
        `People can help outside a strict title when useful. The same position may own more than one subtask.`,
      ].join(" ")
    : executors.length > 1
      ? `You have ${executors.length} executors — pick the best one for this work (use their role_id exactly).`
      : "";
  return [
    `You are the ${role.title}, a manager node in the org graph.`,
    orgLine(template, role),
    source,
    `Your edges: send work to an executor, OR report up to ${upTitle} (orchestrator).`,
    `Executors go to QC/QA automatically — you do not talk to evaluators directly.`,
    `Cleanup: if this work left a running process, you stop it and you make the engineers stop theirs. Double-check before you report up.`,
    executors.length
      ? `Valid executors:\n  ${titles}`
      : `No executors available — report up or HOLD.`,
    multi,
    `Reply briefly (2-4 sentences) with your decision and task view.`,
    split
      ? [
          `Then end with exactly this shape:`,
          `  MAIN: <where/how the board request will be completed — one line>`,
          `  TASK: <role_id> | <short subtask>`,
          `  TASK: <role_id> | <short subtask> | AFTER: <n>`,
          `  TASK: <role_id> | <short subtask> | AFTER: <n>,<m>`,
          `AFTER uses 1-based TASK line numbers (or a prior role_id). Omit AFTER when the task can start immediately.`,
          `Valid role_ids: ${ids}`,
          `Also include: TASK_STATE: in_progress`,
        ].join("\n")
      : `Then end with exactly one of:`,
    !split && executors.length
      ? `  DELEGATE: <role_id>   — assign one executor (valid: ${ids})`
      : !split
        ? `  (no DELEGATE options)`
        : "",
    !split
      ? `  REPORT_UP: <pending|in_progress|blocked|done>  — escalate to ${upTitle}`
      : "",
    !split ? `  HOLD  — stay here; do not report up yet` : "",
    !split
      ? `Also include: TASK_STATE: <pending|in_progress|blocked|done>`
      : "",
    ``,
    `Context:`,
    brief,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Parse CTO MAIN + TASK / AFTER plan from a Hermes reply. */
function parseManagerPlan(text, executorIds) {
  const mainMatch = String(text).match(/MAIN:\s*(.+)/i);
  const mainTitle = mainMatch
    ? mainMatch[1].split("\n")[0].trim().slice(0, 180)
    : null;
  const tasks = [];
  const re =
    /TASK:\s*([a-z0-9_-]+)\s*\|\s*([^|\n]+?)(?:\|\s*AFTER:\s*([^\n]+))?$/gim;
  let m;
  while ((m = re.exec(String(text)))) {
    const id = m[1].toLowerCase();
    if (!executorIds.includes(id)) continue;
    const title = m[2].trim().slice(0, 140);
    if (!title) continue;
    const afterRaw = (m[3] || "")
      .split(/[,+\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    tasks.push({
      assigneeId: id,
      title,
      dependsOn: afterRaw,
      index: tasks.length + 1,
    });
  }
  const action = parseManagerGraphAction(text, executorIds);
  return { mainTitle, tasks, action };
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
    role.description ? `Your job: ${role.description}` : "",
    `Check all of these before you pass the work:`,
    `1. Documentation — README or equivalent says how to run it and what changed.`,
    `2. Data sources — every feed, API, file, or market the code uses is named.`,
    `3. Code quality — structure is clear, errors are handled, and it is not a single unverified dump.`,
    `4. It can actually be run — say what you could not verify.`,
    `5. Cleanup — no leftover server, listener, or watcher from this work is still running.`,
    `Fail the item that is missing. Do not pass on the executor's word alone.`,
    `Write 4-8 sentences for ${manager}.`,
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
  const boardDone = rolledState === "done";
  return [
    `You are the ${role.title}, the board contact.`,
    `Hermes profile: ${profileId || role.hermesProfile || "default"}.`,
    orgLine(template, role),
    ``,
    `Your org rolled up TASK_STATE: ${rolledState}.`,
    boardDone
      ? `Factory kanban shows ALL subtasks done — you must close this out to the board now.`
      : ``,
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
    boardDone
      ? `The factory board is finished. End with TASK_STATE: done and DELIVERED: yes unless a critical gap remains.`
      : `If it is NOT truly finished, keep it open (in_progress or blocked) — do not fake done.`,
    `End with exactly these two lines:`,
    `TASK_STATE: <pending|in_progress|blocked|done>`,
    `DELIVERED: <yes|no>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function parseDelivered(text) {
  const m = String(text).match(/DELIVERED:\s*(yes|no)/i);
  if (!m) return null;
  return m[1].toLowerCase() === "yes";
}

function progressPingPrompt(
  template,
  role,
  boardMessage,
  lastState,
  pingCount,
  profileId,
  { kind = "manager", kanbanSummary = "", reason = "ping", hasKanban = false } = {}
) {
  const asManager = kind === "manager";
  const restart = reason === "resume" || reason === "restart";
  return [
    `You are the ${role.title}.`,
    orgLine(template, role),
    `You are running as Hermes profile: ${profileId || role.hermesProfile || "default"}.`,
    asManager && hasKanban
      ? [
          restart
            ? `Restart / recovery. You are at YOUR factory kanban. Open cards are listed by TEMPLATE POSITION below.`
            : `Recovery ping (~90s). You are at YOUR factory kanban. Open cards are listed by TEMPLATE POSITION below.`,
          `Workers are template positions (Software Engineer, Architect, …) — not Hermes t_* ids and not bare profile names.`,
          `You OWN this factory board: move cards, mark working/done, and start ready work.`,
          `For every open subtask: which POSITION owns it, status, dependency, blocker? Who should be working now?`,
          `To move a card end with lines like: CARD: <role_id> | <todo|doing|blocked|review|done>`,
          `Say START to kick every ready (todo, deps met) subtask. Say RETRY to reopen API-failed cards then START them.`,
          `FROZEN / blocked / WAIT_ON_DEP cards cannot be forced to done unless you open the gate: GATE: allow`,
          `Example when stuck: GATE: allow then CARD: swe-2 | done`,
          `AFTER-deps normally stay blocked until upstream is done — GATE: allow is the only override to mark them done.`,
          `FORBIDDEN: creating Hermes Agent kanban cards / t_* tasks / hermes kanban CLI — those hit the default/Nous profile (402 credits). Only this factory board. Never cite t_abc123.`,
        ].join(" ")
      : asManager
        ? `Recovery ping. You have no open factory kanban cards — confirm idle or say which positions should get work.`
        : restart
          ? `Restart / recovery. Check managers and template positions. Report who (by position title) is working. Never cite Hermes t_* task ids.`
          : `Recovery ping (~90s). Check managers and open work by template position. If API failed, say which position to retry.`,
    `Original board request:`,
    boardMessage,
    kanbanSummary ? `\nFactory kanban (by position):\n${kanbanSummary}` : "",
    ``,
    `Last known TASK_STATE: ${lastState || "in_progress"}`,
    `Ping #${pingCount || 1}. Reply 3-6 sentences naming positions (CTO, Software Engineer, …).`,
    `End with exactly: TASK_STATE: <pending|in_progress|blocked|done>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatKanbanPingSummary(kanban, template, managerId) {
  const cards = (kanban?.snapshot?.() || []).filter((c) => c.managerId === managerId);
  if (!cards.length) return "(no cards)";
  return cards
    .slice(0, 12)
    .map((c) => {
      const who = c.assigneeId ? roleTitle(template, c.assigneeId) : "unassigned";
      const deps = (c.dependsOn || []).length
        ? ` deps=${(c.dependsOn || []).length}`
        : "";
      const flag = kanban?.isDepBlocked?.(c) || c.status === "blocked"
        ? " · FROZEN/WAIT_ON_DEP (done needs GATE: allow)"
        : kanban?.isApiFailed?.(c)
          ? " · API_FAILED (done needs GATE: allow)"
          : c.status === "todo"
            ? " · READY"
            : c.status === "doing"
              ? " · WORKING"
              : "";
      return `- [${c.kind || "sub"}·${c.status}] ${c.assigneeId || "?"} ${c.title} → ${who}${deps}${flag}${
        c.note ? ` · ${String(c.note).slice(0, 80)}` : ""
      }`;
    })
    .join("\n");
}

/** True when a card is stuck and force-done needs GATE: allow. */
function isFrozenKanbanCard(kanban, card) {
  if (!card || card.kind === "main" || card.status === "done") return false;
  if (card.status === "blocked") return true;
  if (kanban?.isDepBlocked?.(card)) return true;
  if (kanban?.isApiFailed?.(card)) return true;
  return /waiting on|frozen|stuck|API\/process failed|recovery ping to retry/i.test(
    card.note || ""
  );
}

/** Parse CTO ping board moves: CARD:/STATUS:/MOVE: + START/RETRY + GATE: allow. */
function parseKanbanDirectives(text) {
  const moves = [];
  const re =
    /(?:CARD|STATUS|MOVE):\s*([a-z0-9_-]+)\s*\|\s*(todo|blocked|doing|review|done)\b/gi;
  let m;
  while ((m = re.exec(String(text || "")))) {
    moves.push({ roleId: m[1].toLowerCase(), status: m[2].toLowerCase() });
  }
  return {
    moves,
    retry: /\bRETRY\b/i.test(text || ""),
    start: /\bSTART\b/i.test(text || "") || /\bRETRY\b/i.test(text || ""),
    // Explicit gate — required to force frozen/blocked cards to done
    gateAllow: /\bGATE:\s*allow\b/i.test(text || ""),
  };
}

function applyKanbanDirectives(kanban, managerId, directives, { force = true } = {}) {
  if (!kanban || !managerId || !directives) {
    return { moved: 0, reopened: 0, gated: 0, denied: [] };
  }
  let moved = 0;
  let reopened = 0;
  let gated = 0;
  const denied = [];
  for (const mv of directives.moves || []) {
    const open = (kanban.snapshot?.() || []).filter(
      (c) =>
        c.managerId === managerId &&
        c.kind !== "main" &&
        c.assigneeId === mv.roleId &&
        c.status !== "done"
    );
    for (const card of open) {
      if (mv.status === "done") {
        const frozen = isFrozenKanbanCard(kanban, card);
        if (frozen && !directives.gateAllow) {
          denied.push({
            roleId: mv.roleId,
            title: card.title,
            reason: "frozen — need GATE: allow",
          });
          continue;
        }
        kanban.complete?.(card.id, {
          note: frozen
            ? "Manager GATE: allow → forced done (was frozen)"
            : "Manager marked done on ping",
        });
        if (frozen) gated += 1;
      } else if (force && kanban.setStatus) {
        kanban.setStatus(card.id, mv.status);
        if (mv.status === "doing") {
          kanban.patch?.(card.id, { note: "Manager set working on ping" });
        }
      } else {
        kanban.patch?.(card.id, {
          status: mv.status,
          note: `Manager moved → ${mv.status}`,
          _force: true,
        });
      }
      moved += 1;
    }
  }
  if (directives.retry) {
    for (const card of kanban.snapshot?.() || []) {
      if (card.managerId !== managerId || card.kind === "main") continue;
      // Dep waits stay blocked unless CTO also CARD-moved them above
      if (kanban.isDepBlocked?.(card)) continue;
      if (card.status === "blocked") {
        kanban.patch?.(card.id, {
          status: "todo",
          note: "Manager retry after kanban check",
          _force: true,
        });
        reopened += 1;
      }
    }
  }
  kanban.refreshBlocked?.(managerId);
  return { moved, reopened, gated, denied };
}

/** Progress must name template positions — never Hermes t_* worker ids. */
function formatPositionWorkSummary(kanban, template) {
  const cards = (kanban?.snapshot?.() || []).filter(
    (c) => c.kind !== "main" && c.status !== "done"
  );
  if (!cards.length) return "(no open template subtasks)";
  return cards
    .slice(0, 16)
    .map((c) => {
      const pos = c.assigneeId
        ? roleTitle(template, c.assigneeId)
        : "Unassigned position";
      return `- ${pos} · ${c.status} · ${c.title}`;
    })
    .join("\n");
}

export function createCommand(ctx) {
  const {
    getTemplate,
    getSettings,
    getProfiles,
    getAgents,
    getOffice,
    getComms,
    getStats,
    getEdgeEvents,
    getMission,
    getKanban,
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
  let floorSyncTimer = null;
  /** @type {{ id: string, title: string }[]} */
  let lastPathRoles = [];
  let lastBoardMessage = "";
  let lastBoardReport = "";
  let lastOrchId = null;
  /** Bumped to abandon an in-flight org chain / Hermes call. */
  let runId = 0;
  /** @type {AbortController | null} org-chain only — pings must never touch this */
  let chainAbort = null;
  /** @type {AbortController | null} recovery ping only */
  let pingAbort = null;
  /** Role ids currently driven by an in-flight factory Hermes call. */
  const liveApiRoles = new Set();

  function isServerOrch() {
    return (getSettings()?.orchestration || "server") !== "client";
  }

  async function postMission(message) {
    const res = await fetch("/api/missions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || data.detail || `mission HTTP ${res.status}`);
    }
    return data;
  }

  /** Apply a server WebSocket event to local UI mirrors. */
  function applyServerEvent(msg) {
    if (!msg || typeof msg !== "object") return;
    const { event, payload } = msg;
    if (event === "hello" && payload?.state) {
      if (Array.isArray(payload.state.kanban)) {
        getKanban()?.restore?.(payload.state.kanban);
      }
      if (payload.state.mission) {
        getMission()?.restore?.(payload.state.mission);
      }
      return;
    }
    if (event === "mission" && payload) {
      getMission()?.restore?.(payload);
      return;
    }
    if (event === "kanban" && payload) {
      const cards = payload.cards || payload;
      if (Array.isArray(cards)) getKanban()?.restore?.(cards);
      try {
        syncFloorPositions?.();
      } catch {
        /* ignore */
      }
      return;
    }
    if (event === "feed" && payload) {
      getComms()?.pushFeed?.(payload);
      const edges = getEdgeEvents?.();
      if (Array.isArray(edges)) edges.push(payload);
      return;
    }
    if (event === "agent" && payload?.roleId) {
      const agents = getAgents();
      if (!agents) return;
      if (payload.status) agents.setStatus?.(payload.roleId, payload.status);
      if (payload.status === "working") {
        const a = agents.byId?.(payload.roleId);
        const dest = a ? deskTile?.(a.desk) || a.home : null;
        if (dest) agents.walkTo?.(payload.roleId, dest, getOffice?.());
      }
      return;
    }
    if (event === "busy") {
      setBusy(Boolean(payload?.busy));
      return;
    }
    if (event === "hermes_run" && payload?.roleId) {
      recordFromResult(payload.roleId, payload.prompt || "", payload, {
        isTask: Boolean(payload.isTask),
        ok: payload.ok !== false,
      });
      return;
    }
    if (event === "state" && payload) {
      if (Array.isArray(payload.kanban)) getKanban()?.restore?.(payload.kanban);
      if (payload.mission) getMission()?.restore?.(payload.mission);
      return;
    }
    if (event === "course_changed") {
      getMission()?.clear?.();
      getKanban()?.clearAll?.();
      parkAgentsHome();
      setBusy(false);
    }
  }

  function courseError() {
    return Object.assign(new Error("Board changed course"), {
      code: "COURSE_CHANGED",
      name: "AbortError",
    });
  }

  function isCourseChanged(err) {
    return (
      err?.code === "COURSE_CHANGED" ||
      err?.name === "AbortError"
    );
  }

  function clearProgressPing() {
    if (pingTimer) {
      clearTimeout(pingTimer);
      pingTimer = null;
    }
    getMission()?.setNextPing?.(null);
  }

  function scheduleProgressPing(delayMs = PROGRESS_PING_MS) {
    // Server owns the ping loop when orchestration=server
    if (isServerOrch()) {
      clearProgressPing();
      return;
    }
    clearProgressPing();
    const mission = getMission?.();
    if (!mission?.isOpen?.()) return;
    const wait = Math.max(500, Number(delayMs) || PROGRESS_PING_MS);
    const at = Date.now() + wait;
    mission.setNextPing?.(at);
    pingTimer = setTimeout(() => {
      pingTimer = null;
      runProgressPing().catch((err) => {
        console.error("[progress-ping]", err);
        scheduleProgressPing();
      });
    }, wait);
  }

  function factoryBoardComplete() {
    const cards = (getKanban()?.snapshot?.() || []).filter(
      (c) => c && c.kind !== "main"
    );
    if (!cards.length) return false;
    return cards.every((c) => c.status === "done");
  }

  function settleMission(state, { held = false, report = "" } = {}) {
    const mission = getMission?.();
    if (!mission) return;
    // Never mark delivered without a board report — CEO must DELIVERED: yes
    if (!held && state === "done" && report) {
      clearProgressPing();
      stopFloorSync();
      recordDelivered(report);
      mission.setDelivered(state);
      return;
    }
    if (!held && state === "done" && factoryBoardComplete()) {
      // Cards finished but no report yet — keep open and force CEO delivery next
      mission.setOpen("done");
      startFloorSync();
      scheduleProgressPing(2_000);
      try {
        syncFloorPositions();
      } catch {
        /* ignore */
      }
      return;
    }
    mission.setOpen(state || "in_progress");
    startFloorSync();
    scheduleProgressPing();
    try {
      syncFloorPositions();
    } catch {
      /* ignore */
    }
  }

  /** Persist a delivered task to the server-side history (survives refresh). */
  function recordDelivered(report) {
    const m = getMission?.()?.getState?.();
    if (!m) return;
    const steps = Array.isArray(m.steps) ? m.steps : [];
    const entry = {
      id: m.missionId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      templateId: getTemplate()?.id || null,
      title: m.title || lastBoardMessage || "Task",
      taskState: "done",
      startedAt: m.startedAt || null,
      deliveredAt: Date.now(),
      roles: lastPathRoles.map((r) => {
        const step = steps.find((s) => s.id === r.id);
        return {
          id: r.id,
          title: r.title,
          hermesProfile: r.hermesProfile || step?.hermesProfile || null,
          state: step?.taskState || null,
          note: (step?.note || "").slice(0, 240),
        };
      }),
      report: String(report || lastBoardReport || "").slice(0, 6000),
      boardMessage: String(lastBoardMessage || "").slice(0, 2000),
    };
    appendDelivered(entry)
      .then((ok) => {
        if (ok) window.dispatchEvent(new CustomEvent("hf-history"));
      })
      .catch(() => {});
  }

  /** Everything needed to rebuild command context after a refresh. */
  function getContext() {
    return {
      lastBoardMessage,
      lastBoardReport,
      lastOrchId,
      pathRoles: lastPathRoles.map((r) => ({ ...r })),
    };
  }

  function restoreContext(ctx) {
    if (!ctx || typeof ctx !== "object") return;
    lastBoardMessage = typeof ctx.lastBoardMessage === "string" ? ctx.lastBoardMessage : "";
    lastBoardReport = typeof ctx.lastBoardReport === "string" ? ctx.lastBoardReport : "";
    lastOrchId = ctx.lastOrchId || null;
    if (Array.isArray(ctx.pathRoles)) {
      lastPathRoles = ctx.pathRoles.filter((r) => r && typeof r.id === "string");
    }
  }

  /**
   * Called once after boot restores a mission. The chain loop died with the
   * old page — reopen progress pings (or restore the board-reply bubble).
   */
  function resumeAfterReload() {
    const mission = getMission?.();
    const m = mission?.getState?.();
    if (!m) return;
    // Clear sticky pinging from a prior tab that died mid-call
    mission.setPinging?.(false);
    setBusy(false);
    // Server owns resume / ping after reload
    if (isServerOrch()) {
      try {
        syncFloorPositions();
      } catch {
        /* ignore */
      }
      return;
    }
    if (m.delivered) {
      const orchId = lastOrchId || getTemplate()?.orchestratorRoleId;
      if (orchId && lastBoardReport) {
        getAgents()?.saySticky?.(
          orchId,
          "Delivered — reply to the board",
          "board-reply",
          "check"
        );
      }
      return { resumed: false, delivered: true };
    }
    if (m.paused) {
      return { resumed: false, paused: true, title: m.title || "" };
    }
    try {
      syncFloorPositions();
    } catch {
      /* ignore */
    }
    // Prefer kicking ready desk work over another long ping (unstick freeze)
    const hasReady = (getKanban()?.snapshot?.() || []).some(
      (c) => c.kind !== "main" && c.status === "todo"
    );
    if (hasReady) {
      maybeKickReadyWork();
      scheduleProgressPing();
      return { resumed: true, delivered: false, title: m.title || "", kicked: true };
    }
    // Cards all done but CEO never reported — force a delivery ping soon
    if (factoryBoardComplete() && !m.delivered) {
      scheduleProgressPing(1500);
      return {
        resumed: true,
        delivered: false,
        title: m.title || "",
        needsBoardReport: true,
      };
    }
    const active = m.activeId;
    if (active) getAgents()?.setStatus?.(active, "working");
    // Page died mid-run — managers with open kanban check their boards soon.
    const delay = 1200;
    getMission()?.setNextPing?.(Date.now() + delay);
    setTimeout(() => {
      if (!getMission()?.isOpen?.()) return;
      if (busy) {
        settleMission(m.taskState || "in_progress");
        return;
      }
      runProgressPing({ reason: "resume" }).catch((err) => {
        console.error("[resume]", err);
        settleMission(m.taskState || "in_progress");
      });
    }, delay);
    return { resumed: true, delivered: false, title: m.title || "" };
  }

  /** Walk one agent to a tile and wait (or snap). Used by recovery pings. */
  function waitAgentAt(id, tile, timeoutMs = 12000) {
    return new Promise((resolve) => {
      const agents = getAgents();
      const a0 = agents?.byId?.(id);
      if (!a0 || !tile) return resolve();
      const near = (a) =>
        Math.abs(a.col - tile[0]) <= 0.55 && Math.abs(a.row - tile[1]) <= 0.55;
      if (near(a0) && !a0.path?.length) return resolve();
      const t0 = performance.now();
      let seen = false;
      const tick = () => {
        const a = agents?.byId?.(id);
        if (!a) return resolve();
        if (a.path?.length) seen = true;
        if (near(a) && !a.path?.length) {
          a.col = tile[0];
          a.row = tile[1];
          a.path = [];
          a.progress = 0;
          return resolve();
        }
        if (seen && !a.path?.length) {
          a.col = tile[0];
          a.row = tile[1];
          a.path = [];
          a.progress = 0;
          return resolve();
        }
        if (performance.now() - t0 > timeoutMs) {
          a.col = tile[0];
          a.row = tile[1];
          a.targetCol = tile[0];
          a.targetRow = tile[1];
          a.path = [];
          a.progress = 0;
          return resolve();
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  async function walkManagerToKanban(managerId) {
    const agents = getAgents();
    const office = getOffice?.();
    const tile = office?.kanbanTile?.();
    if (!agents || !tile) return null;
    agents.walkTo(managerId, tile, office);
    await waitAgentAt(managerId, tile);
    agents.setStatus?.(managerId, "reporting");
    return tile;
  }

  async function walkManagerHome(managerId) {
    const agents = getAgents();
    const office = getOffice?.();
    const who = agents?.byId?.(managerId);
    if (!agents || !who) return;
    const dest =
      (who.desk && deskTile?.(who.desk)) ||
      (Array.isArray(who.home) ? who.home : null);
    if (dest) {
      agents.walkTo(managerId, dest, office);
      await waitAgentAt(managerId, dest);
    }
    agents.setStatus?.(managerId, "idle");
  }

  function roleProfileMeta(roleId) {
    const template = getTemplate();
    const settings = getSettings();
    const agents = getAgents();
    const agent = agents?.byId?.(roleId);
    const role = roleById(template, roleId) || agent;
    const profile = profileForRole(
      template,
      settings,
      roleId,
      getProfiles?.() || []
    );
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
      chatHint.innerHTML = `<strong>${title}</strong> meets managers in the office. Each manager alone owns the kanban: one main card, smaller subtasks with dependencies, then everyone works at their desks. Recovery pings every ~90s.`;
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

  /**
   * Floor state = template only.
   * Priority per person: API/doing → ready todo → review → dep-blocked waiting.
   * A ready todo must never be masked by another blocked card (that looked frozen).
   */
  function syncFloorPositions() {
    const template = getTemplate();
    const agents = getAgents();
    const kanban = getKanban();
    if (!template?.roles?.length || !agents?.list) return;
    const roleIds = new Set(template.roles.map((r) => r.id));
    /** @type {Map<string, { doing?: any, ready?: any, review?: any, blocked?: any }>} */
    const byAssignee = new Map();

    for (const c of kanban?.snapshot?.() || []) {
      if (c.kind === "main" || !c.assigneeId || !roleIds.has(c.assigneeId)) continue;
      const bucket = byAssignee.get(c.assigneeId) || {};
      if (c.status === "doing") bucket.doing = c;
      else if (c.status === "review") bucket.review = c;
      else if (c.status === "todo" && !kanban?.isDepBlocked?.(c)) {
        bucket.ready = bucket.ready || c;
      } else if (
        c.status === "blocked" ||
        kanban?.isDepBlocked?.(c) ||
        (c.status === "todo" && /waiting on/i.test(c.note || ""))
      ) {
        bucket.blocked = bucket.blocked || c;
      }
      byAssignee.set(c.assigneeId, bucket);
    }

    const wanted = new Map();

    for (const id of liveApiRoles) {
      if (roleIds.has(id)) wanted.set(id, { status: "working" });
    }

    for (const [id, b] of byAssignee) {
      if (wanted.has(id)) continue;
      if (b.doing) {
        wanted.set(id, { status: "working" });
      } else if (b.ready) {
        wanted.set(id, {
          status: "idle",
          ready: true,
          detail: b.ready.title || "ready",
        });
      } else if (b.review) {
        wanted.set(id, { status: "reporting" });
      } else if (b.blocked) {
        const raw = String(b.blocked.note || b.blocked.title || "waiting…");
        const detail = raw.replace(/^Waiting on:\s*/i, "").slice(0, 160);
        wanted.set(id, {
          status: "blocked",
          waiting: true,
          detail: detail || "waiting…",
        });
      }
    }

    for (const a of agents.list) {
      if (liveApiRoles.has(a.id)) continue;
      const w = wanted.get(a.id);
      if (!w) {
        if (a.bubbleKind === "waiting") agents.clearBubble?.(a.id);
        if (
          (a.status === "working" ||
            a.status === "reporting" ||
            a.status === "blocked") &&
          !a.stickyBubble
        ) {
          agents.setStatus(a.id, "idle");
          if (a.bubble && !a.stickyBubble) agents.clearBubble?.(a.id);
        }
        continue;
      }
      agents.setStatus(a.id, w.status);
      if (w.waiting) {
        getMission()?.ensureStep?.(roleProfileMeta(a.id));
        getMission()?.markStep?.(a.id, {
          status: "waiting",
          note: w.detail,
        });
        if (a.bubbleKind === "waiting" && a.bubbleAction === "toggle-waiting") {
          a.bubbleDetail = w.detail;
          a.bubble = a.bubbleExpanded ? w.detail : "waiting…";
          continue;
        }
        agents.clearBubble?.(a.id);
        agents.saySticky?.(
          a.id,
          "waiting…",
          "toggle-waiting",
          "waiting",
          w.detail
        );
        continue;
      }
      if (a.bubbleKind === "waiting") agents.clearBubble?.(a.id);
      if (w.ready) {
        getMission()?.ensureStep?.(roleProfileMeta(a.id));
        getMission()?.markStep?.(a.id, {
          status: "queued",
          note: `Ready: ${w.detail}`,
        });
      }
    }

    try {
      getMission()?.syncFromKanban?.(kanban?.snapshot?.() || []);
    } catch {
      /* ignore */
    }
    maybeKickReadyWork();
  }

  let kickTimer = null;
  /** Unstick: ready todos + idle factory → start desk work under settings profile. */
  function maybeKickReadyWork() {
    if (busy || kickTimer) return;
    if (!getMission?.()?.isOpen?.() || getMission?.()?.isPaused?.()) return;
    const kanban = getKanban();
    if (!kanban?.readySubs) return;
    const managerIds = [
      ...new Set(
        (kanban.snapshot?.() || [])
          .filter((c) => c.kind !== "main" && c.status !== "done")
          .map((c) => c.managerId)
          .filter(Boolean)
      ),
    ];
    const hasReady = managerIds.some((mid) =>
      (kanban.readySubs(mid) || []).some((c) => c.status === "todo")
    );
    if (!hasReady) return;
    kickTimer = setTimeout(() => {
      kickTimer = null;
      if (busy || !getMission?.()?.isOpen?.()) return;
      runReadyKick().catch((err) => console.error("[ready-kick]", err));
    }, 1200);
  }

  async function runReadyKick() {
    if (busy) return;
    const kanban = getKanban();
    const managerIds = [
      ...new Set(
        (kanban?.snapshot?.() || [])
          .filter((c) => c.kind !== "main" && c.status === "todo")
          .map((c) => c.managerId)
          .filter(Boolean)
      ),
    ];
    if (!managerIds.length) return;
    setBusy(true);
    getMission()?.setPinging?.(false);
    pushEdge(
      "system",
      "you",
      "Auto-start — ready factory cards (settings profile)"
    );
    try {
      for (const mid of managerIds) {
        if (!getMission?.()?.isOpen?.()) break;
        await resumeReadyKanban(mid);
      }
    } finally {
      setBusy(false);
      try {
        syncFloorPositions();
      } catch {
        /* ignore */
      }
      scheduleProgressPing();
    }
  }

  function startFloorSync() {
    if (floorSyncTimer) return;
    floorSyncTimer = setInterval(() => {
      try {
        syncFloorPositions();
      } catch {
        /* ignore */
      }
    }, 4000);
  }

  function stopFloorSync() {
    if (floorSyncTimer) {
      clearInterval(floorSyncTimer);
      floorSyncTimer = null;
    }
  }

  /**
   * After a CTO ping: run every ready (todo + deps met) factory sub at desks.
   * Uses Settings profiles (sparky/local) — never Hermes Agent kanban.
   */
  async function resumeReadyKanban(managerId, { signal = null } = {}) {
    const template = getTemplate();
    const agents = getAgents();
    const kanban = getKanban();
    const mission = getMission?.();
    if (!template || !agents || !kanban || !managerId) return [];

    kanban.refreshBlocked?.(managerId);
    const readyAll = (kanban.readySubs?.(managerId) || []).filter(
      (c) => c.status === "todo" && c.assigneeId
    );
    if (!readyAll.length) return [];

    const ready = [];
    const seen = new Set();
    for (const c of readyAll) {
      if (seen.has(c.assigneeId)) continue;
      seen.add(c.assigneeId);
      ready.push(c);
    }

    const main = kanban.mainOf?.(managerId);
    const brief = lastBoardMessage || mission?.getState?.()?.title || "";
    pushEdge(
      managerId,
      ready[0].assigneeId || "you",
      `Ping START — ${ready.length} ready subtask(s) at desks (settings profile)`
    );

    const results = [];
    await Promise.all(
      ready.map(async (card) => {
        const id = card.assigneeId;
        const meta = roleProfileMeta(id);
        mission?.ensureStep?.(meta);
        mission?.setActive?.(id, "graph");
        mission?.markStep?.(id, {
          status: "active",
          taskState: "in_progress",
          note: card.title,
        });
        const who = agents.byId(id);
        const dest =
          (who?.desk && deskTile?.(who.desk)) ||
          (Array.isArray(who?.home) ? who.home : null);
        if (dest) {
          agents.walkTo(id, dest, getOffice?.());
          await waitAgentAt(id, dest);
        }
        agents.setStatus(id, "working");
        kanban.patch?.(card.id, {
          status: "doing",
          note: "Working at desk (ping START)",
          _force: true,
        });
        try {
          syncFloorPositions();
        } catch {
          /* ignore */
        }
        pushEdge(managerId, id, `Start → ${card.title} · profile ${meta.hermesProfile}`);

        const depNotes = (card.dependsOn || [])
          .map((depId) => {
            const dep = kanban.get?.(depId);
            if (!dep) return null;
            return `${dep.title} (${roleTitle(template, dep.assigneeId)}): ${String(dep.note || "").slice(0, 400)}`;
          })
          .filter(Boolean)
          .join("\n\n");

        const role = roleById(template, id) || agents.byId(id);
        let result;
        try {
          result = await runRole(
            id,
            leafWorkPrompt(
              template,
              role,
              [
                brief,
                main?.title ? `\nMain delivery: ${main.title}` : "",
                `\nYour subtask: ${card.title}`,
                depNotes ? `\nUpstream deliverables:\n${depNotes}` : "",
              ].join(""),
              { fromRole: roleById(template, managerId), round: 1 }
            ),
            { isTask: true, signal }
          );
        } catch (err) {
          if (isCourseChanged(err)) throw err;
          const msg = String(err?.message || err).slice(0, 200);
          kanban.patch?.(card.id, {
            status: "blocked",
            note: `API/process failed — recovery ping to retry: ${msg}`,
            _force: true,
          });
          mission?.markStep?.(id, {
            status: "hold",
            taskState: "blocked",
            note: `Failed: ${msg}`,
          });
          agents.setStatus(id, "blocked");
          pushEdge(id, managerId, `Failed: ${msg}`);
          return;
        }

        const state = parseTaskState(result.reply, "in_progress");
        const note = String(result.reply || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        if (state === "blocked") {
          kanban.patch?.(card.id, {
            status: "blocked",
            note: note || "Blocked by assignee",
            _force: true,
          });
          mission?.markStep?.(id, {
            status: "waiting",
            taskState: "blocked",
            note: card.title,
          });
          agents.setStatus(id, "blocked");
        } else {
          kanban.complete?.(card.id, { note });
          mission?.markStep?.(id, {
            status: "done",
            taskState: state === "done" ? "done" : "in_progress",
            note: card.title,
          });
          agents.setStatus(id, "idle");
          results.push({ id, cardId: card.id, reply: result.reply, state });
        }
        pushEdge(id, managerId, `[${state}] ${card.title}: ${result.reply}`);
        try {
          syncFloorPositions();
        } catch {
          /* ignore */
        }
      })
    );

    kanban.refreshBlocked?.(managerId);
    try {
      syncFloorPositions();
    } catch {
      /* ignore */
    }
    return results;
  }

  async function runRole(roleId, prompt, { isTask = false, signal = null } = {}) {
    const template = getTemplate();
    const settings = getSettings();
    const agents = getAgents();
    const profile = profileForRole(
      template,
      settings,
      roleId,
      getProfiles?.() || []
    );
    liveApiRoles.add(roleId);
    agents.setStatus(roleId, "working");
    startFloorSync();
    const startedAt = Date.now();
    getMission()?.setActivity?.({
      roleId,
      kind: "api",
      label: "Hermes API call — generating reply",
      profile,
      startedAt,
    });
    try {
      const result = await runHermes({ profile, prompt, signal });
      const reply = result.reply || "";
      agents.say(roleId, reply.slice(0, 140));
      recordFromResult(roleId, prompt, result, { isTask, ok: true });
      const usage = result.usage || {};
      getMission()?.setActivity?.({
        roleId,
        kind: "replied",
        label: "reply received",
        profile,
        startedAt,
        endedAt: Date.now(),
        tokensIn: usage.input_tokens ?? null,
        tokensOut: usage.output_tokens ?? null,
        snippet: reply.replace(/\s+/g, " ").trim().slice(0, 180),
      });
      return { ...result, profile };
    } catch (err) {
      if (isCourseChanged(err)) throw err;
      const data = err.data || {
        ok: false,
        error: err.message,
        reply: "",
        profile,
        prompt,
      };
      recordFromResult(roleId, prompt, data, { isTask, ok: false });
      getMission()?.setActivity?.({
        roleId,
        kind: "error",
        label: "Hermes API call failed",
        profile,
        startedAt,
        endedAt: Date.now(),
        snippet: String(data.error || err.message || "call failed").slice(0, 180),
      });
      throw err;
    } finally {
      liveApiRoles.delete(roleId);
      try {
        syncFloorPositions();
      } catch {
        /* ignore */
      }
    }
  }

  async function runOrgChain({ startId, boardMessage, fromBoard = true }) {
    const template = getTemplate();
    const agents = getAgents();
    const office = getOffice();
    const mission = getMission?.();
    const boardOrigin = fromBoard;
    const startRole = roleById(template, startId) || agents.byId(startId);

    const myId = ++runId;
    // Kill prior chain only — never a recovery ping
    chainAbort?.abort();
    chainAbort = new AbortController();
    const signal = chainAbort.signal;
    const alive = () => {
      if (myId !== runId || signal.aborted) throw courseError();
    };

    clearProgressPing();
    lastBoardMessage = boardMessage;
    lastPathRoles = [roleProfileMeta(startId)];

    mission?.start({
      title: boardMessage,
      startId,
      steps: lastPathRoles,
    });
    startFloorSync();
    // Pings only after the chain settles (settleMission) — never mid-template-run

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

    function atTile(a, tile, eps = 0.55) {
      if (!a || !tile) return false;
      return (
        Math.abs(a.col - tile[0]) <= eps && Math.abs(a.row - tile[1]) <= eps
      );
    }

    function snapToTile(id, tile) {
      const a = agents.byId(id);
      if (!a || !tile) return;
      a.col = tile[0];
      a.row = tile[1];
      a.targetCol = tile[0];
      a.targetRow = tile[1];
      a.path = [];
      a.progress = 0;
    }

    /**
     * Wait until agent reaches dest (or empties path after walking).
     * On timeout: snap to dest so nobody is left stranded mid-floor / at kanban.
     */
    function waitForArrival(id, timeoutMs = 14000, dest = null) {
      return new Promise((resolve, reject) => {
        const t0 = performance.now();
        let seenPath = false;
        const who = agents.byId(id) || roleById(template, id);
        const target = dest || homeTile(who);
        // Already there — walkTo clears path immediately
        if (target && atTile(agents.byId(id), target)) {
          snapToTile(id, target);
          return resolve();
        }
        const tick = () => {
          try {
            alive();
          } catch (err) {
            return reject(err);
          }
          const a = agents.byId(id);
          if (!a) return resolve();
          if (a.path?.length) seenPath = true;
          if (target && atTile(a, target) && !a.path?.length) {
            snapToTile(id, target);
            return resolve();
          }
          if (seenPath && !a.path?.length) {
            if (target) snapToTile(id, target);
            return resolve();
          }
          if (performance.now() - t0 > timeoutMs) {
            if (target) snapToTile(id, target);
            return resolve();
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }

    async function roleTurn(roleId, prompt, opts = {}) {
      alive();
      const result = await runRole(roleId, prompt, { ...opts, signal });
      alive();
      return result;
    }

    /** Walk home and wait. working=true when about to do their Hermes turn. */
    async function goToOwnDesk(id, { working = true } = {}) {
      const who = agents.byId(id) || roleById(template, id);
      const dest = homeTile(who);
      walkHome(id);
      await waitForArrival(id, 14000, dest);
      agents.setStatus(id, working ? "working" : "idle");
    }

    /**
     * Strict handoff sequence:
     * 1) agent 2 is at their own desk (waiting)
     * 2) agent 1 walks to agent 2
     * 3) agent 1 returns home
     * 4) only then does the caller continue → agent 2 starts their task
     */
    async function walkAllTo(ids, tile) {
      const office = liveOffice();
      if (!tile) return;
      for (const id of ids) agents.walkTo(id, tile, office);
      await Promise.all(ids.map((id) => waitForArrival(id, 12000, tile)));
    }

    async function sendHome(ids) {
      const office = liveOffice();
      const uniq = [...new Set((ids || []).filter(Boolean))];
      const dests = new Map();
      for (const id of uniq) {
        const who = agents.byId(id) || roleById(template, id);
        const dest = homeTile(who);
        dests.set(id, dest);
        if (dest) agents.walkTo(id, dest, office);
        agents.setStatus(id, "idle");
      }
      await Promise.all(
        uniq.map((id) => waitForArrival(id, 12000, dests.get(id)))
      );
    }

    /** Never leave anyone stranded at the kanban — force every mounted agent home. */
    async function forceEveryoneHome() {
      const ids = (agents.list || []).map((a) => a.id);
      try {
        await sendHome(ids);
      } catch {
        /* course-change / teardown — still try a best-effort walk */
        const office = liveOffice();
        for (const id of ids) {
          const who = agents.byId(id) || roleById(template, id);
          const dest = homeTile(who);
          if (dest) agents.walkTo(id, dest, office);
          agents.setStatus?.(id, "idle");
        }
      }
    }

    /** Managers come to the CEO's office, hear the task, then leave. Not the kanban. */
    async function ceoOfficeExchange(ceoId, managerIds) {
      const ceo = agents.byId(ceoId) || roleById(template, ceoId);
      const dest = homeTile(ceo);
      await goToOwnDesk(ceoId, { working: false });
      pushEdge(
        ceoId,
        managerIds[0] || "you",
        `${roleTitle(template, ceoId)} called managers to the office`
      );
      await walkAllTo(managerIds, dest);
      pushEdge(
        ceoId,
        "you",
        `Exchange at the office — what will be done. Managers leave, then take kanban turns.`
      );
      await sendHome(managerIds);
    }

    /**
     * Manager alone at the kanban: owns MAIN, breaks into SUB tasks with
     * optional AFTER deps, pins cards, then everyone stays at / returns to desks.
     */
    async function managerKanbanTurn(managerId, executorIds) {
      const office = liveOffice();
      const tile = office?.kanbanTile?.();
      const title = roleTitle(template, managerId);
      if (!tile) return null;
      try {
        pushEdge(managerId, "you", `${title}'s turn — walking to the kanban alone`);
        agents.walkTo(managerId, tile, office);
        await waitForArrival(managerId, 12000, tile);
        // Team stays at desks while manager distributes
        await sendHome(executorIds);

        const executors = executorIds
          .map((id) => roleById(template, id))
          .filter(Boolean);
        const managerRole = roleById(template, managerId) || agents.byId(managerId);

        getMission()?.setActivity?.({
          roleId: managerId,
          kind: "api",
          label: `Kanban — ${title} defines main + subtasks`,
          startedAt: Date.now(),
        });
        const planned = await roleTurn(
          managerId,
          managerDecidePrompt(
            template,
            managerRole,
            brief,
            executors,
            reportUpTarget(template, managerId),
            { fromRole: priorRole, split: true }
          ),
          { isTask: true }
        );
        const reply = planned.reply;
        const plan = parseManagerPlan(reply, executorIds);
        pushEdge(managerId, "you", `Plan: ${reply}`);

        getKanban()?.removeOpenByTitle?.(managerId, boardMessage.slice(0, 160));
        getKanban()?.clear?.(managerId);

        let main = null;
        let subs = [];
        if (plan.tasks.length) {
          const packed = getKanban()?.addPlan?.({
            managerId,
            mainTitle:
              plan.mainTitle ||
              boardMessage.slice(0, 160) ||
              `${title} delivery`,
            tasks: plan.tasks,
            source: "cto",
          });
          main = packed?.main || null;
          subs = packed?.subs || [];
        } else if (plan.action?.type === "delegate" && plan.action.id) {
          const packed = getKanban()?.addPlan?.({
            managerId,
            mainTitle: plan.mainTitle || boardMessage.slice(0, 160),
            tasks: [
              {
                assigneeId: plan.action.id,
                title: boardMessage.slice(0, 140),
                dependsOn: [],
              },
            ],
            source: "cto",
          });
          main = packed?.main || null;
          subs = packed?.subs || [];
        }

        pushEdge(
          managerId,
          "you",
          `Distributed ${subs.length} subtask(s) — back to desk before work starts`
        );
        return { action: plan.action, main, subs, plan };
      } finally {
        await sendHome([managerId, ...executorIds]);
      }
    }

    /**
     * Event-driven desk work from kanban deps.
     * Ready subs (deps done) run in parallel at desks; completing a card
     * unblocks dependents and starts the next wave.
     */
    async function runKanbanPlan(managerId, { main, subs }) {
      const kanban = getKanban();
      const subList = Array.isArray(subs) ? subs.slice() : [];
      if (!subList.length) return [];

      const assigneeIds = [
        ...new Set(subList.map((c) => c.assigneeId).filter(Boolean)),
      ];
      await sendHome([managerId, ...assigneeIds]);

      for (const card of subList) {
        if (card.assigneeId) mission?.ensureStep(roleProfileMeta(card.assigneeId));
      }

      const doneReplies = new Map(); // cardId → reply
      const finished = new Set();
      const results = [];
      let guard = 0;

      async function runSub(card) {
        const id = card.assigneeId;
        if (!id) return null;
        mission?.ensureStep(roleProfileMeta(id));
        mission?.setActive(id, "graph");
        mission?.markStep(id, {
          status: "active",
          taskState: "in_progress",
          note: card.title,
        });
        await goToOwnDesk(id, { working: true });
        kanban?.patch?.(card.id, {
          status: "doing",
          note: "Working at desk",
        });
        try {
          syncFloorPositions();
        } catch {
          /* ignore */
        }
        pushEdge(managerId, id, `Start → ${card.title}`);

        const depNotes = (card.dependsOn || [])
          .map((depId) => {
            const dep = kanban?.get?.(depId);
            const reply = doneReplies.get(depId);
            if (!dep || !reply) return null;
            return `${dep.title} (${roleTitle(template, dep.assigneeId)}):\n${String(reply).slice(0, 1200)}`;
          })
          .filter(Boolean)
          .join("\n\n");

        const role = roleById(template, id) || agents.byId(id);
        let result;
        try {
          result = await roleTurn(
            id,
            leafWorkPrompt(
              template,
              role,
              [
                brief,
                main?.title ? `\nMain delivery: ${main.title}` : "",
                `\nYour subtask: ${card.title}`,
                depNotes ? `\nUpstream deliverables:\n${depNotes}` : "",
              ].join(""),
              { fromRole: roleById(template, managerId), round: 1 }
            ),
            { isTask: true }
          );
        } catch (err) {
          if (isCourseChanged(err)) throw err;
          const msg = String(err?.message || err).slice(0, 200);
          // Stay blocked until a recovery ping reopens the card
          kanban?.patch?.(card.id, {
            status: "blocked",
            note: `API/process failed — recovery ping to retry: ${msg}`,
          });
          finished.add(card.id); // don't auto-retry in this run
          mission?.markStep(id, {
            status: "hold",
            taskState: "blocked",
            note: `Failed: ${msg}`,
          });
          agents.setStatus(id, "blocked");
          await goToOwnDesk(id, { working: false });
          pushEdge(id, managerId, `Failed: ${msg}`);
          return { id, cardId: card.id, reply: "", state: "blocked", failed: true };
        }

        const state = parseTaskState(result.reply, "in_progress");
        const note = String(result.reply || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        doneReplies.set(card.id, result.reply);
        finished.add(card.id);
        if (state === "blocked") {
          // Soft block from the model — do not unlock AFTER dependents
          kanban?.patch?.(card.id, {
            status: "blocked",
            note: note || "Blocked by assignee",
          });
          mission?.markStep(id, {
            status: "waiting",
            taskState: "blocked",
            note: card.title,
          });
          pushEdge(id, managerId, `[blocked] ${card.title}: ${result.reply}`);
          agents.setStatus(id, "blocked");
          await goToOwnDesk(id, { working: false });
          try {
            syncFloorPositions();
          } catch {
            /* ignore */
          }
          return {
            id,
            cardId: card.id,
            reply: result.reply,
            state,
            failed: false,
          };
        }
        // Mark done → unblocks dependents (event)
        kanban?.complete?.(card.id, { note });
        // If this position still has dep-waiting cards, keep mission on waiting
        const stillWaiting = (kanban?.snapshot?.() || []).some(
          (c) =>
            c.assigneeId === id &&
            c.id !== card.id &&
            (c.status === "blocked" || kanban?.isDepBlocked?.(c))
        );
        mission?.markStep(id, {
          status: stillWaiting ? "waiting" : "done",
          taskState: state === "done" ? "done" : "in_progress",
          note: stillWaiting
            ? (kanban?.snapshot?.() || []).find(
                (c) =>
                  c.assigneeId === id &&
                  (c.status === "blocked" || kanban?.isDepBlocked?.(c))
              )?.note || card.title
            : card.title,
        });
        pushEdge(id, managerId, `[${state}] ${card.title}: ${result.reply}`);
        agents.setStatus(id, stillWaiting ? "blocked" : "idle");
        await goToOwnDesk(id, { working: false });
        try {
          syncFloorPositions();
        } catch {
          /* ignore */
        }
        return { id, cardId: card.id, reply: result.reply, state, failed: false };
      }

      while (guard++ < 40) {
        alive();
        kanban?.refreshBlocked?.(managerId);
        const open = (kanban?.openSubs?.(managerId) || []).filter(
          (c) => !finished.has(c.id)
        );
        if (!open.length) break;

        const readyAll = (kanban?.readySubs?.(managerId) || []).filter(
          (c) => c.status === "todo" && !finished.has(c.id) && c.assigneeId
        );
        // One card per person per wave — same executor never double-booked
        const ready = [];
        const seenAssignee = new Set();
        for (const c of readyAll) {
          if (seenAssignee.has(c.assigneeId)) continue;
          seenAssignee.add(c.assigneeId);
          ready.push(c);
        }
        if (!ready.length) {
          pushEdge(
            managerId,
            "you",
            `Kanban waiting — ${open.length} card(s) blocked or not ready`
          );
          break;
        }

        pushEdge(
          managerId,
          ready[0].assigneeId || "you",
          `Wave — ${ready.length} ready subtask(s) at desks`
        );
        const waveResults = await Promise.all(ready.map((card) => runSub(card)));
        for (const r of waveResults) {
          if (r && !r.failed) results.push(r);
        }
      }

      const evaluator =
        (template.roles || []).find(
          (r) => normalizeRoleKind(r.roleKind) === "evaluator"
        ) || null;

      // QA reviews finished subtasks (other cards may still be dep-waiting)
      if (evaluator && results.length) {
        mission?.ensureStep(roleProfileMeta(evaluator.id));
        mission?.setActive(evaluator.id, "evaluate");
        mission?.markStep(evaluator.id, {
          status: "active",
          taskState: "in_progress",
          note: "QC review",
        });
        pushEdge(
          managerId,
          evaluator.id,
          `QC handoff → ${evaluator.title} (${results.length} finished)`
        );
        await goToOwnDesk(evaluator.id, { working: true });
        try {
          syncFloorPositions();
        } catch {
          /* ignore */
        }
        const qc = await roleTurn(
          evaluator.id,
          evaluatorValidatePrompt(
            template,
            evaluator,
            boardMessage,
            { title: "the team" },
            results
              .map((r) => `${roleTitle(template, r.id)}: ${r.reply}`)
              .join("\n\n"),
            "in_progress"
          ),
          { isTask: true }
        );
        const qcState = parseTaskState(qc.reply, "in_progress");
        const qcNote = String(qc.reply || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        pushEdge(evaluator.id, managerId, `[QA · ${qcState}] ${qc.reply}`);
        for (const r of results) {
          if (!r.cardId) continue;
          // Never demote done → review (that reopens deps). Stamp QA note only.
          const card = kanban?.get?.(r.cardId);
          if (card?.status === "done") {
            kanban?.patch?.(r.cardId, {
              note: `QA · ${qcState}: ${qcNote}`,
            });
          } else if (qcState === "done") {
            kanban?.complete?.(r.cardId, {
              note: `QA · done: ${qcNote}`,
            });
          } else {
            kanban?.patch?.(r.cardId, {
              status: "review",
              note: `QA · ${qcState}: ${qcNote}`,
            });
          }
        }
        mission?.markStep(evaluator.id, {
          status: qcState === "done" ? "done" : "hold",
          taskState: qcState,
          note: qcNote,
        });
        if (main?.id) {
          const openLeft = kanban?.openSubs?.(managerId) || [];
          if (qcState === "done" && !openLeft.length) {
            kanban?.complete?.(main.id, { note: qcNote });
          } else {
            kanban?.patch?.(main.id, {
              status: openLeft.length ? "doing" : "review",
              note: qcNote,
            });
          }
        }
        agents.setStatus(evaluator.id, "idle");
        await goToOwnDesk(evaluator.id, { working: false });
      } else if (main?.id && !(kanban?.openSubs?.(managerId) || []).length) {
        kanban?.complete?.(main.id, { note: "All subtasks finished" });
      }

      kanban?.refreshBlocked?.(managerId);
      try {
        syncFloorPositions();
      } catch {
        /* ignore */
      }
      await sendHome([managerId, ...assigneeIds]);
      return results;
    }

    async function handoffAndReturn(fromId, toId, note) {
      // Receiver waits at their desk — not working yet
      await goToOwnDesk(toId, { working: false });
      agents.setStatus(fromId, "reporting");
      getMission()?.setActivity?.({
        roleId: fromId,
        kind: "api",
        label: `Reporting — ${note}`,
        startedAt: Date.now(),
        endedAt: Date.now(),
      });
      const to = agents.byId(toId) || roleById(template, toId);
      const meet = homeTile(to);
      walkToward(fromId, toId, note);
      await waitForArrival(fromId, 14000, meet);
      const from = agents.byId(fromId) || roleById(template, fromId);
      const home = homeTile(from);
      walkHome(fromId);
      await waitForArrival(fromId, 14000, home);
      agents.setStatus(fromId, "idle");
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
    try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      alive();
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
      alive();

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
        const { reply } = await roleTurn(currentId, prompt, { isTask: true });
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

        const managers = candidates.map((r) => r.id);
        const turns = [];
        const re = /DELEGATE:\s*([a-z0-9_-]+)/gi;
        let match;
        while ((match = re.exec(reply))) {
          const id = match[1].toLowerCase();
          if (managers.includes(id) && !turns.includes(id)) turns.push(id);
        }
        if (!turns.length) turns.push(action.id);
        await ceoOfficeExchange(currentId, managers);
        for (const id of turns) {
          getKanban()?.add?.({
            managerId: id,
            title: boardMessage.slice(0, 160),
            status: "todo",
            source: "orchestrator",
          });
        }
        // First manager's kanban turn runs on their hop. Others wait their turn.
        agents._kanbanTurns = turns.slice(1);
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

      // Coming from the CEO: kanban turn first, work only after everyone is home.
      if (
        kind === "manager" &&
        !afterEval &&
        priorRole &&
        normalizeRoleKind(priorRole.roleKind, {
          isOrchestrator: priorRole.id === template.orchestratorRoleId,
        }) === "orchestrator"
      ) {
        const executors = delegateCandidates(template, currentId);
        agents.setStatus(currentId, "idle");
        const first = await managerKanbanTurn(
          currentId,
          executors.map((r) => r.id)
        );
        const later = Array.isArray(agents._kanbanTurns) ? agents._kanbanTurns : [];
        agents._kanbanTurns = [];
        const rounds = [first];
        for (const otherId of later) {
          const others = delegateCandidates(template, otherId);
          rounds.push(
            await managerKanbanTurn(
              otherId,
              others.map((r) => r.id)
            )
          );
        }
        const plans = rounds.filter(Boolean);
        const anySubs = plans.some((r) => r.subs?.length);
        if (!anySubs) {
          agents.setStatus(currentId, "idle");
          break;
        }
        for (const round of plans) {
          if (!round.subs?.length) continue;
          await runKanbanPlan(round.main?.managerId || currentId, {
            main: round.main,
            subs: round.subs,
          });
        }
        const assignees = [
          ...new Set(
            plans.flatMap((r) => (r.subs || []).map((s) => s.assigneeId).filter(Boolean))
          ),
        ];
        mission?.markStep(currentId, {
          status: "done",
          taskState: "in_progress",
          note: `Kanban plan → ${assignees.join(", ") || "team"}`,
        });
        priorRole = currentRole;
        handedFromBoard = false;
        afterEval = true;
        currentId = currentId;
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
        const { reply } = await roleTurn(currentId, prompt, { isTask: true });
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
          const result = await roleTurn(currentId, prompt, { isTask: true });
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

          // Progress is reported on the kanban, not only as a walk to the manager's desk.
          if (orderGiverId) {
            const office = liveOffice();
            const tile = office?.kanbanTile?.();
            const report = reply.replace(/\s+/g, " ").trim().slice(0, 220);
            agents.setStatus(currentId, "reporting");
            getMission()?.setActivity?.({
              roleId: currentId,
              kind: "api",
              label: `Reporting to kanban — ${orderGiverTitle}`,
              startedAt: Date.now(),
              endedAt: Date.now(),
              snippet: report,
            });
            pushEdge(currentId, orderGiverId, `Kanban report → ${orderGiverTitle}`);
            if (tile) {
              agents.walkTo(orderGiverId, tile, office);
              agents.walkTo(currentId, tile, office);
              await Promise.all([
                waitForArrival(orderGiverId, 12000, tile),
                waitForArrival(currentId, 12000, tile),
              ]);
            }
            getKanban()?.place?.({
              managerId: orderGiverId,
              assigneeId: currentId,
              title: boardMessage.slice(0, 160),
              status: "doing",
              source: "report",
              note: report,
            });
            agents.say(currentId, `Reported on kanban`, 2500);
            await sendHome([currentId, orderGiverId]);
          }

          // Reporting to the manager is the last executor step. QA is next,
          // even when the model writes TASK_STATE: in_progress and "later QA".
          const postponesQc = /before handing to QA|then QA|hand(?:ing)? to QA later/i.test(
            reply
          );
          if (
            state === "done" ||
            state === "blocked" ||
            postponesQc ||
            round >= maxRounds
          ) {
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

        // QA always runs after an executor finishes a round of work.
        // Do it in this hop so a later report-up cannot skip QC.
        const evaluator =
          evaluatorForExecutor(template, currentId) ||
          (template.roles || []).find(
            (r) => normalizeRoleKind(r.roleKind) === "evaluator"
          );
        if (!evaluator) {
          pushEdge(currentId, orderGiverId || "you", `No QA role — skipping QC`);
          if (!orderGiverId) break;
          currentId = orderGiverId;
          priorRole = currentRole;
          continue;
        }

        mission?.ensureStep(roleProfileMeta(evaluator.id));
        mission?.setActive(evaluator.id, "evaluate");
        getMission()?.setActivity?.({
          roleId: evaluator.id,
          kind: "api",
          label: `QC — ${evaluator.title} is reviewing`,
          profile: roleProfileMeta(evaluator.id).hermesProfile,
          startedAt: Date.now(),
        });
        getKanban()?.place?.({
          managerId: orderGiverId,
          assigneeId: currentId,
          title: boardMessage.slice(0, 160),
          status: "review",
          source: "qa",
        });
        pushEdge(currentId, evaluator.id, `QC handoff → ${evaluator.title}`);
        await handoffAndReturn(
          currentId,
          evaluator.id,
          `QC handoff → ${evaluator.title}`
        );
        await goToOwnDesk(evaluator.id);
        const qc = await roleTurn(
          evaluator.id,
          evaluatorValidatePrompt(
            template,
            roleById(template, evaluator.id) || evaluator,
            boardMessage,
            currentRole,
            progressNotes.join("\n") || reply,
            state
          ),
          { isTask: true }
        );
        const qcState = parseTaskState(qc.reply, state);
        const managerId =
          normalizeBossId(evaluator.reportsTo) ||
          orderGiverId ||
          normalizeBossId(evaluator.takesOrdersFrom);
        pushEdge(evaluator.id, managerId || "you", `[QA · ${qcState}] ${qc.reply}`);
        path.push({ id: evaluator.id, reply: qc.reply, state: qcState });
        rolledState = qcState;
        rolledReply = qc.reply;
        mission?.markStep(evaluator.id, {
          status: "done",
          taskState: qcState,
          note: qc.reply.slice(0, 160),
        });
        getMission()?.setActivity?.({
          roleId: evaluator.id,
          kind: "replied",
          label: `${evaluator.title} finished QC`,
          startedAt: Date.now(),
          endedAt: Date.now(),
          snippet: String(qc.reply || "").replace(/\s+/g, " ").trim().slice(0, 180),
        });
        getKanban()?.place?.({
          managerId: managerId,
          assigneeId: currentId,
          title: boardMessage.slice(0, 160),
          status: qcState === "done" ? "done" : "review",
          source: "qa",
        });
        agents.setStatus(evaluator.id, "idle");
        if (managerId) {
          await handoffAndReturn(
            evaluator.id,
            managerId,
            `QC → ${roleTitle(template, managerId)}`
          );
        }
        brief = [
          `Original board request:\n${boardMessage}`,
          ``,
          `${evaluator.title} reviewed ${currentRole.title}.`,
          `TASK_STATE: ${qcState}`,
          `${evaluator.title} said:\n${qc.reply}`,
        ].join("\n");
        priorRole = roleById(template, evaluator.id) || currentRole;
        handedFromBoard = false;
        afterEval = true;
        currentId = managerId || orderGiverId || currentId;
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
        const { reply } = await roleTurn(currentId, prompt, { isTask: true });
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
        const { reply } = await roleTurn(currentId, prompt, { isTask: true });
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
        const { reply } = await roleTurn(
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
        // Require explicit DELIVERED: yes; if factory board is finished, allow yes
        deliveredOk =
          wantsDeliver === true &&
          (state === "done" || factoryBoardComplete());

        pushEdge(
          startId,
          "you",
          `[${state}${deliveredOk ? " · DELIVERED" : " · NOT DELIVERED"}] ${reply}`
        );
        mission?.markStep(startId, {
          status: deliveredOk ? "reported" : "active",
          taskState: state,
          note: deliveredOk ? "Verified board report" : "Verification — still open",
          rollUp: true,
        });
        agents.setStatus(startId, "idle");
      }
    }

    // Everyone walks back to their own desk
    await forceEveryoneHome();

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
      recordDelivered(rolledReply);
      getMission?.()?.setDelivered(rolledState);
    } else {
      settleMission(rolledState || path[path.length - 1]?.state || "in_progress", {
        held,
      });
    }
    } catch (err) {
      try {
        await forceEveryoneHome();
      } catch {
        /* ignore */
      }
      if (isCourseChanged(err)) return { cancelled: true };
      throw err;
    } finally {
      if (myId === runId) chainAbort = null;
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
    if (isServerOrch()) {
      setBusy(true);
      try {
        const composed = [
          lastBoardMessage
            ? `Previous board request:\n${lastBoardMessage}\n`
            : "",
          lastBoardReport
            ? `CEO’s last report to the board:\n${lastBoardReport}\n`
            : "",
          `Board reply / next order:\n${msg}`,
        ]
          .filter(Boolean)
          .join("\n");
        lastBoardMessage = composed;
        await postMission(composed);
        return true;
      } catch (err) {
        pushEdge(orchId, "you", `Hermes error: ${err.message || err}`);
        return null;
      }
    }
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
    } catch (err) {
      if (isCourseChanged(err)) return null;
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function runProgressPing({ reason = "ping" } = {}) {
    const mission = getMission?.();
    const m = mission?.getState?.();
    if (!m || !mission?.isOpen?.()) {
      clearProgressPing();
      return;
    }
    if (busy) {
      pingTimer = setTimeout(() => {
        pingTimer = null;
        runProgressPing({ reason }).catch((err) => {
          console.error("[progress-ping]", err);
          scheduleProgressPing();
        });
      }, 20_000);
      return;
    }

    const template = getTemplate();
    const agents = getAgents();
    const orchId = template?.orchestratorRoleId;
    const kanban = getKanban();
    const openCards = (kanban?.snapshot?.() || []).filter(
      (c) => c.status && c.status !== "done"
    );
    // Managers who actually have open kanban work — they must check the board
    const managerIds = [
      ...new Set(
        openCards.map((c) => c.managerId).filter((id) => id && id !== orchId)
      ),
    ];

    // Orch always; managers only if they have open cards to inspect
    const targetIds = [];
    if (orchId) targetIds.push(orchId);
    for (const id of managerIds) {
      if (!targetIds.includes(id)) targetIds.push(id);
    }
    if (!targetIds.length) {
      scheduleProgressPing();
      return;
    }
    const targets = targetIds.map((id) => roleProfileMeta(id)).filter((r) => r?.id);

    mission.setPinging?.(true);
    setBusy(true);
    const watchId = runId;
    pingAbort?.abort();
    pingAbort = new AbortController();
    const signal = pingAbort.signal;
    const orchTitle = roleTitle(template, orchId);
    const label =
      reason === "resume" || reason === "restart"
        ? `${orchTitle} restart — managers check open kanban`
        : `${orchTitle} recovery ping — managers check kanban (~90s)`;
    pushEdge(orchId || "system", "you", label);

    let latest = m.taskState || "in_progress";
    const pingPath = lastPathRoles.map((r) => ({
      id: r.id,
      state: m.steps.find((s) => s.id === r.id)?.taskState || latest,
      reply: m.steps.find((s) => s.id === r.id)?.note || "",
    }));
    try {
      for (const t of targets) {
        if (watchId !== runId || signal.aborted || !mission.isOpen?.()) return;
        const role = roleById(template, t.id) || agents.byId(t.id);
        if (!role) continue;
        const meta = roleProfileMeta(t.id);
        const kind =
          normalizeRoleKind(role.roleKind, {
            isOrchestrator: t.id === orchId,
          }) === "orchestrator"
            ? "orchestrator"
            : "manager";
        const mine = openCards.filter((c) => c.managerId === t.id);
        const hasKanban = kind === "manager" && mine.length > 0;
        // Skip managers with nothing on the board
        if (kind === "manager" && !hasKanban) continue;

        const kanbanSummary = hasKanban
          ? formatKanbanPingSummary(kanban, template, t.id)
          : formatPositionWorkSummary(kanban, template);

        // Manager with tasks → walk to kanban and inspect
        if (hasKanban) {
          pushEdge(
            t.id,
            "you",
            `${roleTitle(template, t.id)} → kanban check (${mine.length} open)`
          );
          await walkManagerToKanban(t.id);
        }

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
            meta.hermesProfile,
            { kind, kanbanSummary, reason, hasKanban }
          ),
          { isTask: true, signal }
        );
        const state = parseTaskState(reply, latest);
        latest = state;
        mission.markStep(t.id, {
          // Don't leave ping targets stuck in Active forever (looked like 0% freeze)
          status: state === "done" ? "done" : state === "blocked" ? "hold" : "queued",
          taskState: state,
          note: `ping: ${reply.slice(0, 120)}`,
          rollUp: false, // never flip mission to done from a ping alone
        });
        pushEdge(orchId || "system", t.id, `[ping · ${state}] ${reply}`);
        if (hasKanban) {
          const note = `Kanban check: ${reply.replace(/\s+/g, " ").trim().slice(0, 200)}`;
          for (const card of (kanban?.snapshot?.() || []).filter(
            (c) => c.managerId === t.id && c.kind === "main"
          )) {
            kanban?.patch?.(card.id, { note });
          }
          // CTO owns the board: apply CARD moves, RETRY reopen, then START ready work
          const directives = parseKanbanDirectives(reply);
          // If ready todos exist and CTO talks about working/retry without START, still kick them
          const readyNow = (kanban?.readySubs?.(t.id) || []).filter(
            (c) => c.status === "todo"
          );
          if (
            readyNow.length &&
            /\b(start|retry|working|kick|unblock|resume)\b/i.test(reply)
          ) {
            directives.start = true;
          }
          const applied = applyKanbanDirectives(kanban, t.id, directives, {
            force: true,
          });
          if (applied.moved || applied.reopened || applied.gated) {
            pushEdge(
              t.id,
              "you",
              `Kanban moves: ${applied.moved} status · ${applied.reopened} reopened${
                applied.gated ? ` · ${applied.gated} GATE done` : ""
              }${directives.gateAllow ? " · GATE: allow" : ""}`
            );
          }
          if (applied.denied?.length) {
            pushEdge(
              t.id,
              "you",
              `Gate closed — ${applied.denied.length} frozen card(s) not forced to done. Say GATE: allow then CARD: <role> | done`
            );
          }
          try {
            syncFloorPositions();
          } catch {
            /* ignore */
          }
          await walkManagerHome(t.id);
          // Always kick ready todos after CTO board check (unstick waiting freeze)
          if (directives.start || readyNow.length || applied.reopened) {
            try {
              await resumeReadyKanban(t.id, { signal });
            } catch (err) {
              if (!isCourseChanged(err)) {
                pushEdge(
                  t.id,
                  "you",
                  `Ping START failed: ${String(err?.message || err).slice(0, 160)}`
                );
              }
            }
          }
        } else {
          agents.setStatus(t.id, "idle");
        }
        const step = pingPath.find((p) => p.id === t.id);
        if (step) {
          step.state = state;
          step.reply = reply;
        } else {
          pingPath.push({ id: t.id, state, reply });
        }
      }

      // Board finished (all factory cards done) OR agents claim done → CEO must report
      const boardDone = factoryBoardComplete();
      if (latest === "done" || boardDone) {
        const orch =
          getTemplate()?.orchestratorRoleId || lastPathRoles[0]?.id;
        if (orch) {
          const topRole = roleById(template, orch) || agents.byId(orch);
          const meta = roleProfileMeta(orch);
          mission.ensureStep(meta);
          mission.setActive(orch, "verify");
          pushEdge(
            orch,
            "you",
            boardDone
              ? `All factory cards done — CEO board report required`
              : `CEO verifying & preparing board report…`
          );
          const { reply } = await runRole(
            orch,
            ceoVerifyDeliverPrompt(
              template,
              { ...topRole, ...meta },
              lastBoardMessage || m.title,
              boardDone ? "done" : latest,
              pingPath,
              meta.hermesProfile
            ),
            { isTask: true, signal }
          );
          const state = parseTaskState(reply, boardDone ? "done" : latest);
          const wantsDeliver = parseDelivered(reply);
          latest = state;
          // If every factory card is done, accept DELIVERED: yes even if model
          // hedges TASK_STATE — board work is finished; CEO must close it out.
          const deliveredOk =
            wantsDeliver === true &&
            (state === "done" || boardDone);
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
            rollUp: true,
          });
          agents.setStatus(orch, "idle");
          if (deliveredOk) {
            lastBoardReport = reply;
            clearProgressPing();
            recordDelivered(reply);
            mission.setDelivered("done");
            return;
          }
          if (boardDone && wantsDeliver !== true) {
            pushEdge(
              orch,
              "you",
              `Factory board is 100% done — CEO must end with DELIVERED: yes on the next ping`
            );
          }
        }
      }
    } catch (err) {
      if (isCourseChanged(err)) return;
      throw err;
    } finally {
      mission.setPinging?.(false);
      if (watchId === runId) pingAbort = null;
      setBusy(false);
    }

    if (watchId !== runId || !mission.isOpen?.()) return;
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
    lastBoardMessage = text;
    lastOrchId = orch;
    if (isServerOrch()) {
      setBusy(true);
      try {
        await postMission(text);
      } catch (err) {
        const msg = err.message || String(err);
        pushEdge(orch, "you", `Hermes error: ${msg}`);
        getAgents()?.setStatus(orch, "blocked");
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      await runOrgChain({
        startId: orch,
        boardMessage: text,
        fromBoard: true,
      });
    } catch (err) {
      if (isCourseChanged(err)) return;
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

    if (isServerOrch()) {
      setBusy(true);
      try {
        await postMission(`Direct task for ${assigneeId}: ${text}`);
      } catch (err) {
        const msg = err.message || String(err);
        pushEdge(assigneeId, "you", `Hermes error: ${msg}`);
        agents.setStatus(assigneeId, "blocked");
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      await runOrgChain({
        startId: assigneeId,
        boardMessage: text,
        fromBoard: true,
      });
    } catch (err) {
      if (isCourseChanged(err)) return;
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

  function parkAgentsHome() {
    const agents = getAgents?.();
    if (agents) agents._kanbanTurns = [];
    const list = Array.isArray(agents?.list) ? agents.list : [];
    for (const a of list) {
      agents.clearBubble?.(a.id);
      agents.setStatus?.(a.id, "idle");
      if (a.path) a.path.length = 0;
      a.col = a.home?.[0] ?? a.col;
      a.row = a.home?.[1] ?? a.row;
      a.targetCol = a.col;
      a.targetRow = a.row;
      a.progress = 0;
      a.workMs = 0;
    }
  }

  /** Abort the in-flight run, freeze the mission bar, unlock the dock for a new order. */
  function pauseTask({ quiet = false } = {}) {
    runId += 1;
    chainAbort?.abort();
    chainAbort = null;
    pingAbort?.abort();
    pingAbort = null;
    clearProgressPing();
    stopFloorSync();
    liveApiRoles.clear();
    if (isServerOrch()) {
      fetch("/api/missions/abort", { method: "POST" }).catch(() => {});
    }
    getMission()?.pause?.();
    parkAgentsHome();
    setBusy(false);
    if (!quiet) {
      pushEdge(
        "you",
        "system",
        "Board paused the task — dock is free for a new order."
      );
    }
  }

  /**
   * Stop & remove — abort Hermes wait, clear kanban + mission,
   * send everyone home idle, unlock the dock.
   */
  function changeCourse({ quiet = false } = {}) {
    runId += 1;
    chainAbort?.abort();
    chainAbort = null;
    pingAbort?.abort();
    pingAbort = null;
    clearProgressPing();
    stopFloorSync();
    liveApiRoles.clear();
    lastBoardMessage = "";
    lastBoardReport = "";
    lastOrchId = null;
    lastPathRoles = [];
    if (isServerOrch()) {
      fetch("/api/missions/stop", { method: "POST" }).catch(() => {});
    }
    getMission()?.clear?.();
    try {
      getKanban()?.clearAll?.();
    } catch {
      /* ignore */
    }
    parkAgentsHome();
    setBusy(false);
    if (!quiet) {
      pushEdge("you", "system", "Board stopped and removed the task.");
    }
  }

  return {
    refreshStats,
    refreshAssignee,
    setBusy,
    isBusy: () => busy,
    getBoardReplyContext,
    sendBoardReply,
    getContext,
    restoreContext,
    resumeAfterReload,
    pauseTask,
    changeCourse,
    resetTasks: changeCourse,
    syncFloorPositions,
    applyServerEvent,
    isServerOrch,
  };
}
