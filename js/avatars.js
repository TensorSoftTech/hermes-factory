/** Avatar styles — native size, careful pixel shapes */

export const AVATAR_STYLES = [
  {
    id: "robot",
    name: "Robots",
    blurb: "Small capsule agents — 1TNT-style",
  },
  {
    id: "alien",
    name: "Aliens",
    blurb: "Big-eyed visitors from elsewhere",
  },
  {
    id: "minecraft",
    name: "Minecraft",
    blurb: "Blocky villagers with shirts + hair",
  },
  {
    id: "dinosaurs",
    name: "Dinosaurs",
    blurb: "T-Rex, Stego, Bronto, Trike, Raptor, Ptera",
  },
  {
    id: "gummy",
    name: "Gummy bears",
    blurb: "Soft candy bears — glossy, rounded, cute",
  },
];

/** Tiny on the floor so walls/desks dominate (1TNT scale) */
export const AVATAR_SIZE = 1.15;

/** Art pixel size — higher = chunkier, clearer shapes */
const PX = 2;

const DINO_KINDS = [
  "tyrannosaurus",
  "stegosaurus",
  "brontosaurus",
  "triceratops",
  "velociraptor",
  "pterodactyl",
];

export function dinoKindForIndex(i) {
  return DINO_KINDS[i % DINO_KINDS.length];
}

function r(ctx, x, y, w, h, fill) {
  ctx.fillStyle = fill;
  ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
}

function shadeHex(hex, amount) {
  const n = String(hex || "#888").replace("#", "");
  const full = n.length === 3 ? n.split("").map((c) => c + c).join("") : n.slice(0, 6);
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return hex;
  const rr = Math.min(255, Math.max(0, ((num >> 16) & 255) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 255) + amount));
  const b = Math.min(255, Math.max(0, (num & 255) + amount));
  return `rgb(${rr},${g},${b})`;
}

function label(ctx, px, py, title, accent) {
  ctx.font = "600 7px 'IBM Plex Sans', sans-serif";
  ctx.textAlign = "center";
  const text = title.length > 12 ? title.slice(0, 10) + "…" : title;
  const tw = Math.max(ctx.measureText(text).width + 6, 24);
  const top = py - 30;
  r(ctx, px - tw / 2, top, tw, 9, "rgba(0,0,0,0.78)");
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(px - tw / 2 + 0.5, top + 0.5, tw - 1, 8);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, px, top + 7);
}

function statusLamp(ctx, px, py, status) {
  const statusColor = {
    idle: "#90a4ae",
    working: "#4caf50",
    talking: "#e8a838",
    blocked: "#e57373",
    done: "#64b5f6",
  }[status] || "#90a4ae";
  r(ctx, px + 9, py - 18, 6, 6, "#111");
  r(ctx, px + 10, py - 17, 4, 4, statusColor);
}

function ground(ctx, px, footY) {
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath();
  ctx.ellipse(px, footY + 4, 18, 6, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Blit ASCII art at PX×PX cells. `.` = empty. */
function blit(ctx, ox, oy, rows, palette) {
  for (let j = 0; j < rows.length; j++) {
    const row = rows[j];
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === "." || ch === " ") continue;
      const fill = palette[ch];
      if (!fill) continue;
      r(ctx, ox + i * PX, oy + j * PX, PX, PX, fill);
    }
  }
}

function spriteSize(rows) {
  const w = Math.max(...rows.map((row) => row.length));
  return { w: w * PX, h: rows.length * PX };
}

function drawMinecraft(ctx, a, px, py, footY) {
  ground(ctx, px, footY);
  const S = a.skin;
  const Sd = shadeHex(S, -28);
  const Sl = shadeHex(S, 22);
  const H = a.hair || "#212121";
  const K = "#efc09a";
  const Kd = "#c48a6a";
  const P = "#263238";
  const Q = "#1a2226";

  // Classic Steve-ish proportions: head cube, torso, pants
  const sprite = [
    // head 8×8
    "..HHHHHHHH..",
    ".HHHHHHHHHH.",
    ".HHKKKKKKHH.",
    ".HKKKKKKKKH.",
    ".HK.KKKK.KH.",
    ".HKKKKKKKKH.",
    ".HKKKmmKKKH.",
    "..KKKKKKKK..",
    // torso + arms
    ".ALSSSSSSSB.",
    "AKLSSSSSSSBK",
    "AKSSSSSSSSBK",
    "AKSSSSSSSSBK",
    "AK.SSSSSS.BK",
    // legs
    "..PP....QQ..",
    "..PP....QQ..",
    "..PP....QQ..",
    "..PP....QQ..",
  ];
  const { w, h } = spriteSize(sprite);
  blit(ctx, px - w / 2, py - h + 6, sprite, {
    H,
    K,
    m: "#a06050",
    S,
    A: Sl,
    B: Sd,
    L: Sl,
    P,
    Q,
  });
  r(ctx, px - 3, py - h + 14, PX, PX, "#fff");
  r(ctx, px + 2, py - h + 14, PX, PX, "#fff");

  statusLamp(ctx, px, py - 4, a.status);
  label(ctx, px, py - 4, a.title, S);
  return { x: px, y: py - h - 8 };
}

function dinoEye(ctx, x, y) {
  ctx.fillStyle = "#1a1210";
  roundOval(ctx, x, y, 2.2, 2.4);
  ctx.fill();
  ctx.fillStyle = "#fff";
  roundOval(ctx, x - 0.6, y - 0.7, 0.8, 0.8);
  ctx.fill();
}

/** Smooth side-view dinos — readable silhouettes, not ASCII blocks */
function drawDino(ctx, a, px, py, footY, kind) {
  ground(ctx, px, footY);
  const C = a.skin;
  const D = a.hair || shadeHex(C, -38);
  const L = shadeHex(C, 28);

  ctx.save();
  ctx.imageSmoothingEnabled = true;

  if (kind === "tyrannosaurus") {
    // tail
    ctx.fillStyle = D;
    ctx.beginPath();
    ctx.moveTo(px - 6, py + 8);
    ctx.quadraticCurveTo(px - 22, py + 4, px - 26, py + 14);
    ctx.quadraticCurveTo(px - 14, py + 12, px - 4, py + 14);
    ctx.fill();
    // body
    ctx.fillStyle = C;
    roundOval(ctx, px - 2, py + 6, 12, 11);
    ctx.fill();
    // legs
    ctx.fillStyle = D;
    roundOval(ctx, px - 6, py + 18, 3.5, 7);
    ctx.fill();
    roundOval(ctx, px + 4, py + 18, 3.5, 7);
    ctx.fill();
    // tiny arms
    ctx.fillStyle = L;
    roundOval(ctx, px + 4, py + 4, 2.5, 4);
    ctx.fill();
    // neck + head
    ctx.fillStyle = C;
    roundOval(ctx, px + 8, py - 2, 5, 8);
    ctx.fill();
    roundOval(ctx, px + 16, py - 8, 10, 7);
    ctx.fill();
    // jaw
    ctx.fillStyle = D;
    roundOval(ctx, px + 20, py - 4, 7, 3);
    ctx.fill();
    // teeth
    ctx.fillStyle = "#f5f0e6";
    r(ctx, px + 18, py - 3, 1.5, 2, "#f5f0e6");
    r(ctx, px + 21, py - 3, 1.5, 2, "#f5f0e6");
    dinoEye(ctx, px + 14, py - 10);
  } else if (kind === "stegosaurus") {
    // plates
    ctx.fillStyle = D;
    for (let i = 0; i < 5; i++) {
      const bx = px - 12 + i * 6;
      ctx.beginPath();
      ctx.moveTo(bx, py - 2);
      ctx.lineTo(bx + 3, py - 14);
      ctx.lineTo(bx + 6, py - 2);
      ctx.closePath();
      ctx.fill();
    }
    // body
    ctx.fillStyle = C;
    roundOval(ctx, px, py + 6, 18, 10);
    ctx.fill();
    ctx.fillStyle = L;
    roundOval(ctx, px - 2, py + 4, 10, 6);
    ctx.fill();
    // head + tail
    ctx.fillStyle = C;
    roundOval(ctx, px + 16, py + 2, 6, 5);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(px - 16, py + 6);
    ctx.quadraticCurveTo(px - 28, py + 2, px - 30, py + 12);
    ctx.quadraticCurveTo(px - 20, py + 10, px - 14, py + 10);
    ctx.fill();
    // legs
    ctx.fillStyle = D;
    roundOval(ctx, px - 10, py + 16, 3, 6);
    ctx.fill();
    roundOval(ctx, px - 2, py + 16, 3, 6);
    ctx.fill();
    roundOval(ctx, px + 6, py + 16, 3, 6);
    ctx.fill();
    roundOval(ctx, px + 12, py + 16, 3, 6);
    ctx.fill();
    dinoEye(ctx, px + 18, py + 0);
  } else if (kind === "brontosaurus") {
    // body
    ctx.fillStyle = C;
    roundOval(ctx, px - 2, py + 10, 14, 10);
    ctx.fill();
    // neck
    ctx.fillStyle = C;
    ctx.beginPath();
    ctx.moveTo(px + 6, py + 6);
    ctx.quadraticCurveTo(px + 10, py - 10, px + 14, py - 18);
    ctx.lineTo(px + 20, py - 18);
    ctx.quadraticCurveTo(px + 16, py - 6, px + 12, py + 8);
    ctx.fill();
    // head
    roundOval(ctx, px + 18, py - 20, 7, 5);
    ctx.fill();
    // legs + tail
    ctx.fillStyle = D;
    roundOval(ctx, px - 10, py + 20, 3.5, 5);
    ctx.fill();
    roundOval(ctx, px + 4, py + 20, 3.5, 5);
    ctx.fill();
    ctx.fillStyle = C;
    ctx.beginPath();
    ctx.moveTo(px - 14, py + 10);
    ctx.quadraticCurveTo(px - 28, py + 8, px - 26, py + 16);
    ctx.quadraticCurveTo(px - 18, py + 12, px - 12, py + 14);
    ctx.fill();
    dinoEye(ctx, px + 20, py - 22);
  } else if (kind === "triceratops") {
    // frill
    ctx.fillStyle = D;
    roundOval(ctx, px + 4, py - 4, 12, 10);
    ctx.fill();
    ctx.fillStyle = L;
    roundOval(ctx, px + 4, py - 4, 8, 6);
    ctx.fill();
    // body
    ctx.fillStyle = C;
    roundOval(ctx, px - 4, py + 8, 14, 11);
    ctx.fill();
    // head
    roundOval(ctx, px + 10, py + 2, 9, 7);
    ctx.fill();
    // horns
    ctx.fillStyle = "#f0e6d0";
    ctx.beginPath();
    ctx.moveTo(px + 14, py - 2);
    ctx.lineTo(px + 26, py - 10);
    ctx.lineTo(px + 16, py + 0);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(px + 10, py - 4);
    ctx.lineTo(px + 8, py - 14);
    ctx.lineTo(px + 14, py - 4);
    ctx.fill();
    // nose horn
    ctx.beginPath();
    ctx.moveTo(px + 16, py + 2);
    ctx.lineTo(px + 24, py + 0);
    ctx.lineTo(px + 16, py + 4);
    ctx.fill();
    // legs
    ctx.fillStyle = D;
    roundOval(ctx, px - 10, py + 18, 3.2, 5);
    ctx.fill();
    roundOval(ctx, px - 2, py + 18, 3.2, 5);
    ctx.fill();
    roundOval(ctx, px + 4, py + 18, 3.2, 5);
    ctx.fill();
    dinoEye(ctx, px + 12, py + 0);
  } else if (kind === "velociraptor") {
    // tail
    ctx.fillStyle = D;
    ctx.beginPath();
    ctx.moveTo(px - 4, py + 6);
    ctx.quadraticCurveTo(px - 24, py - 2, px - 28, py + 8);
    ctx.quadraticCurveTo(px - 16, py + 6, px - 2, py + 12);
    ctx.fill();
    // body
    ctx.fillStyle = C;
    roundOval(ctx, px, py + 6, 10, 8);
    ctx.fill();
    // neck + head
    roundOval(ctx, px + 8, py - 2, 4, 7);
    ctx.fill();
    roundOval(ctx, px + 14, py - 8, 8, 5.5);
    ctx.fill();
    // sickle claw leg
    ctx.fillStyle = D;
    roundOval(ctx, px + 2, py + 14, 3, 8);
    ctx.fill();
    ctx.fillStyle = "#2a2a2a";
    ctx.beginPath();
    ctx.moveTo(px + 2, py + 20);
    ctx.lineTo(px - 2, py + 26);
    ctx.lineTo(px + 4, py + 22);
    ctx.fill();
    // other leg
    ctx.fillStyle = D;
    roundOval(ctx, px - 4, py + 16, 2.8, 6);
    ctx.fill();
    // arm
    ctx.fillStyle = L;
    roundOval(ctx, px + 4, py + 4, 2.5, 5);
    ctx.fill();
    dinoEye(ctx, px + 12, py - 10);
  } else {
    // pterodactyl
    ctx.fillStyle = D;
    // wings
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.quadraticCurveTo(px - 22, py - 14, px - 28, py + 2);
    ctx.quadraticCurveTo(px - 12, py - 2, px - 2, py + 4);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.quadraticCurveTo(px + 22, py - 14, px + 28, py + 2);
    ctx.quadraticCurveTo(px + 12, py - 2, px + 2, py + 4);
    ctx.fill();
    // body + head crest
    ctx.fillStyle = C;
    roundOval(ctx, px, py + 4, 7, 8);
    ctx.fill();
    roundOval(ctx, px + 8, py - 2, 8, 5);
    ctx.fill();
    ctx.fillStyle = D;
    ctx.beginPath();
    ctx.moveTo(px + 4, py - 4);
    ctx.lineTo(px + 2, py - 14);
    ctx.lineTo(px + 10, py - 4);
    ctx.fill();
    // beak
    ctx.fillStyle = L;
    ctx.beginPath();
    ctx.moveTo(px + 12, py - 2);
    ctx.lineTo(px + 24, py + 0);
    ctx.lineTo(px + 12, py + 2);
    ctx.fill();
    // feet
    ctx.fillStyle = D;
    roundOval(ctx, px - 3, py + 14, 2.5, 4);
    ctx.fill();
    roundOval(ctx, px + 3, py + 14, 2.5, 4);
    ctx.fill();
    dinoEye(ctx, px + 8, py - 4);
  }

  ctx.restore();

  statusLamp(ctx, px, py - 10, a.status);
  label(ctx, px, py - 10, a.title, C);
  return { x: px, y: py - 46 };
}

function roundOval(ctx, x, y, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
}

/** Classic candy gummy bear — soft ovals, gloss, no pixel blocks */
function drawGummy(ctx, a, px, py, footY) {
  const B = a.skin;
  const D = shadeHex(B, -40);
  const L = shadeHex(B, 48);
  const mouth = shadeHex(a.hair || "#5a2a2a", -10);

  ground(ctx, px, footY);

  ctx.save();
  ctx.imageSmoothingEnabled = true;

  // ears (behind head)
  ctx.fillStyle = B;
  roundOval(ctx, px - 12, py - 20, 7, 7);
  ctx.fill();
  roundOval(ctx, px + 12, py - 20, 7, 7);
  ctx.fill();
  ctx.fillStyle = L;
  roundOval(ctx, px - 12, py - 20, 3.5, 3.5);
  ctx.fill();
  roundOval(ctx, px + 12, py - 20, 3.5, 3.5);
  ctx.fill();

  // body
  const bodyGrad = ctx.createRadialGradient(px - 4, py + 2, 2, px, py + 6, 20);
  bodyGrad.addColorStop(0, L);
  bodyGrad.addColorStop(0.45, B);
  bodyGrad.addColorStop(1, D);
  ctx.fillStyle = bodyGrad;
  roundOval(ctx, px, py + 6, 16, 18);
  ctx.fill();

  // head
  const headGrad = ctx.createRadialGradient(px - 3, py - 14, 2, px, py - 10, 16);
  headGrad.addColorStop(0, L);
  headGrad.addColorStop(0.5, B);
  headGrad.addColorStop(1, D);
  ctx.fillStyle = headGrad;
  roundOval(ctx, px, py - 10, 14, 13);
  ctx.fill();

  // arms
  ctx.fillStyle = B;
  roundOval(ctx, px - 16, py + 6, 5.5, 8);
  ctx.fill();
  roundOval(ctx, px + 16, py + 6, 5.5, 8);
  ctx.fill();

  // feet
  ctx.fillStyle = D;
  roundOval(ctx, px - 8, py + 22, 7, 4);
  ctx.fill();
  roundOval(ctx, px + 8, py + 22, 7, 4);
  ctx.fill();

  // belly shine
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = "#fff";
  roundOval(ctx, px, py + 8, 8, 9);
  ctx.fill();
  ctx.globalAlpha = 1;

  // face gloss
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = "#fff";
  roundOval(ctx, px - 5, py - 14, 4, 5);
  ctx.fill();
  ctx.globalAlpha = 1;

  // eyes
  ctx.fillStyle = "#1a1210";
  roundOval(ctx, px - 5, py - 10, 2.4, 2.8);
  ctx.fill();
  roundOval(ctx, px + 5, py - 10, 2.4, 2.8);
  ctx.fill();
  ctx.fillStyle = "#fff";
  roundOval(ctx, px - 5.6, py - 10.8, 0.9, 0.9);
  ctx.fill();
  roundOval(ctx, px + 4.4, py - 10.8, 0.9, 0.9);
  ctx.fill();

  // snout + smile
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = L;
  roundOval(ctx, px, py - 4, 5, 3.5);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = mouth;
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(px, py - 3, 3.2, 0.2 * Math.PI, 0.8 * Math.PI);
  ctx.stroke();

  ctx.restore();

  statusLamp(ctx, px, py - 12, a.status);
  label(ctx, px, py - 12, a.title, B);
  return { x: px, y: py - 48 };
}

/** Compact capsule robot — matches 1TNT desk agents */
function drawRobot(ctx, a, px, py, footY) {
  ground(ctx, px, footY);
  const B = a.skin || "#6ec6ff";
  const Bd = shadeHex(B, -32);
  const Bl = shadeHex(B, 28);

  ctx.save();
  ctx.imageSmoothingEnabled = true;

  // soft shadow already via ground
  // body capsule
  ctx.fillStyle = Bd;
  roundOval(ctx, px + 0.5, py + 2, 8.5, 10.5);
  ctx.fill();
  ctx.fillStyle = B;
  roundOval(ctx, px, py + 1, 8, 10);
  ctx.fill();
  // gloss
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  roundOval(ctx, px - 2.5, py - 2, 3.2, 5);
  ctx.fill();
  // visor
  ctx.fillStyle = "#1a2430";
  roundOval(ctx, px, py - 1, 5.5, 3.2);
  ctx.fill();
  // eyes glow
  ctx.fillStyle = "#7dffb3";
  roundOval(ctx, px - 2.2, py - 1.2, 1.4, 1.6);
  ctx.fill();
  roundOval(ctx, px + 2.2, py - 1.2, 1.4, 1.6);
  ctx.fill();
  ctx.fillStyle = "#fff";
  roundOval(ctx, px - 2.5, py - 1.6, 0.5, 0.5);
  ctx.fill();
  roundOval(ctx, px + 1.9, py - 1.6, 0.5, 0.5);
  ctx.fill();
  // antenna
  ctx.strokeStyle = Bd;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(px, py - 10);
  ctx.lineTo(px, py - 14);
  ctx.stroke();
  ctx.fillStyle = Bl;
  ctx.beginPath();
  ctx.arc(px, py - 15, 1.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
  statusLamp(ctx, px, py - 8, a.status);
  label(ctx, px, py - 8, a.title, B);
  return { x: px, y: py - 36 };
}

/** Big-eyed alien — small body, oversized head */
function drawAlien(ctx, a, px, py, footY) {
  ground(ctx, px, footY);
  const B = a.skin || "#9a7bff";
  const Bd = shadeHex(B, -30);
  const Bl = shadeHex(B, 24);

  ctx.save();
  ctx.imageSmoothingEnabled = true;

  // body
  ctx.fillStyle = Bd;
  roundOval(ctx, px, py + 6, 5, 6.5);
  ctx.fill();
  ctx.fillStyle = B;
  roundOval(ctx, px, py + 5.5, 4.5, 6);
  ctx.fill();
  // head
  ctx.fillStyle = Bd;
  roundOval(ctx, px + 0.4, py - 4, 9.2, 8.2);
  ctx.fill();
  ctx.fillStyle = B;
  roundOval(ctx, px, py - 4.5, 9, 8);
  ctx.fill();
  ctx.fillStyle = Bl;
  roundOval(ctx, px - 2, py - 7, 3, 2.5);
  ctx.fill();
  // huge eyes
  ctx.fillStyle = "#111820";
  roundOval(ctx, px - 3.2, py - 4, 3.2, 4.2);
  ctx.fill();
  roundOval(ctx, px + 3.2, py - 4, 3.2, 4.2);
  ctx.fill();
  ctx.fillStyle = "#7dffea";
  roundOval(ctx, px - 3.2, py - 3.5, 1.6, 2.2);
  ctx.fill();
  roundOval(ctx, px + 3.2, py - 3.5, 1.6, 2.2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  roundOval(ctx, px - 3.8, py - 4.5, 0.7, 0.7);
  ctx.fill();
  roundOval(ctx, px + 2.6, py - 4.5, 0.7, 0.7);
  ctx.fill();
  // antennae
  ctx.strokeStyle = Bd;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(px - 4, py - 12);
  ctx.quadraticCurveTo(px - 8, py - 18, px - 6, py - 20);
  ctx.moveTo(px + 4, py - 12);
  ctx.quadraticCurveTo(px + 8, py - 18, px + 6, py - 20);
  ctx.stroke();
  ctx.fillStyle = "#ff7ad9";
  ctx.beginPath();
  ctx.arc(px - 6, py - 20, 1.7, 0, Math.PI * 2);
  ctx.arc(px + 6, py - 20, 1.7, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
  statusLamp(ctx, px, py - 10, a.status);
  label(ctx, px, py - 10, a.title, B);
  return { x: px, y: py - 40 };
}

export function isAtOwnDesk(a) {
  if (!a || (a.path && a.path.length)) return false;
  const home = a.home;
  if (!Array.isArray(home)) return false;
  return Math.abs(a.col - home[0]) < 0.28 && Math.abs(a.row - home[1]) < 0.28;
}

export function drawAvatarSprite(ctx, a, office, styleId, index = 0) {
  const { x, y } = office.screenOf(a.col, a.row);
  const style = styleId || "robot";
  const sizeMul =
    style === "gummy" || style === "dinosaurs"
      ? AVATAR_SIZE * 0.9
      : style === "minecraft"
        ? AVATAR_SIZE * 0.95
        : AVATAR_SIZE;
  const s = (office.avatarScale || 1) * sizeMul;
  const seated = isAtOwnDesk(a);
  const reporting = a.status === "reporting";
  const moving = Boolean(a.path?.length);
  const active = a.status === "working" || a.status === "talking" || reporting || moving;
  const deskWork = seated && active;
  const sway = deskWork ? Math.sin((a.workMs || 0) * 0.01) * 1.2 * s : 0;
  const bobY = active ? Math.sin(a.bob) * 1.6 * s : Math.sin(a.bob) * 0.35 * s;
  const seat = seated && office.seatPoint ? office.seatPoint(a.col, a.row) : null;
  const px = Math.round((seat ? seat.x : x) + sway);
  const py = Math.round((seat ? seat.y : y - 8 * s) + bobY);
  const footY = 14;

  ctx.save();
  ctx.translate(px, py);
  ctx.scale(s, s);
  ctx.imageSmoothingEnabled = style !== "minecraft";

  let local;
  if (style === "dinosaurs") {
    local = drawDino(
      ctx,
      a,
      0,
      0,
      footY,
      a.dinoKind || dinoKindForIndex(index)
    );
  } else if (style === "gummy") {
    local = drawGummy(ctx, a, 0, 0, footY);
  } else if (style === "alien") {
    local = drawAlien(ctx, a, 0, 0, footY);
  } else if (style === "robot") {
    local = drawRobot(ctx, a, 0, 0, footY);
  } else {
    local = drawMinecraft(ctx, a, 0, 0, footY);
  }
  ctx.restore();

  const headY = py + (local?.y || -36) * s;
  if (active) {
    drawWorkMark(ctx, px, headY + 28 * s, s);
    if (reporting) drawReportTag(ctx, px, headY - 8);
  } else if (seated && a.status === "idle" && !moving && !office._live) {
    drawIdleZzz(ctx, px + 8, headY - 4, a.bob);
  }

  return {
    x: px + (local?.x || 0) * s,
    y: py + (local?.y || -36) * s,
  };
}

/** Green antenna + floor glow — the 1TNT "working" mark. */
function drawWorkMark(ctx, px, py, s) {
  ctx.save();
  ctx.fillStyle = "rgba(54, 224, 143, 0.22)";
  ctx.beginPath();
  ctx.ellipse(px, py + 6 * s, 16 * s, 7 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#36e08f";
  ctx.lineWidth = Math.max(1.5, 1.6 * s);
  ctx.beginPath();
  ctx.moveTo(px, py - 34 * s);
  ctx.lineTo(px, py - 46 * s);
  ctx.stroke();
  ctx.shadowColor = "#36e08f";
  ctx.shadowBlur = 10;
  ctx.fillStyle = "#9ef0c4";
  ctx.beginPath();
  ctx.arc(px, py - 48 * s, Math.max(2.4, 3 * s), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawReportTag(ctx, x, y) {
  ctx.save();
  ctx.font = "700 11px sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "#14532d";
  ctx.fillText("reporting", x, y);
  ctx.restore();
}

/** Floating zzz for anyone standing idle at their desk. */
function drawIdleZzz(ctx, x, y, bob) {
  ctx.save();
  ctx.font = "700 12px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (let i = 0; i < 3; i++) {
    const phase = (bob * 0.12 + i * 0.34) % 1;
    ctx.globalAlpha = phase < 0.15 ? phase / 0.15 : phase > 0.75 ? (1 - phase) / 0.25 : 0.85;
    ctx.fillStyle = "#7a7266";
    const size = 10 + i * 2;
    ctx.font = `700 ${size}px sans-serif`;
    ctx.fillText("z", x + i * 5 + phase * 4, y - i * 7 - phase * 6);
  }
  ctx.restore();
}

export function swatchForStyle(skin, hair, styleId, index = 0) {
  const c = document.createElement("canvas");
  c.width = 24;
  c.height = 24;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  if (styleId === "robot") {
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(12, 14, 7, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a2430";
    ctx.beginPath();
    ctx.ellipse(12, 12, 5, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7dffb3";
    ctx.beginPath();
    ctx.arc(9.5, 12, 1.4, 0, Math.PI * 2);
    ctx.arc(14.5, 12, 1.4, 0, Math.PI * 2);
    ctx.fill();
  } else if (styleId === "alien") {
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(12, 11, 8, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#111820";
    ctx.beginPath();
    ctx.ellipse(8.5, 11, 2.8, 3.5, 0, 0, Math.PI * 2);
    ctx.ellipse(15.5, 11, 2.8, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7dffea";
    ctx.beginPath();
    ctx.ellipse(8.5, 11.5, 1.2, 1.6, 0, 0, Math.PI * 2);
    ctx.ellipse(15.5, 11.5, 1.2, 1.6, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (styleId === "gummy") {
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(7, 8, 4, 0, Math.PI * 2);
    ctx.arc(17, 8, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(12, 14, 8, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.beginPath();
    ctx.ellipse(9, 12, 3, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.arc(9, 13, 1.2, 0, Math.PI * 2);
    ctx.arc(15, 13, 1.2, 0, Math.PI * 2);
    ctx.fill();
  } else if (styleId === "dinosaurs") {
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(11, 15, 7, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(17, 10, 5, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.arc(18, 9, 1, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = skin;
    ctx.fillRect(6, 11, 12, 8);
    ctx.fillStyle = "#efc09a";
    ctx.fillRect(7, 4, 10, 8);
    ctx.fillStyle = hair;
    ctx.fillRect(7, 2, 10, 3);
    ctx.fillStyle = "#111";
    ctx.fillRect(9, 8, 2, 2);
    ctx.fillRect(13, 8, 2, 2);
  }
  return c.toDataURL();
}
