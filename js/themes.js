/**
 * Intentional palettes (relate + complete + balanced stimulation).
 * Includes light surfaces — not dark-only.
 */

export const themes = [
  {
    id: "paper-sky",
    name: "Paper & Sky",
    feel: "Light · cool related neutrals · sky accent",
    mode: "light",
    swatches: ["#f4f7fb", "#e2eaf3", "#3d7ab8", "#1a2430"],
    vars: {
      "--bg": "#eef3f8",
      "--bg-lift": "#f7fafc",
      "--panel": "rgba(255, 255, 255, 0.94)",
      "--panel-border": "#c5d0dc",
      "--ink": "#1a2430",
      "--paper": "#1a2430",
      "--muted": "#5c6b7a",
      "--accent": "#3d7ab8",
      "--accent-dim": "#2e5f8f",
      "--accent-text": "#ffffff",
      "--stage": "#d9e3ee",
      "--stage-alt": "#cfdceb",
      "--working": "#2f8f55",
      "--idle": "#6a7a88",
      "--blocked": "#c44b4b",
      "--done": "#3d7ab8",
      "--feed-line": "#d5dee8",
      "--input-bg": "#ffffff",
      "--shadow": "#9aa8b8",
    },
  },
  {
    id: "linen-olive",
    name: "Linen & Olive",
    feel: "Light · warm linen field · olive complete",
    mode: "light",
    swatches: ["#f6f1e8", "#e8dfd0", "#6b7f3f", "#2a241c"],
    vars: {
      "--bg": "#efe8dc",
      "--bg-lift": "#f8f4ec",
      "--panel": "rgba(255, 252, 246, 0.95)",
      "--panel-border": "#d2c4ae",
      "--ink": "#2a241c",
      "--paper": "#2a241c",
      "--muted": "#6e6456",
      "--accent": "#6b7f3f",
      "--accent-dim": "#556632",
      "--accent-text": "#ffffff",
      "--stage": "#e4d9c6",
      "--stage-alt": "#dccfb8",
      "--working": "#4e8a45",
      "--idle": "#7a7164",
      "--blocked": "#b85a45",
      "--done": "#4a7a9a",
      "--feed-line": "#e0d4c2",
      "--input-bg": "#fffdf8",
      "--shadow": "#a89880",
    },
  },
  {
    id: "mist-coral",
    name: "Mist & Coral",
    feel: "Light · soft gray mist · coral complete",
    mode: "light",
    swatches: ["#f3f3f5", "#e4e4e9", "#d1655a", "#222228"],
    vars: {
      "--bg": "#ebebef",
      "--bg-lift": "#f7f7f9",
      "--panel": "rgba(255, 255, 255, 0.95)",
      "--panel-border": "#cccdd4",
      "--ink": "#222228",
      "--paper": "#222228",
      "--muted": "#6a6a74",
      "--accent": "#d1655a",
      "--accent-dim": "#b04e45",
      "--accent-text": "#ffffff",
      "--stage": "#dcdae0",
      "--stage-alt": "#d2d0d8",
      "--working": "#3f9a5c",
      "--idle": "#787882",
      "--blocked": "#d1655a",
      "--done": "#4a78a8",
      "--feed-line": "#dddee4",
      "--input-bg": "#ffffff",
      "--shadow": "#9a9aa4",
    },
  },
  {
    id: "chalk-indigo",
    name: "Chalk & Indigo",
    feel: "Light · chalk white · indigo complete",
    mode: "light",
    swatches: ["#fbfbfd", "#ebeaf6", "#3f3d9b", "#1c1b33"],
    vars: {
      "--bg": "#eef0f8",
      "--bg-lift": "#fbfbfd",
      "--panel": "rgba(255, 255, 255, 0.96)",
      "--panel-border": "#c8c6de",
      "--ink": "#1c1b33",
      "--paper": "#1c1b33",
      "--muted": "#5c5a78",
      "--accent": "#3f3d9b",
      "--accent-dim": "#312f7a",
      "--accent-text": "#ffffff",
      "--stage": "#dddceb",
      "--stage-alt": "#d2d0e4",
      "--working": "#2f8f55",
      "--idle": "#6e6c88",
      "--blocked": "#c44b4b",
      "--done": "#3f3d9b",
      "--feed-line": "#d9d7e8",
      "--input-bg": "#ffffff",
      "--shadow": "#9a98b0",
    },
  },
  {
    id: "slate-copper",
    name: "Slate & Copper",
    feel: "Dark · cool workshop · warm complete",
    mode: "dark",
    swatches: ["#1c242c", "#2a3440", "#c47a3a", "#e8eef2"],
    vars: {
      "--bg": "#12171c",
      "--bg-lift": "#1c242c",
      "--panel": "rgba(28, 36, 44, 0.96)",
      "--panel-border": "#3a4654",
      "--ink": "#0e1216",
      "--paper": "#e8eef2",
      "--muted": "#8b97a5",
      "--accent": "#c47a3a",
      "--accent-dim": "#9a5c28",
      "--accent-text": "#0e1216",
      "--stage": "#161c22",
      "--stage-alt": "#1a222a",
      "--working": "#5b9a6a",
      "--idle": "#7d8a98",
      "--blocked": "#d16b6b",
      "--done": "#5b8fb8",
      "--feed-line": "#2a3440",
      "--input-bg": "#0e1216",
      "--shadow": "#0a0d10",
    },
  },
  {
    id: "ink-citrus",
    name: "Ink & Citrus",
    feel: "Dark · high contrast · citrus complete",
    mode: "dark",
    swatches: ["#141414", "#2a2a2a", "#e2b13a", "#f4f1ea"],
    vars: {
      "--bg": "#0f0f0f",
      "--bg-lift": "#1a1a1a",
      "--panel": "rgba(26, 26, 26, 0.97)",
      "--panel-border": "#3a3a3a",
      "--ink": "#0a0a0a",
      "--paper": "#f4f1ea",
      "--muted": "#9a9690",
      "--accent": "#e2b13a",
      "--accent-dim": "#b88c24",
      "--accent-text": "#0a0a0a",
      "--stage": "#141414",
      "--stage-alt": "#1c1c1c",
      "--working": "#5aaa6a",
      "--idle": "#8a8884",
      "--blocked": "#d06060",
      "--done": "#5a90c0",
      "--feed-line": "#2e2e2e",
      "--input-bg": "#0a0a0a",
      "--shadow": "#000000",
    },
  },
];

export const DEFAULT_THEME_ID = "paper-sky";

export function getTheme(id) {
  return themes.find((t) => t.id === id) || themes[0];
}

export function applyTheme(id) {
  const theme = getTheme(id);
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.dataset.mode = theme.mode || "light";
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value);
  }
  document.querySelectorAll(".theme-card").forEach((el) => {
    const on = el.dataset.themeId === theme.id;
    el.classList.toggle("is-active", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
  });
  return theme;
}

export async function persistTheme(id) {
  applyTheme(id);
  const current = await fetch("/api/settings").then((r) => r.json());
  const next = { ...current, themeId: id };
  return fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
  }).then((r) => r.json());
}
