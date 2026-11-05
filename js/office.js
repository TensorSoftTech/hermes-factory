/** Isometric office — 1TNT-style: walls, windows, cream floor, wood desks */

const BASE_TILE_W = 54;

export function tileToScreen(col, row, originX, originY, tileW = 54, tileH = 27) {
  const x = originX + (col - row) * (tileW / 2);
  const y = originY + (col + row) * (tileH / 2);
  return { x, y };
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function mixHex(a, b, t) {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return a;
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

function parseHex(hex) {
  if (!hex) return null;
  if (hex.startsWith("rgb")) {
    const m = hex.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  const n = hex.replace("#", "");
  const full = n.length === 3 ? n.split("").map((c) => c + c).join("") : n.slice(0, 6);
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return null;
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function roomFloorColor(room, i) {
  const creams = ["#f2ece4", "#efe9e1", "#ece6de", "#f0ebe3", "#e9f0e8", "#eee8e0"];
  const base = creams[i % creams.length];
  if (!room?.floor) return base;
  return mixHex(room.floor, base, 0.88);
}

function measureHost(canvas) {
  const host = canvas.parentElement;
  const w = Math.floor(host?.clientWidth || canvas.clientWidth || 960);
  const h = Math.floor(host?.clientHeight || canvas.clientHeight || 640);
  return {
    w: Math.max(480, w),
    h: Math.max(360, h),
  };
}

export function createOffice(canvas, template) {
  const ctx = canvas.getContext("2d");

  const maxCol = Math.max(
    2,
    ...(template.rooms || []).map((r) => r.origin[0] + r.size[0]),
    ...(template.desks || []).map((d) => d.tile[0])
  );
  const maxRow = Math.max(
    2,
    ...(template.rooms || []).map((r) => r.origin[1] + r.size[1]),
    ...(template.desks || []).map((d) => d.tile[1])
  );

  const minCol = Math.min(
    0,
    ...(template.rooms || []).map((r) => r.origin[0]),
    ...(template.desks || []).map((d) => d.tile[0])
  );
  const minRow = Math.min(
    0,
    ...(template.rooms || []).map((r) => r.origin[1]),
    ...(template.desks || []).map((d) => d.tile[1])
  );

  let TILE_W = 72;
  let TILE_H = 36;
  let originX = 0;
  let originY = 0;
  let avatarScale = 1;
  let dpr = 1;
  let wallH = 48;

  function layout() {
    const { w: availW, h: availH } = measureHost(canvas);
    const gridDiag = maxCol + maxRow + 2;
    const padX = 36;
    const padTop = 56;
    const padBottom = 32;

    const tileFromW = ((availW - padX * 2) * 2) / gridDiag;
    const tileFromH = ((availH - padTop - padBottom) * 2) / gridDiag;
    TILE_W = Math.floor(Math.min(tileFromW, tileFromH * 2));
    TILE_W = Math.max(64, Math.min(140, TILE_W));
    TILE_H = Math.floor(TILE_W / 2);
    avatarScale = TILE_W / BASE_TILE_W;
    wallH = Math.round(38 * avatarScale);

    dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.floor(availW * dpr);
    canvas.height = Math.floor(availH * dpr);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;

    const contentH = gridDiag * (TILE_H / 2) + wallH;
    originX = Math.floor(availW / 2);
    originY = padTop;
    if (originY + contentH > availH - padBottom) {
      originY = Math.max(28, availH - padBottom - contentH);
    }
  }

  layout();

  function screen(col, row) {
    return tileToScreen(col, row, originX, originY, TILE_W, TILE_H);
  }

  function clientToLocal(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * (canvas.width / dpr);
    const y = ((clientY - rect.top) / rect.height) * (canvas.height / dpr);
    return { x, y };
  }

  function drawDiamond(x, y, fill, stroke = null) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + TILE_W / 2, y + TILE_H / 2);
    ctx.lineTo(x, y + TILE_H);
    ctx.lineTo(x - TILE_W / 2, y + TILE_H / 2);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(0.6, 0.8 / dpr);
      ctx.stroke();
    }
  }

  function drawBlock(col, row, top, sideL, sideR, h = 14) {
    const bh = h * avatarScale;
    const { x, y } = screen(col, row);
    ctx.beginPath();
    ctx.moveTo(x - TILE_W / 2, y + TILE_H / 2 - bh);
    ctx.lineTo(x, y + TILE_H - bh);
    ctx.lineTo(x, y + TILE_H);
    ctx.lineTo(x - TILE_W / 2, y + TILE_H / 2);
    ctx.closePath();
    ctx.fillStyle = sideL;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + TILE_W / 2, y + TILE_H / 2 - bh);
    ctx.lineTo(x, y + TILE_H - bh);
    ctx.lineTo(x, y + TILE_H);
    ctx.lineTo(x + TILE_W / 2, y + TILE_H / 2);
    ctx.closePath();
    ctx.fillStyle = sideR;
    ctx.fill();
    drawDiamond(x, y - bh, top, "rgba(0,0,0,0.14)");
  }

  function roomAt(col, row) {
    return (template.rooms || []).find(
      (r) =>
        col >= r.origin[0] &&
        col < r.origin[0] + r.size[0] &&
        row >= r.origin[1] &&
        row < r.origin[1] + r.size[1]
    );
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /**
   * Window pane inset on a wall face — same parallelogram angle as the wall.
   * Face: bottom (x0,y0)→(x1,y1), top raised by wallH.
   * u along length, v up the wall (0=floor, 1=top).
   */
  function drawWindowOnFace(x0, y0, x1, y1, { u0 = 0.16, u1 = 0.84, v0 = 0.2, v1 = 0.78 } = {}) {
    const blx = lerp(x0, x1, u0);
    const bly = lerp(y0, y1, u0);
    const brx = lerp(x0, x1, u1);
    const bry = lerp(y0, y1, u1);
    const pBlx = blx;
    const pBly = bly - wallH * v0;
    const pBrx = brx;
    const pBry = bry - wallH * v0;
    const pTrx = brx;
    const pTry = bry - wallH * v1;
    const pTlx = blx;
    const pTly = bly - wallH * v1;

    const grad = ctx.createLinearGradient(pTlx, pTly, pBlx, pBly);
    grad.addColorStop(0, "#8fd0f5");
    grad.addColorStop(0.55, "#b9e4ff");
    grad.addColorStop(1, "#d7f0ff");
    ctx.beginPath();
    ctx.moveTo(pTlx, pTly);
    ctx.lineTo(pTrx, pTry);
    ctx.lineTo(pBrx, pBry);
    ctx.lineTo(pBlx, pBly);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.strokeStyle = "rgba(70,100,120,0.35)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
    const mx0 = lerp(pTlx, pTrx, 0.5);
    const my0 = lerp(pTly, pTry, 0.5);
    const mx1 = lerp(pBlx, pBrx, 0.5);
    const my1 = lerp(pBly, pBry, 0.5);
    const hx0 = lerp(pTlx, pBlx, 0.5);
    const hy0 = lerp(pTly, pBly, 0.5);
    const hx1 = lerp(pTrx, pBrx, 0.5);
    const hy1 = lerp(pTry, pBry, 0.5);
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mx0, my0);
    ctx.lineTo(mx1, my1);
    ctx.moveTo(hx0, hy0);
    ctx.lineTo(hx1, hy1);
    ctx.stroke();
  }

  function paintWallFace(x0, y0, x1, y1, { fill, edge, glass, window }) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x1, y1 - wallH);
    ctx.lineTo(x0, y0 - wallH);
    ctx.closePath();
    if (glass) {
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = "#a8d0e4";
      ctx.fill();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = "rgba(110,140,160,0.7)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.stroke();
    if (window) {
      drawWindowOnFace(x0, y0, x1, y1);
    }
  }

  /** NW-facing wall segment (back wall) along increasing col at fixed row */
  function drawWallNorth(col0, row, len, { fill = "#d8d2ca", edge = "#b9b2a8", glass = false, window = false } = {}) {
    for (let i = 0; i < len; i++) {
      const col = col0 + i;
      const a = screen(col, row);
      const b = screen(col + 1, row);
      paintWallFace(a.x, a.y, b.x, b.y, {
        fill,
        edge,
        glass,
        window: window && i % 2 === 0,
      });
    }
  }

  /** NE-facing wall segment along increasing row at fixed col */
  function drawWallWest(col, row0, len, { fill = "#cfc8bf", edge = "#aea79e", glass = false, window = false } = {}) {
    for (let i = 0; i < len; i++) {
      const row = row0 + i;
      const a = screen(col, row);
      const b = screen(col, row + 1);
      paintWallFace(a.x, a.y, b.x, b.y, {
        fill,
        edge,
        glass,
        window: window && i % 2 === 1,
      });
    }
  }

  function drawPlant(x, y, s, big = false) {
    const scale = big ? 1.4 : 1;
    ctx.fillStyle = "#8d6e4c";
    ctx.fillRect(x - 3 * scale, y, 6 * scale, 5 * scale);
    ctx.fillStyle = "#3d8f4a";
    ctx.beginPath();
    ctx.ellipse(x, y - 3 * scale, 6.5 * scale * Math.min(1, s * 0.7), 5 * scale * Math.min(1, s * 0.65), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#2e6b38";
    ctx.beginPath();
    ctx.ellipse(x - 4 * scale, y - 1 * scale, 4 * scale, 3 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawFloor() {
    const accent = cssVar("--accent", "#3d7ab8");
    const panelBorder = cssVar("--panel-border", "#c5d0dc");
    const { w: availW, h: availH } = measureHost(canvas);

    const roomColors = new Map();
    (template.rooms || []).forEach((room, i) => {
      roomColors.set(room.id, roomFloorColor(room, i));
    });

    ctx.clearRect(0, 0, availW, availH);

    // Soft cream stage (outside the building)
    const g = ctx.createRadialGradient(
      availW * 0.5,
      availH * 0.15,
      10,
      availW / 2,
      availH * 0.55,
      Math.max(availW, availH) * 0.85
    );
    g.addColorStop(0, "#f6f1ea");
    g.addColorStop(0.55, "#ebe4da");
    g.addColorStop(1, "#ddd4c8");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, availW, availH);

    const pad = 1;
    const floorMinC = minCol - pad;
    const floorMaxC = maxCol + pad;
    const floorMinR = minRow - pad;
    const floorMaxR = maxRow + pad;

    // Floor tiles — nearly white cream with faint checker (1TNT)
    for (let row = floorMinR; row <= floorMaxR; row++) {
      for (let col = floorMinC; col <= floorMaxC; col++) {
        const room = roomAt(col, row);
        const { x, y } = screen(col, row);
        const inside =
          col >= minCol && col <= maxCol && row >= minRow && row <= maxRow;
        if (!inside && !room) continue;
        if (room) {
          const base = roomColors.get(room.id) || "#f0ebe3";
          const a = (col + row) % 2 === 0 ? base : mixHex(base, "#e2dbd2", 0.35);
          drawDiamond(x, y, a, "rgba(120,110,100,0.06)");
        } else {
          const hall = (col + row) % 2 === 0 ? "#ece7df" : "#e5dfd6";
          drawDiamond(x, y, hall, "rgba(110,100,90,0.05)");
        }
      }
    }

    // —— Perimeter walls (back first) ——
    const wallFillN = "#e4dfd7";
    const wallFillW = "#d5d0c8";
    drawWallNorth(floorMinC, floorMinR, floorMaxC - floorMinC, {
      fill: wallFillN,
      edge: "#c2bbb2",
    });
    drawWallWest(floorMinC, floorMinR, floorMaxR - floorMinR, {
      fill: wallFillW,
      edge: "#b5aea5",
    });
    // Window wall (east / high-col)
    drawWallWest(floorMaxC, floorMinR, floorMaxR - floorMinR, {
      fill: "#ddd8d0",
      edge: "#b8b1a8",
      window: true,
    });
    // Front-ish south wall lower opacity so we see into the room
    drawWallNorth(floorMinC, floorMaxR, floorMaxC - floorMinC, {
      fill: "#ebe6de",
      edge: "#c9c2b9",
    });

    // Zone labels
    for (const room of template.rooms || []) {
      const text = String(room.label || "").toUpperCase();
      if (!text) continue;
      const ax = room.origin[0] + Math.min(1.2, room.size[0] * 0.32);
      const ay = room.origin[1] + Math.min(1.1, room.size[1] * 0.32);
      const { x, y } = screen(ax, ay);
      const angle = Math.atan2(TILE_H / 2, TILE_W / 2);
      const fontPx = Math.max(9, Math.min(15, Math.round(TILE_W * 0.14)));
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.font = `600 ${fontPx}px 'IBM Plex Sans', sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = "#6a635a";
      ctx.fillText(text, 1, 0);
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = "#4f4943";
      ctx.fillText(text, 0, -1);
      ctx.restore();
    }

    // Glass CEO suite
    const suite =
      (template.rooms || []).find((r) => /ceo|suite/i.test(r.id + r.label)) ||
      null;
    if (suite) {
      const [ox, oy] = suite.origin;
      const [sw, sh] = suite.size;
      drawWallNorth(ox, oy, sw, { glass: true });
      drawWallWest(ox, oy, sh, { glass: true });
      drawWallNorth(ox, oy + sh - 1, sw, { glass: true });
      drawWallWest(ox + sw - 1, oy, sh, { glass: true });
    }

    // Desks are painted after seated people so the laptop stays in front of them.

    // Zone corner plants only (don't clutter the desk grid)
    for (const room of template.rooms || []) {
      const spots = [
        [room.origin[0], room.origin[1]],
        [room.origin[0] + room.size[0] - 1, room.origin[1]],
      ];
      for (const [c, r] of spots) {
        const { x, y } = screen(c, r);
        drawPlant(x - 6, y + 2, avatarScale, true);
      }
    }

    ctx.strokeStyle = mixHex(panelBorder, "#cbbba8", 0.3);
    ctx.lineWidth = 2;
    ctx.strokeRect(8, 8, availW - 16, availH - 16);
  }

  /** Screen point with height. z is in tile units; 1 ≈ one tile-row tall. */
  function project(col, row, z = 0) {
    const p = screen(col, row);
    return { x: p.x, y: p.y - z * TILE_H };
  }

  function fillPoly(points, fill) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  /** Isometric box. w along col, d along row, h up. */
  function drawIsoBox(col, row, w, d, h, z0, top, left, right) {
    const p = (dc, dr, z) => project(col + dc, row + dr, z);
    const front = [p(0, d, z0), p(w, d, z0), p(w, d, z0 + h), p(0, d, z0 + h)];
    const side = [p(w, 0, z0), p(w, d, z0), p(w, d, z0 + h), p(w, 0, z0 + h)];
    const cap = [p(0, 0, z0 + h), p(w, 0, z0 + h), p(w, d, z0 + h), p(0, d, z0 + h)];
    fillPoly(front, left);
    fillPoly(side, right);
    fillPoly(cap, top);
  }

  /**
   * Worker stands behind the desk (smaller row = further from the camera),
   * looking at the laptop on the desktop.
   */
  function seatPoint(col, row) {
    // Just behind the desktop's back edge. Desk is painted after, so it
    // covers the legs and the head stays above the laptop.
    const back = project(col, row - 0.16, 0.42);
    return { x: back.x, y: back.y + 2 * avatarScale };
  }

  function drawDesks(litTiles) {
    const lit = litTiles instanceof Set ? litTiles : new Set();
    for (const desk of template.desks || []) {
      const [c, r] = desk.tile;
      const working = lit.has(`${Math.round(c)},${Math.round(r)}`);
      const ox = c - 0.42;
      const oy = r - 0.08;
      const woodT = "#d7a874";
      const woodL = "#a9784b";
      const woodR = "#bf8c5c";
      drawIsoBox(ox, oy, 0.08, 0.62, 0.46, 0, woodT, woodL, woodR);
      drawIsoBox(ox + 0.78, oy, 0.08, 0.62, 0.46, 0, woodT, woodL, woodR);
      drawIsoBox(ox, oy, 0.86, 0.62, 0.07, 0.46, woodT, woodL, woodR);

      const lx = ox + 0.18;
      const ly = oy + 0.1;
      drawIsoBox(lx, ly, 0.5, 0.34, 0.035, 0.53, "#8b93a3", "#4a5160", "#5d6576");

      const lid = [
        project(lx, ly + 0.32, 0.58),
        project(lx + 0.5, ly + 0.32, 0.58),
        project(lx + 0.5, ly + 0.32, 0.96),
        project(lx, ly + 0.32, 0.96),
      ];
      fillPoly(lid, working ? "#24362e" : "#3a3d45");
      if (working) {
        const glow = [
          project(lx + 0.06, ly + 0.32, 0.64),
          project(lx + 0.44, ly + 0.32, 0.64),
          project(lx + 0.44, ly + 0.32, 0.9),
          project(lx + 0.06, ly + 0.32, 0.9),
        ];
        fillPoly(glow, "#9ef0c4");
      }
      const logo = project(lx + 0.25, ly + 0.32, 0.78);
      ctx.beginPath();
      ctx.arc(logo.x, logo.y, Math.max(2.2, TILE_W * 0.045), 0, Math.PI * 2);
      if (working) {
        ctx.fillStyle = "#9ef0c4";
        ctx.shadowColor = "#36e08f";
        ctx.shadowBlur = 8;
      } else {
        ctx.fillStyle = "#555a66";
        ctx.shadowBlur = 0;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  /** Kept so older paint paths don't crash. Desks are drawn with the floor. */
  /** Bottom-right of the floor — the shared meeting / kanban table. */
  function kanbanTile() {
    return [Math.max(minCol + 1, maxCol - 1), Math.max(minRow + 1, maxRow - 1)];
  }

  function drawKanbanTable() {
    const [c, r] = kanbanTile();
    const ox = c - 0.55;
    const oy = r - 0.2;
    drawIsoBox(ox, oy, 1.15, 0.7, 0.08, 0.42, "#efe6d4", "#c4b49a", "#d7c7ae");
    const label = project(ox + 0.58, oy + 0.28, 0.62);
    ctx.save();
    ctx.font = `700 ${Math.max(9, Math.round(10 * avatarScale))}px "IBM Plex Sans", sans-serif`;
    ctx.fillStyle = "#5c5348";
    ctx.textAlign = "center";
    ctx.fillText("KANBAN", label.x, label.y - 2);
    ctx.font = `600 ${Math.max(8, Math.round(8 * avatarScale))}px "IBM Plex Sans", sans-serif`;
    ctx.fillText("click", label.x, label.y + 10 * avatarScale);
    ctx.restore();
    for (let i = 0; i < 3; i++) {
      const slip = project(ox + 0.28 + i * 0.28, oy + 0.22, 0.52);
      ctx.fillStyle = ["#d7e4c8", "#f3e2b8", "#e4d4ee"][i];
      ctx.fillRect(slip.x - 7, slip.y - 5, 14, 9);
    }
  }

  function hitKanban(localX, localY) {
    const [c, r] = kanbanTile();
    const p = screen(c, r);
    return Math.hypot(localX - p.x, localY - p.y) < TILE_W * 0.7;
  }

  function drawDeskFronts() {}

  function pathBetween(from, to) {
    const path = [];
    if (!from || !to) return path;
    let c = Math.round(Number(from[0]));
    let r = Math.round(Number(from[1]));
    const tc = Math.round(Number(to[0]));
    const tr = Math.round(Number(to[1]));
    if (![c, r, tc, tr].every(Number.isFinite)) return path;
    for (let i = 0; i < 64 && (c !== tc || r !== tr); i++) {
      if (c < tc) c += 1;
      else if (c > tc) c -= 1;
      else if (r < tr) r += 1;
      else if (r > tr) r -= 1;
      path.push([c, r]);
    }
    return path;
  }

  function resize() {
    layout();
    drawFloor();
  }

  return {
    drawFloor,
    drawDesks,
    drawDeskFronts,
    drawKanbanTable,
    kanbanTile,
    hitKanban,
    seatPoint,
    screenOf: (col, row) => screen(col, row),
    clientToLocal,
    pathBetween,
    resize,
    get originX() {
      return originX;
    },
    get originY() {
      return originY;
    },
    get TILE_W() {
      return TILE_W;
    },
    get TILE_H() {
      return TILE_H;
    },
    get avatarScale() {
      return avatarScale;
    },
    get dpr() {
      return dpr;
    },
  };
}
