/** Templates loaded from bridge (~/.hermes-factory/templates/*.json) */

let cache = {
  list: [],
  byId: {},
};

export function listTemplates() {
  return cache.list;
}

export function getTemplate(id) {
  if (id && cache.byId[id]) return cache.byId[id];
  const first = cache.list[0];
  return first ? cache.byId[first.id] || null : null;
}

export async function refreshTemplates() {
  const res = await fetch("/api/templates");
  if (!res.ok) throw new Error(`templates list failed (${res.status})`);
  const data = await res.json();
  cache.list = data.templates || [];
  cache.byId = {};
  await Promise.all(
    cache.list.map(async (meta) => {
      const r = await fetch(`/api/templates/${encodeURIComponent(meta.id)}`);
      const full = await r.json();
      if (!r.ok || !full?.id) {
        console.warn("[registry] skip template", meta.id, full);
        return;
      }
      cache.byId[meta.id] = full;
    })
  );
  return cache.list;
}

export async function saveTemplate(template) {
  const id = template.id;
  const payload = normalizeOrgChart(template);
  const res = await fetch(`/api/templates/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `save failed (${res.status})`);
  cache.byId[data.id] = normalizeOrgChart(data);
  await refreshTemplates();
  return cache.byId[data.id];
}

export async function createTemplate({ name, cloneFrom }) {
  const res = await fetch("/api/templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, cloneFrom }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `create failed (${res.status})`);
  await refreshTemplates();
  return data;
}

export async function deleteTemplate(id) {
  const res = await fetch(`/api/templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `delete failed (${res.status})`);
  await refreshTemplates();
  return data;
}

/**
 * Org role kinds — communication is a directed graph, not a fixed pipeline.
 *
 *   Board ⇄ Orchestrator ⇄ Manager ⇄ Executor → Evaluator → Manager
 *                              ↑________________________|
 *
 * Edges (who may talk to whom):
 * - orchestrator calls every manager to the kanban table, then assigns one board
 * - managers under the orchestrator may collaborate with each other
 * - manager → executor (distribute on that manager's kanban) OR report up
 * - executors under the same manager may collaborate and add tasks on that kanban
 * - executor → order-giver while working, then evaluator, then manager
 * - evaluator → manager
 */
export const ROLE_KINDS = [
  {
    id: "orchestrator",
    name: "Orchestrator",
    blurb: "Start + end: Board ↔ managers (usually CEO).",
  },
  {
    id: "manager",
    name: "Manager",
    blurb: "Decision node: send to an executor, or report up to orchestrator.",
  },
  {
    id: "executor",
    name: "Executor",
    blurb:
      "Does the work; interval progress reports to who gave the order (takesOrdersFrom); then QC.",
  },
  {
    id: "evaluator",
    name: "Evaluator",
    blurb: "QC: docs, data sources, and code quality, then back to the manager.",
  },
];

export const ROLE_KIND_IDS = ROLE_KINDS.map((k) => k.id);

/** Allowed next kinds from a node (graph theory view). */
export const ROLE_KIND_EDGES = {
  orchestrator: ["manager", "board"],
  manager: ["executor", "orchestrator", "manager"],
  /** Progress → order-giver; peers under the same manager; finish → evaluator */
  executor: ["manager", "evaluator", "executor"],
  evaluator: ["manager"],
  board: ["orchestrator"],
};

export function normalizeRoleKind(value, { isOrchestrator = false } = {}) {
  const v = String(value || "").toLowerCase();
  if (ROLE_KIND_IDS.includes(v)) return v;
  return isOrchestrator ? "orchestrator" : "executor";
}

export function roleKindLabel(kind) {
  return ROLE_KINDS.find((k) => k.id === kind)?.name || kind || "Executor";
}

/**
 * Always define takesOrdersFrom + reportsTo + roleKind.
 * Board target (orchestrator): both bosses null, roleKind orchestrator.
 * Everyone else: both required role ids; missing → orchestrator.
 */
export function normalizeOrgChart(template) {
  const roles = [...(template.roles || [])];
  const roleIds = new Set(roles.map((r) => r.id).filter(Boolean));
  let orch = template.orchestratorRoleId;
  if (!roleIds.has(orch) && roles.length) orch = roles[0].id;

  const fixed = roles.map((role) => {
    const isOrch = role.id === orch;
    const roleKind = normalizeRoleKind(role.roleKind, {
      isOrchestrator: isOrch,
    });
    if (isOrch) {
      return {
        ...role,
        roleKind: "orchestrator",
        takesOrdersFrom: null,
        reportsTo: null,
      };
    }
    const orders = normalizeBossId(role.takesOrdersFrom);
    const reports = normalizeBossId(role.reportsTo);
    const ordersOk = orders && roleIds.has(orders) && orders !== role.id;
    const reportsOk = reports && roleIds.has(reports) && reports !== role.id;
    return {
      ...role,
      roleKind: roleKind === "orchestrator" ? "manager" : roleKind,
      takesOrdersFrom: ordersOk ? orders : orch,
      reportsTo: reportsOk ? reports : orch,
    };
  });

  return {
    ...template,
    orchestratorRoleId: orch,
    roles: fixed,
  };
}

export function rolesOfKind(template, kind) {
  return (template?.roles || []).filter(
    (r) => normalizeRoleKind(r.roleKind) === kind
  );
}

/** Who a role may DELEGATE to (out-edges on the kind graph). */
export function delegateCandidates(template, roleId) {
  const role = roleById(template, roleId);
  if (!role) return [];
  const kind = normalizeRoleKind(role.roleKind, {
    isOrchestrator: roleId === template.orchestratorRoleId,
  });
  const reports = directReports(template, roleId);
  if (kind === "orchestrator") {
    const managers = reports.filter(
      (r) => normalizeRoleKind(r.roleKind) === "manager"
    );
    return managers.length ? managers : reports;
  }
  if (kind === "manager") {
    const executors = reports.filter(
      (r) => normalizeRoleKind(r.roleKind) === "executor"
    );
    return executors.length
      ? executors
      : reports.filter((r) => normalizeRoleKind(r.roleKind) !== "evaluator");
  }
  // executor → evaluator (forced); evaluator → manager (forced)
  return [];
}

/** Manager's upward report target (orchestrator / boss). */
export function reportUpTarget(template, roleId) {
  const role = roleById(template, roleId);
  if (!role) return null;
  const kind = normalizeRoleKind(role.roleKind, {
    isOrchestrator: roleId === template.orchestratorRoleId,
  });
  if (kind !== "manager") return null;
  const bossId = normalizeBossId(role.reportsTo);
  if (!bossId) return null;
  const boss = roleById(template, bossId);
  if (!boss) return null;
  const bossKind = normalizeRoleKind(boss.roleKind, {
    isOrchestrator: bossId === template.orchestratorRoleId,
  });
  if (bossKind === "orchestrator" || bossKind === "manager") return boss;
  return boss;
}

/**
 * Who gave this executor the order / task.
 * Progress reports at intervals go here — always takesOrdersFrom, never the evaluator.
 */
export function orderGiverForExecutor(template, executorId) {
  const ex = roleById(template, executorId);
  if (!ex || normalizeRoleKind(ex.roleKind) !== "executor") return null;
  const id = normalizeBossId(ex.takesOrdersFrom);
  if (!id) return null;
  return roleById(template, id) || null;
}

/** Evaluator that should gate this executor before the manager sees the work */
export function evaluatorForExecutor(template, executorId) {
  const ex = roleById(template, executorId);
  if (!ex || normalizeRoleKind(ex.roleKind) !== "executor") return null;
  // Prefer reportsTo if that role is an evaluator
  const viaReports = roleById(template, normalizeBossId(ex.reportsTo));
  if (viaReports && normalizeRoleKind(viaReports.roleKind) === "evaluator") {
    return viaReports;
  }
  // Else evaluator who shares the same manager (takesOrdersFrom)
  const managerId = normalizeBossId(ex.takesOrdersFrom);
  const pool = rolesOfKind(template, "evaluator").filter(
    (e) =>
      normalizeBossId(e.takesOrdersFrom) === managerId ||
      normalizeBossId(e.reportsTo) === managerId
  );
  return pool[0] || rolesOfKind(template, "evaluator")[0] || null;
}

export function applySettingsToTemplate(template, settings, profiles = []) {
  const roleProfiles = settings?.roleProfiles || {};
  const byId = Object.fromEntries((profiles || []).map((p) => [p.id, p]));
  const base = normalizeOrgChart({
    ...template,
    orchestratorRoleId:
      settings?.orchestratorRoleId || template.orchestratorRoleId,
  });
  const roles = (base.roles || []).map((role) => {
    const ov = roleProfiles[role.id] || {};
    const candidates = [
      ov.hermesProfile,
      role.hermesProfile,
      settings?.parentProfile,
      "default",
    ].filter(Boolean);
    // Prefer a spawnable profile — never leave a role-id (swe/designer/…) as hermesProfile
    let hermesProfile =
      candidates.find((id) => byId[id]) ||
      candidates.find((id) => id === "default") ||
      candidates[0] ||
      "default";
    const live = byId[hermesProfile];
    return {
      ...role,
      hermesProfile,
      provider: live?.provider || ov.provider || "unknown",
      model: live?.model || ov.model || "unknown",
    };
  });
  return {
    ...base,
    roles,
  };
}

const SKINS = [
  ["#c62828", "#212121"],
  ["#1565c0", "#37474f"],
  ["#ef6c00", "#4e342e"],
  ["#2e7d32", "#1b5e20"],
  ["#00838f", "#004d40"],
  ["#6d4c41", "#3e2723"],
  ["#455a64", "#263238"],
  ["#ad1457", "#4a148c"],
];

export function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || `role-${Math.random().toString(36).slice(2, 8)}`;
}

/** Allocate a free desk tile in eng-bay-ish area */
export function nextHome(template) {
  const used = new Set(
    (template.roles || []).map((r) => `${r.home?.[0]},${r.home?.[1]}`)
  );
  for (let row = 6; row <= 11; row++) {
    for (let col = 1; col <= 10; col++) {
      const key = `${col},${row}`;
      if (!used.has(key)) return [col, row];
    }
  }
  return [5, 8];
}

export function makeRole(
  template,
  { title, department, description, hermesProfile, roleKind }
) {
  const id = slugify(title);
  const existing = new Set((template.roles || []).map((r) => r.id));
  let finalId = id;
  let n = 2;
  while (existing.has(finalId)) {
    finalId = `${id}-${n++}`;
  }
  const home = nextHome(template);
  const desk = `desk-${finalId}`;
  const skin = SKINS[(template.roles || []).length % SKINS.length];
  const boss = template.orchestratorRoleId || null;
  const kind = normalizeRoleKind(roleKind || "executor");
  return {
    id: finalId,
    title: title.trim() || finalId,
    department: department.trim() || "General",
    description: (description || "").trim(),
    hermesProfile: hermesProfile || "default",
    roleKind: kind === "orchestrator" ? "executor" : kind,
    skin: skin[0],
    hair: skin[1],
    desk,
    home,
    takesOrdersFrom: boss,
    reportsTo: boss,
  };
}

/** Normalize empty / "board" to null */
export function normalizeBossId(value) {
  if (value == null || value === "" || value === "board") return null;
  return String(value);
}

export function roleById(template, id) {
  if (!id) return null;
  return (template?.roles || []).find((r) => r.id === id) || null;
}

export function roleTitle(template, id) {
  if (!id) return "Board";
  return roleById(template, id)?.title || id;
}

/** Roles that take orders from managerId (null = board). */
export function directReports(template, managerId) {
  const mid = normalizeBossId(managerId);
  return (template?.roles || []).filter(
    (r) => normalizeBossId(r.takesOrdersFrom) === mid && r.id !== mid
  );
}

/**
 * Clear dangling boss refs after a role is removed.
 * Non-orchestrator roles get `fallbackBoss` (usually the board target).
 */
export function scrubOrgRefs(roles, removedId, fallbackBoss = null) {
  return (roles || []).map((r) => {
    let takesOrdersFrom = normalizeBossId(r.takesOrdersFrom);
    let reportsTo = normalizeBossId(r.reportsTo);
    if (takesOrdersFrom === removedId) takesOrdersFrom = null;
    if (reportsTo === removedId) reportsTo = null;
    if (r.id === fallbackBoss) {
      return { ...r, takesOrdersFrom: null, reportsTo: null };
    }
    return {
      ...r,
      takesOrdersFrom: takesOrdersFrom || fallbackBoss,
      reportsTo: reportsTo || fallbackBoss,
    };
  });
}
