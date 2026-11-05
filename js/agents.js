/** Employees: movement + avatar styles */

import {
  drawAvatarSprite,
  swatchForStyle,
  dinoKindForIndex,
  AVATAR_SIZE,
} from "./avatars.js?v=bubble-click-4";

export function createAgents(template, { avatarStyle = "robot" } = {}) {
  const agents = template.roles.map((role, index) => {
    const home = Array.isArray(role.home) ? role.home : [2, 3];
    return {
      id: role.id,
      title: role.title,
      department: role.department,
      description: role.description || "",
      hermesProfile: role.hermesProfile,
      model: role.model || "from-profile",
      provider: role.provider || "from-profile",
      desk: role.desk,
      skin: role.skin || "#c62828",
      hair: role.hair || "#212121",
      roleKind: role.roleKind || "executor",
      takesOrdersFrom: role.takesOrdersFrom ?? null,
      reportsTo: role.reportsTo ?? null,
      dinoKind: role.dinoKind || dinoKindForIndex(index),
      home,
      col: home[0],
      row: home[1],
      targetCol: home[0],
      targetRow: home[1],
      path: [],
      progress: 0,
      status: "idle",
      bubble: null,
      bubbleUntil: 0,
      stickyBubble: false,
      bubbleAction: null,
      bubbleKind: null,
      bob: Math.random() * Math.PI * 2,
      _index: index,
    };
  });

  let style = avatarStyle;

  function byId(id) {
    return agents.find((a) => a.id === id);
  }

  function setStatus(id, status) {
    const a = byId(id);
    if (a) a.status = status;
  }

  function setAvatarStyle(next) {
    style = next || "robot";
  }

  function walkTo(id, tile, office) {
    const a = byId(id);
    if (!a || !tile || !office?.pathBetween) return;
    const dest = [Math.round(Number(tile[0])), Math.round(Number(tile[1]))];
    if (!dest.every(Number.isFinite)) return;
    const from = [Math.round(a.col), Math.round(a.row)];
    // Already there — nothing to animate
    if (from[0] === dest[0] && from[1] === dest[1]) {
      a.path = [];
      a.progress = 0;
      return;
    }
    a.path = office.pathBetween(from, dest);
    a.progress = 0;
    if (a.path.length) {
      a.status = a.status === "talking" ? "talking" : "working";
    }
  }

  function say(id, text, durationMs = 2800) {
    const a = byId(id);
    if (!a) return;
    a.bubble = text;
    a.bubbleUntil = performance.now() + durationMs;
    a.stickyBubble = false;
    a.bubbleAction = null;
    a.bubbleKind = null;
    a.status = "talking";
  }

  /** Persistent clickable bubble (e.g. green check → respond to board) */
  function saySticky(id, text, action = null, kind = null) {
    const a = byId(id);
    if (!a) return;
    a.bubble = text;
    a.bubbleUntil = Infinity;
    a.stickyBubble = true;
    a.bubbleAction = action;
    a.bubbleKind = kind;
    a.status = "talking";
  }

  function clearBubble(id) {
    const a = byId(id);
    if (!a) return;
    a.bubble = null;
    a.bubbleUntil = 0;
    a.stickyBubble = false;
    a.bubbleAction = null;
    a.bubbleKind = null;
    if (a.status === "talking") a.status = a.path.length ? "working" : "idle";
  }

  function update(dt) {
    const now = performance.now();
    for (const a of agents) {
      a.bob += dt * 0.004;
      if (a.bubble && !a.stickyBubble && now > a.bubbleUntil) clearBubble(a.id);

      if (!a.path.length) continue;
      // ~3× former speed — tiles clear in roughly a blink
      a.progress += dt * 0.0065;
      while (a.progress >= 1 && a.path.length) {
        const [nc, nr] = a.path.shift();
        a.col = nc;
        a.row = nr;
        a.progress -= 1;
      }
      if (a.path.length) {
        const [nc, nr] = a.path[0];
        a.col = a.col + (nc - a.col) * Math.min(1, a.progress);
        a.row = a.row + (nr - a.row) * Math.min(1, a.progress);
      } else if (a.status === "working") {
        a.status = "idle";
      }
    }
  }

  function drawAll(ctx, office) {
    const sorted = [...agents].sort((a, b) => a.col + a.row - (b.col + b.row));
    const anchors = {};
    for (const a of sorted) {
      anchors[a.id] = drawAvatarSprite(ctx, a, office, style, a._index);
    }
    return anchors;
  }

  /** Pick nearest agent under a canvas-local point (logical px). */
  function hitTest(localX, localY, office) {
    const s = (office.avatarScale || 1) * AVATAR_SIZE;
    const radius = Math.max(30, 34 * s);
    let best = null;
    let bestDist = radius;
    for (const a of agents) {
      const { x, y } = office.screenOf(a.col, a.row);
      const ax = x;
      const ay = y - 26 * s;
      const dx = localX - ax;
      const dy = localY - ay;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) {
        bestDist = d;
        best = a;
      }
    }
    return best;
  }

  return {
    list: agents,
    byId,
    setStatus,
    setAvatarStyle,
    walkTo,
    say,
    saySticky,
    clearBubble,
    update,
    drawAll,
    hitTest,
    getAvatarStyle: () => style,
  };
}

export function swatchDataUrl(skin, hair, styleId = "minecraft", index = 0) {
  return swatchForStyle(skin, hair, styleId, index);
}
