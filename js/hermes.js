/** Real Hermes runs via local factory bridge */

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export async function runHermes({ profile, prompt }) {
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
    });
    data = await res.json().catch(() => ({}));
  } catch (networkErr) {
    const clientLatencyMs = Math.round(performance.now() - t0);
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
    const err = new Error(
      data.error || data.reply || `Hermes failed (${res.status})`
    );
    err.data = envelope;
    throw err;
  }
  return envelope;
}

export function profileForRole(template, settings, roleId) {
  const ov = settings?.roleProfiles?.[roleId];
  if (ov?.hermesProfile) return ov.hermesProfile;
  const role = template.roles.find((r) => r.id === roleId);
  return role?.hermesProfile || settings?.parentProfile || "default";
}
