/** Real Hermes runs via local factory bridge */

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export async function runHermes({ profile, prompt, signal = null }) {
  const requestHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const t0 = performance.now();
  let res;
  let data = {};
  try {
    res = await fetch("/api/run", {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ profile, prompt }),
      signal: signal || undefined,
    });
    data = await res.json().catch(() => ({}));
  } catch (networkErr) {
    const clientLatencyMs = Math.round(performance.now() - t0);
    if (networkErr?.name === "AbortError" || signal?.aborted) {
      const err = new Error("Board changed course");
      err.code = "COURSE_CHANGED";
      err.name = "AbortError";
      err.data = {
        ok: false,
        error: err.message,
        profile,
        reply: "",
        usage: null,
        clientLatencyMs,
        httpStatus: 0,
        requestHeaders,
        responseHeaders: {},
        prompt,
      };
      throw err;
    }
    const err = new Error(networkErr.message || "Network error talking to bridge");
    err.data = {
      ok: false,
      error: err.message,
      profile,
      reply: "",
      usage: null,
      clientLatencyMs,
      httpStatus: 0,
      requestHeaders,
      responseHeaders: {},
      prompt,
    };
    throw err;
  }

  const clientLatencyMs = Math.round(performance.now() - t0);
  const responseHeaders = headersToObject(res.headers);
  const envelope = {
    ...data,
    prompt,
    profile: data.profile || profile,
    clientLatencyMs,
    httpStatus: res.status,
    requestHeaders,
    responseHeaders,
    bridgeLatencyMs: data.latencyMs ?? null,
  };

  if (!res.ok || !data.ok) {
    let msg = data.error || data.reply || `Hermes failed (${res.status})`;
    if (/402|Insufficient available credits|nousresearch/i.test(msg)) {
      const parent = data.profileMeta?.parentProfile || profile;
      const prov = data.profileMeta?.provider || "?";
      msg = `${msg}\n→ Factory settings want profile "${parent}" (${prov}). 402 is Nous cloud credits — not your local AI. Do not use Hermes Agent kanban (t_*).`;
    }
    const err = new Error(msg);
    err.data = envelope;
    throw err;
  }
  return envelope;
}

/**
 * Resolve Hermes profile for a factory role.
 * Never returns a bare role id (swe, designer, …) unless that id is a real profile.
 */
export function profileForRole(template, settings, roleId, profiles = null) {
  const ov = settings?.roleProfiles?.[roleId];
  const role = template?.roles?.find((r) => r.id === roleId);
  const candidates = [
    ov?.hermesProfile,
    role?.hermesProfile,
    settings?.parentProfile,
    "default",
  ].filter(Boolean);

  const known = Array.isArray(profiles)
    ? new Set(profiles.map((p) => (typeof p === "string" ? p : p?.id)).filter(Boolean))
    : null;

  const parent = settings?.parentProfile;
  // Enforce settings: prefer parent over bare "default" when parent is configured
  for (const id of candidates) {
    if (!known) {
      if (id === "default" && parent && parent !== "default") continue;
      return id;
    }
    if (!known.has(id)) continue;
    if (id === "default" && parent && parent !== "default" && known.has(parent)) {
      continue;
    }
    return id;
  }
  if (known?.has(parent)) return parent;
  if (known?.has("default")) return "default";
  return parent || candidates[0] || "default";
}
