/** Speech bubbles on the office + live feed panel */

export function createComms({ feedEl, speechLayerEl, agents, onBubbleClick }) {
  const roleTitle = Object.fromEntries(agents.list.map((a) => [a.id, a.title]));
  roleTitle.you = "You";

  function pushFeed({ from, to, text, at }) {
    const li = document.createElement("li");
    li.className = "feed__item";

    const route = document.createElement("p");
    route.className = "feed__route";
    const fromLabel = roleTitle[from] || from;
    const toLabel = to ? roleTitle[to] || to : "all";
    route.textContent = `${fromLabel} → ${toLabel}`;

    const body = document.createElement("p");
    body.className = "feed__text";
    body.textContent = text;

    const time = document.createElement("span");
    time.className = "feed__time";
    time.textContent = formatTime(at);

    li.append(route, body, time);
    feedEl.prepend(li);

    while (feedEl.children.length > 40) {
      feedEl.lastElementChild.remove();
    }
  }

  function formatTime(at) {
    if (typeof at === "number") {
      const s = Math.floor(at / 1000);
      const m = Math.floor(s / 60);
      const r = String(s % 60).padStart(2, "0");
      return `t+${m}:${r}`;
    }
    return at || "";
  }

  function clearFeed() {
    feedEl.innerHTML = "";
  }

  /** Stable bubble nodes — never recreate every frame (that killed clicks). */
  const bubbleEls = new Map();

  function bubbleSignature(a) {
    return [
      a.bubble || "",
      a.bubbleKind || "",
      a.stickyBubble ? "1" : "0",
      a.bubbleAction || "",
    ].join("|");
  }

  function buildBubbleEl(a) {
    const isCheck = a.bubbleKind === "check";
    const clickable = Boolean(a.stickyBubble && a.bubbleAction);
    const el = document.createElement("div");
    el.dataset.agentId = a.id;
    el.className = [
      "speech-bubble",
      clickable ? "speech-bubble--clickable" : "",
      isCheck ? "speech-bubble--check" : "",
    ]
      .filter(Boolean)
      .join(" ");

    if (isCheck) {
      const mark = document.createElement("span");
      mark.className = "speech-bubble__check";
      mark.textContent = "✓";
      mark.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.className = "speech-bubble__text";
      text.textContent = a.bubble;
      el.append(mark, text);
      if (clickable) {
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "speech-bubble__dismiss";
        dismiss.setAttribute("aria-label", "Dismiss");
        dismiss.textContent = "×";
        dismiss.addEventListener("pointerdown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          agents.clearBubble?.(a.id);
          onBubbleClick?.(a.id, "dismiss", a.bubble);
        });
        el.appendChild(dismiss);
      }
    } else {
      el.textContent = a.bubble;
    }

    if (clickable) {
      el.title = isCheck
        ? "Click to reply to the board · × to dismiss"
        : "Click to respond to the board";
      el.setAttribute("role", "button");
      el.tabIndex = 0;
      const fire = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onBubbleClick?.(a.id, a.bubbleAction, a.bubble);
      };
      // pointerdown survives better than click if anything remounts mid-gesture
      el.addEventListener("pointerdown", fire);
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          fire(ev);
        }
      });
    }
    return el;
  }

  function renderBubbles(anchors) {
    const canvas = document.getElementById("office-canvas");
    if (!canvas || !speechLayerEl) return;
    const stage = canvas.parentElement;
    const rect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    // Logical size matches office.screenOf (canvas backing / current DPR transform)
    const dpr = Math.max(1, canvas.width / Math.max(1, rect.width));
    const logicalW = canvas.width / dpr;
    const logicalH = canvas.height / dpr;
    const scaleX = rect.width / logicalW;
    const scaleY = rect.height / logicalH;
    const offsetX = rect.left - stageRect.left;
    const offsetY = rect.top - stageRect.top;

    const seen = new Set();
    for (const a of agents.list) {
      if (!a.bubble || !anchors[a.id]) continue;
      seen.add(a.id);
      const { x, y } = anchors[a.id];
      const sig = bubbleSignature(a);
      let entry = bubbleEls.get(a.id);
      if (!entry || entry.sig !== sig) {
        if (entry?.el?.parentNode) entry.el.remove();
        const el = buildBubbleEl(a);
        speechLayerEl.appendChild(el);
        entry = { el, sig };
        bubbleEls.set(a.id, entry);
      }
      entry.el.style.left = `${offsetX + x * scaleX}px`;
      entry.el.style.top = `${offsetY + y * scaleY}px`;
    }

    for (const [id, entry] of bubbleEls) {
      if (seen.has(id)) continue;
      entry.el.remove();
      bubbleEls.delete(id);
    }
  }

  function drawEdges(ctx, office, events, nowMs) {
    // faint who→whom lines for recent messages
    const recent = events.filter((e) => e.to && nowMs - e._wall < 4000);
    ctx.save();
    ctx.lineWidth = 2;
    for (const e of recent) {
      const from = agents.byId(e.from);
      const to = agents.byId(e.to);
      if (!from || !to) continue;
      const a = office.screenOf(from.col, from.row);
      const b = office.screenOf(to.col, to.row);
      const alpha = 1 - (nowMs - e._wall) / 4000;
      ctx.strokeStyle = `rgba(232,168,56,${0.35 * alpha})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  return {
    pushFeed,
    clearFeed,
    renderBubbles,
    drawEdges,
  };
}

function titleById(agents, id) {
  if (!id) return "Board";
  return agents.byId(id)?.title || id;
}

export function renderRoster(listEl, agents, swatchDataUrl, avatarStyle = "minecraft") {
  listEl.innerHTML = "";
  agents.list.forEach((a, index) => {
    const li = document.createElement("li");
    li.className = "roster__item";
    li.dataset.id = a.id;

    const img = document.createElement("img");
    img.className = "roster__swatch";
    img.alt = "";
    img.width = 28;
    img.height = 28;
    img.src = swatchDataUrl(a.skin, a.hair, avatarStyle, index);

    const meta = document.createElement("div");
    meta.className = "roster__meta";

    const role = document.createElement("p");
    role.className = "roster__role";
    role.textContent = a.title;

    const profile = document.createElement("p");
    profile.className = "roster__profile";
    const profileId = a.hermesProfile || "default";
    profile.innerHTML = `<span class="roster__profile-tag">profile</span> <strong>${profileId}</strong>`;

    const dept = document.createElement("p");
    dept.className = "roster__dept";
    dept.textContent = a.department || "";

    const desc = document.createElement("p");
    desc.className = "roster__desc";
    desc.textContent = a.description || "No description yet.";

    const org = document.createElement("p");
    org.className = "roster__org";
    const kind = a.roleKind || "executor";
    org.textContent = `${kind} · orders ← ${titleById(
      agents,
      a.takesOrdersFrom
    )} · reports → ${titleById(agents, a.reportsTo)}`;

    const status = document.createElement("span");
    status.className = "roster__status";
    status.dataset.status = a.status;
    status.textContent = a.status;

    meta.append(role, profile, dept, desc, org, status);
    li.append(img, meta);
    listEl.appendChild(li);
  });
}

export function syncRosterStatus(listEl, agents) {
  for (const a of agents.list) {
    const status = listEl.querySelector(`[data-id="${a.id}"] .roster__status`);
    if (!status) continue;
    if (status.dataset.status !== a.status) {
      status.dataset.status = a.status;
      status.textContent = a.status;
    }
  }
}
