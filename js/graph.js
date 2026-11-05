/**
 * Org-graph view — the communication graph as a first-class second view.
 *
 * Renders roles + their real edges (orders / reports / QC) as an SVG tree
 * over the same stage, kept live against agent statuses and recent
 * comms events. Complements the isometric office; toggled from the stage.
 */

import {
  normalizeBossId,
  normalizeRoleKind,
  roleKindLabel,
  evaluatorForExecutor,
} from "./registry.js?v=state-history-1";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_W = 200;
const NODE_H = 74;
const GAP_X = 56;
const GAP_Y = 128;
const ROW_ORDER = ["orchestrator", "manager", "executor", "evaluator"];
const BOARD_LIVE_MS = 4000;

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

/** Clip the segment center→center at the box border. */
function edgePoints(a, b) {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const t1 = borderT(a, dx, dy);
  const t2 = borderT(b, -dx, -dy);
  return {
    x1: a.cx + dx * t1,
    y1: a.cy + dy * t1,
    x2: b.cx - dx * t2,
    y2: b.cy - dy * t2,
  };
}

function borderT(n, dx, dy) {
  const tx = Math.abs(dx) > 1e-6 ? NODE_W / 2 / Math.abs(dx) : Infinity;
  const ty = Math.abs(dy) > 1e-6 ? NODE_H / 2 / Math.abs(dy) : Infinity;
  return Math.min(1, tx, ty);
}

export function createGraphView(hostEl, template, { onNodeClick = null } = {}) {
  if (!hostEl) return null;
  hostEl.innerHTML = "";

  const svg = el("svg", {
    class: "orggraph",
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label": "Organization graph view",
  });
  hostEl.appendChild(svg);
  const legend = document.createElement("p");
  legend.className = "orggraph__legend";
  legend.innerHTML = `
    <span><i class="gedge-key gedge-key--orders"></i> gives orders</span>
    <span><i class="gedge-key gedge-key--reports"></i> reports up</span>
    <span><i class="gedge-key gedge-key--qc"></i> QC</span>
    <span>Same row can talk: managers with managers, executors with the executors under their manager.</span>
  `;
  hostEl.appendChild(legend);
  const edgesLayer = el("g", { class: "orggraph__edges" }, svg);
  const nodesLayer = el("g", { class: "orggraph__nodes" }, svg);

  const orchId = template.orchestratorRoleId;
  const nodes = new Map(); // id -> { role, kind, x, y, cx, cy, g, dot, text... }

  // Board is a virtual node at the top (endpoint of every graph).
  nodes.set("board", {
    id: "board",
    label: "Board",
    kind: "board",
    isBoard: true,
    g: null,
  });

  for (const role of template.roles || []) {
    const kind = normalizeRoleKind(role.roleKind, {
      isOrchestrator: role.id === orchId,
    });
    nodes.set(role.id, { id: role.id, role, kind, isBoard: false });
  }

  // Bucket by row, skip empty kinds
  const rows = ROW_ORDER.filter((k) =>
    [...nodes.values()].some((n) => !n.isBoard && n.kind === k)
  );
  const maxPerRow = Math.max(1, ...rows.map(
    (k) => [...nodes.values()].filter((n) => !n.isBoard && n.kind === k).length
  ));
  const width = maxPerRow * (NODE_W + GAP_X) + 80;
  const height = (rows.length + 1) * GAP_Y + NODE_H + 60;

  // Board centered on its own row
  {
    const b = nodes.get("board");
    b.x = (width - NODE_W) / 2;
    b.y = 24;
    b.cx = b.x + NODE_W / 2;
    b.cy = b.y + NODE_H / 2;
  }
  rows.forEach((k, ri) => {
    const list = [...nodes.values()].filter((n) => !n.isBoard && n.kind === k);
    const w = list.length * (NODE_W + GAP_X) - GAP_X;
    const startX = (width - w) / 2;
    list.forEach((n, i) => {
      n.x = startX + i * (NODE_W + GAP_X);
      n.y = 24 + (ri + 1) * GAP_Y;
      n.cx = n.x + NODE_W / 2;
      n.cy = n.y + NODE_H / 2;
    });
  });

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  // —— Edges from the org data ——
  const edges = []; // {key, line, from, to, kind: orders|reports|qc}
  function addEdge(fromNode, toNode, kind) {
    if (!fromNode || !toNode) return;
    const key = `${fromNode.id}->${toNode.id}:${kind}`;
    if (edges.some((e) => e.key === key)) return;
    const line = el("path", { class: `gedge gedge--${kind}` }, edgesLayer);
    const { x1, y1, x2, y2 } = edgePoints(fromNode, toNode);
    const midY = (y1 + y2) / 2;
    const bow = kind === "reports" ? 28 : kind === "qc" ? -28 : 0;
    line.setAttribute(
      "d",
      `M ${x1} ${y1} C ${x1 + bow} ${midY}, ${x2 + bow} ${midY}, ${x2} ${y2}`
    );
    edges.push({ key, line, from: fromNode.id, to: toNode.id, kind });
  }

  const resolve = (id) =>
    !id || id === "you" ? nodes.get("board") : nodes.get(id);

  for (const n of nodes.values()) {
    if (n.isBoard) continue;
    if (n.kind === "orchestrator") {
      addEdge(n, nodes.get("board"), "reports"); // ⇄ board line
      continue;
    }
    const orders = normalizeBossId(n.role.takesOrdersFrom) || "board";
    const reports = normalizeBossId(n.role.reportsTo) || "board";
    if (orders === "board") addEdge(nodes.get("board"), n, "orders");
    else addEdge(resolve(orders), n, "orders");
    if (reports === "board") addEdge(n, nodes.get("board"), "reports");
    else if (reports !== orders) addEdge(n, resolve(reports), "reports");
    if (n.kind === "executor") {
      const ev = evaluatorForExecutor(template, n.id);
      // reportsTo already draws this hop when the evaluator is the report target
      if (ev && ev.id !== reports) addEdge(n, nodes.get(ev.id), "qc");
    }
  }

  // —— Nodes ——
  for (const n of nodes.values()) {
    const g = el("g", {
      class: "gnode" + (n.isBoard ? " gnode--board" : ` gnode--${n.kind}`),
      transform: `translate(${n.x},${n.y})`,
      tabindex: "0",
      role: "button",
    }, nodesLayer);
    if (!n.isBoard) {
      g.setAttribute("aria-label", n.role.title);
      g.addEventListener("click", () => onNodeClick?.(n.id));
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onNodeClick?.(n.id);
        }
      });
    }
    // Board fill/stroke/text are set as SVG attrs so theme CSS cannot ghost the node.
    if (n.isBoard) {
      el(
        "rect",
        {
          class: "gnode__card",
          width: NODE_W,
          height: NODE_H,
          rx: 10,
          fill: "#1a2430",
          stroke: "#0b1220",
          "stroke-width": "2.5",
          "stroke-dasharray": "0",
        },
        g
      );
    } else {
      el("rect", { class: "gnode__card", width: NODE_W, height: NODE_H, rx: 10 }, g);
      el("rect", {
        class: "gnode__stripe",
        width: 6,
        height: NODE_H - 2,
        x: 1,
        y: 1,
        rx: 3,
        fill: n.role.skin || "var(--accent)",
      }, g);
    }
    const title = el("text", {
      class: "gnode__title",
      x: n.isBoard ? NODE_W / 2 : 18,
      y: 24,
      ...(n.isBoard
        ? { fill: "#ffffff", "text-anchor": "middle", "font-weight": "700" }
        : {}),
    }, g);
    title.textContent = n.isBoard ? "BOARD (you)" : n.role.title;
    const meta = el("text", {
      class: "gnode__meta",
      x: n.isBoard ? NODE_W / 2 : 18,
      y: 41,
      ...(n.isBoard
        ? { fill: "#c8d2de", "text-anchor": "middle" }
        : {}),
    }, g);
    meta.textContent = n.isBoard
      ? "talk to the orchestrator"
      : `${roleKindLabel(n.kind)} · ${n.role.hermesProfile || "default"}`;
    const line = el("text", {
      class: "gnode__bubble",
      x: n.isBoard ? NODE_W / 2 : 18,
      y: 59,
      ...(n.isBoard
        ? { fill: "#9eb0c2", "text-anchor": "middle" }
        : {}),
    }, g);
    const dot = n.isBoard
      ? null
      : el("circle", { class: "gnode__status", cx: NODE_W - 14, cy: 14, r: 5 }, g);
    const check = n.isBoard
      ? null
      : el("text", { class: "gnode__check", x: NODE_W - 18, y: NODE_H - 16 }, g);
    if (check) check.textContent = "✓";
    const bar = n.isBoard
      ? null
      : el("rect", {
          class: "gnode__bar",
          x: 16,
          y: NODE_H - 8,
          width: 0,
          height: 4,
          rx: 2,
        }, g);
    n.g = g;
    n.dot = dot;
    n.line = line;
    n.check = check;
    n.bar = bar;
  }

  function update(agents, events, nowMs) {
    for (const n of nodes.values()) {
      if (n.isBoard) continue;
      const a = agents?.byId?.(n.id);
      if (!a || !n.g) continue;
      const status = a.bubble && a.stickyBubble ? "talking" : a.status;
      if (n.g.dataset.status !== status) {
        n.g.dataset.status = status;
      }
      const bubbleText = a.bubble || "";
      const prefix = a.stickyBubble && a.bubbleAction ? "✓ " : "";
      const wanted = bubbleText ? (prefix + String(bubbleText)).slice(0, 34) : "";
      if (n.line.textContent !== wanted) n.line.textContent = wanted;
      const showCheck = Boolean(a.stickyBubble && a.bubbleAction);
      n.check.classList.toggle("is-on", showCheck);
      if (n.bar) {
        const deskWork = n.kind === "executor" && status === "working" && !a.path?.length;
        n.g.classList.toggle("is-desk-working", deskWork);
        const t = deskWork ? ((a.workMs || 0) % 6500) / 6500 : 0;
        n.bar.setAttribute("width", String(deskWork ? Math.max(8, (NODE_W - 32) * (0.18 + t * 0.82)) : 0));
      }
    }
    // Pulse the edges that carried a message in the last few seconds
    const live = new Set();
    for (const e of events || []) {
      if (nowMs - e._wall > BOARD_LIVE_MS) continue;
      const fromId = !e.from || e.from === "you" || e.from === "system" ? "board" : e.from;
      const toId = !e.to || e.to === "you" ? "board" : e.to;
      live.add(`${fromId}->${toId}`);
      live.add(`${toId}->${fromId}`);
    }
    for (const e of edges) {
      const on = live.has(`${e.from}->${e.to}`);
      e.line.classList.toggle("is-live", on);
    }
  }

  return {
    el: svg,
    update,
    destroy() {
      hostEl.innerHTML = "";
    },
  };
}
