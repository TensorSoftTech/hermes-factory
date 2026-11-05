/** Session + per-agent usage + API call history (real Hermes usage when present) */

function formatMs(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return "—";
  const n = Number(ms);
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return "—";
  }
}

export function createStats(template) {
  const byAgent = Object.fromEntries(
    template.roles.map((r) => [
      r.id,
      {
        id: r.id,
        title: r.title,
        hermesProfile: r.hermesProfile || "default",
        model: r.model || "unknown",
        provider: r.provider || "unknown",
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        tasks: 0,
      },
    ])
  );

  const session = {
    calls: 0,
    tokensIn: 0,
    tokensOut: 0,
    tasks: 0,
  };

  const history = [];
  let seq = 0;
  let detailEl = null;
  let onOpenDetail = null;

  function rebuild(templateNext) {
    for (const key of Object.keys(byAgent)) delete byAgent[key];
    for (const r of templateNext.roles) {
      byAgent[r.id] = {
        id: r.id,
        title: r.title,
        hermesProfile: r.hermesProfile || "default",
        model: r.model || "unknown",
        provider: r.provider || "unknown",
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        tasks: 0,
      };
    }
    reset();
  }

  function syncRoleMeta(templateNext) {
    for (const r of templateNext.roles) {
      const row = byAgent[r.id];
      if (!row) continue;
      row.title = r.title;
      row.hermesProfile = r.hermesProfile || row.hermesProfile || "default";
      row.model = r.model || row.model;
      row.provider = r.provider || row.provider;
    }
  }

  function estimateTokens(text) {
    const n = (text || "").trim().split(/\s+/).filter(Boolean).length;
    return Math.max(8, Math.round(n * 1.35));
  }

  function recordCall(
    agentId,
    {
      prompt = "",
      reply = "",
      isTask = false,
      usage = null,
      ok = true,
      error = null,
      profile = null,
      latencyMs = null,
      clientLatencyMs = null,
      bridgeLatencyMs = null,
      httpStatus = null,
      requestHeaders = null,
      responseHeaders = null,
      stderr = "",
      cmd = null,
      returncode = null,
      raw = null,
    } = {}
  ) {
    const row = byAgent[agentId];
    if (!row) return null;

    const tin =
      usage?.input_tokens != null
        ? Number(usage.input_tokens)
        : estimateTokens(prompt);
    const tout =
      usage?.output_tokens != null
        ? Number(usage.output_tokens)
        : estimateTokens(reply);
    const model = usage?.model || row.model;
    const provider = usage?.provider || row.provider;

    if (usage?.model) row.model = usage.model;
    if (usage?.provider) row.provider = usage.provider;
    if (profile) row.hermesProfile = profile;

    const callCount = Number(usage?.api_calls || 1);
    row.calls += callCount;
    row.tokensIn += tin;
    row.tokensOut += tout;
    if (isTask) row.tasks += 1;
    session.calls += callCount;
    session.tokensIn += tin;
    session.tokensOut += tout;
    if (isTask) session.tasks += 1;

    seq += 1;
    const entry = {
      id: seq,
      agentId,
      role: row.title,
      model,
      provider,
      tokensIn: tin,
      tokensOut: tout,
      isTask: Boolean(isTask),
      at: Date.now(),
      cost: usage?.estimated_cost_usd ?? null,
      ok: Boolean(ok),
      error: error || null,
      profile: profile || null,
      prompt,
      reply,
      latencyMs: latencyMs ?? clientLatencyMs ?? bridgeLatencyMs,
      clientLatencyMs,
      bridgeLatencyMs: bridgeLatencyMs ?? latencyMs,
      httpStatus,
      requestHeaders: requestHeaders || {},
      responseHeaders: responseHeaders || {},
      stderr: stderr || "",
      cmd: cmd || null,
      returncode,
      usage: usage || null,
      raw: raw || null,
    };
    history.unshift(entry);
    if (history.length > 80) history.length = 80;
    return entry;
  }

  function reset() {
    session.calls = 0;
    session.tokensIn = 0;
    session.tokensOut = 0;
    session.tasks = 0;
    seq = 0;
    history.length = 0;
    for (const row of Object.values(byAgent)) {
      row.calls = 0;
      row.tokensIn = 0;
      row.tokensOut = 0;
      row.tasks = 0;
    }
  }

  function renderSession(el) {
    if (!el) return;
    el.querySelector('[data-stat="calls"] b').textContent = String(session.calls);
    el.querySelector('[data-stat="tok-in"] b').textContent = String(session.tokensIn);
    el.querySelector('[data-stat="tok-out"] b').textContent = String(session.tokensOut);
    el.querySelector('[data-stat="tasks"] b').textContent = String(session.tasks);
  }

  function renderUsage(el) {
    if (!el) return;
    el.innerHTML = "";
    for (const row of Object.values(byAgent)) {
      const div = document.createElement("div");
      div.className = "usage__row";
      div.innerHTML = `
        <span class="usage__name">${row.title}</span>
        <span class="usage__model">profile <b>${row.hermesProfile || "default"}</b></span>
        <span class="usage__meta">calls ${row.calls}</span>
        <span class="usage__meta">in ${row.tokensIn} · out ${row.tokensOut}</span>
      `;
      el.appendChild(div);
    }
  }

  function bindDetailUi(root, openFn) {
    detailEl = root;
    onOpenDetail = openFn;
  }

  function getById(id) {
    return history.find((e) => e.id === Number(id));
  }

  function renderHistory(el) {
    if (!el) return;
    el.innerHTML = "";
    if (!history.length) {
      const empty = document.createElement("p");
      empty.className = "api-history__empty";
      empty.textContent = "No Hermes profile runs yet. Click a call to inspect.";
      el.appendChild(empty);
      return;
    }
    for (const entry of history) {
      const li = document.createElement("li");
      li.className =
        "api-history__item" + (entry.ok ? "" : " api-history__item--error");
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.dataset.id = String(entry.id);
      li.title = "Open full Hermes profile call";

      const top = document.createElement("div");
      top.className = "api-history__top";
      const role = document.createElement("p");
      role.className = "api-history__role";
      role.textContent = entry.role;
      const n = document.createElement("span");
      n.className = "api-history__n";
      n.textContent = `#${entry.id}${entry.isTask ? " · task" : ""}${
        entry.ok ? "" : " · err"
      }`;
      top.append(role, n);

      const route = document.createElement("p");
      route.className = "api-history__route";
      route.textContent = `Hermes profile · ${entry.profile || byAgent[entry.agentId]?.hermesProfile || "default"}`;

      const tokens = document.createElement("p");
      tokens.className = "api-history__tokens";
      const cost =
        entry.cost != null ? ` · $${Number(entry.cost).toFixed(5)}` : "";
      tokens.textContent = `${formatTime(entry.at)} · ${formatMs(
        entry.latencyMs
      )} · in ${entry.tokensIn} · out ${entry.tokensOut}${cost}`;

      const hint = document.createElement("p");
      hint.className = "api-history__click";
      hint.textContent = "Click for prompt · response · headers";

      li.append(top, route, tokens, hint);

      const open = () => openDetail(entry.id);
      li.addEventListener("click", open);
      li.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          open();
        }
      });

      el.appendChild(li);
    }
  }

  function headersBlock(title, headers) {
    const keys = Object.keys(headers || {});
    const body =
      keys.length === 0
        ? "(none)"
        : keys
            .sort()
            .map((k) => `${k}: ${headers[k]}`)
            .join("\n");
    return { title, body };
  }

  function fillDetail(entry) {
    if (!detailEl || !entry) return;
    const set = (sel, text) => {
      const node = detailEl.querySelector(sel);
      if (node) node.textContent = text ?? "";
    };
    set(
      "[data-call='title']",
      `Hermes #${entry.id} · ${entry.role} · ${entry.profile || "default"}`
    );
    set(
      "[data-call='meta']",
      [
        entry.ok ? "OK" : "ERROR",
        formatTime(entry.at),
        `profile ${entry.profile || "default"}`,
        entry.isTask ? "task" : "chat",
        entry.httpStatus != null ? `HTTP ${entry.httpStatus}` : null,
        entry.returncode != null ? `exit ${entry.returncode}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    );
    set(
      "[data-call='latency']",
      [
        `client ${formatMs(entry.clientLatencyMs)}`,
        `bridge/hermes ${formatMs(entry.bridgeLatencyMs)}`,
        entry.cost != null ? `≈ $${Number(entry.cost).toFixed(6)}` : null,
        `tokens in ${entry.tokensIn} / out ${entry.tokensOut}`,
      ]
        .filter(Boolean)
        .join(" · ")
    );
    set(
      "[data-call='cmd']",
      Array.isArray(entry.cmd) ? entry.cmd.join(" ") : entry.cmd || "—"
    );
    set("[data-call='prompt']", entry.prompt || "(empty)");
    set(
      "[data-call='reply']",
      entry.ok
        ? entry.reply || "(empty)"
        : entry.error || entry.reply || "(no response)"
    );
    set("[data-call='stderr']", entry.stderr || "(none)");
    set(
      "[data-call='usage']",
      entry.usage ? JSON.stringify(entry.usage, null, 2) : "(no usage file)"
    );
    const req = headersBlock("Request headers", entry.requestHeaders);
    const res = headersBlock("Response headers", entry.responseHeaders);
    set("[data-call='req-headers']", req.body);
    set("[data-call='res-headers']", res.body);
    set(
      "[data-call='raw']",
      entry.raw ? JSON.stringify(entry.raw, null, 2) : "(not captured)"
    );
  }

  function openDetail(id) {
    const entry = getById(id);
    if (!entry) return;
    fillDetail(entry);
    onOpenDetail?.(entry);
  }

  function closeDetail() {
    /* host handles overlay class */
  }

  function agentStats(agentId) {
    const row = byAgent[agentId];
    if (!row) return null;
    const calls = history.filter((h) => h.agentId === agentId);
    const ok = calls.filter((h) => h.ok).length;
    const err = calls.filter((h) => !h.ok).length;
    const taskDone = calls.filter((h) => h.isTask && h.ok).length;
    const latencies = calls
      .map((h) => h.latencyMs)
      .filter((n) => n != null && !Number.isNaN(Number(n)))
      .map(Number);
    const avgLatency = latencies.length
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : null;
    return {
      ...row,
      okCalls: ok,
      errCalls: err,
      tasksDone: taskDone,
      avgLatencyMs: avgLatency,
      recent: calls.slice(0, 8),
    };
  }

  return {
    byAgent,
    session,
    history,
    recordCall,
    reset,
    rebuild,
    syncRoleMeta,
    renderSession,
    renderUsage,
    renderHistory,
    bindDetailUi,
    openDetail,
    closeDetail,
    getById,
    agentStats,
    formatMs,
  };
}
