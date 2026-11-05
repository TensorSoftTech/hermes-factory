/** Settings: Hermes profiles + editable stored templates / positions */

import {
  refreshTemplates,
  saveTemplate,
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  makeRole,
  normalizeBossId,
  normalizeOrgChart,
  scrubOrgRefs,
  roleTitle,
  ROLE_KINDS,
  normalizeRoleKind,
} from "./registry.js";
import {
  themes,
  applyTheme,
  persistTheme,
  DEFAULT_THEME_ID,
} from "./themes.js";
import { AVATAR_STYLES, swatchForStyle } from "./avatars.js?v=state-history-1";

const API = "";

export function createSettings({ getState, onApply, isBusy }) {
  const overlay = document.getElementById("settings-overlay");
  const openBtn = document.getElementById("btn-settings");
  const closeBtn = document.getElementById("settings-close");
  const cancelBtn = document.getElementById("settings-cancel");
  const saveBtn = document.getElementById("settings-save");
  const refreshBtn = document.getElementById("settings-refresh-profiles");
  const statusEl = document.getElementById("settings-status");
  const templateSelect = document.getElementById("settings-template");
  const parentSelect = document.getElementById("settings-parent-profile");
  const rolesEl = document.getElementById("settings-roles");
  const hermesBinEl = document.getElementById("settings-hermes-bin");
  const workspaceEl = document.getElementById("settings-workspace");
  const orchestrationEl = document.getElementById("settings-orchestration");
  const templateNameEl = document.getElementById("settings-template-name");
  const orchSelect = document.getElementById("settings-orchestrator");
  const addRoleBtn = document.getElementById("settings-add-role");
  const newTitleEl = document.getElementById("settings-new-title");
  const newDeptEl = document.getElementById("settings-new-dept");
  const cloneBtn = document.getElementById("settings-clone-template");
  const deleteBtn = document.getElementById("settings-delete-template");
  const themesEl = document.getElementById("settings-themes");
  const avatarsEl = document.getElementById("settings-avatars");

  if (!overlay || !openBtn || !saveBtn || !themesEl || !rolesEl) {
    console.error("[settings] missing required DOM nodes", {
      overlay: !!overlay,
      openBtn: !!openBtn,
      saveBtn: !!saveBtn,
      themesEl: !!themesEl,
      rolesEl: !!rolesEl,
    });
    return { open() {}, close() {}, api: async () => ({}), loadProfiles: async () => [] };
  }

  let profiles = [];
  let draftTemplate = null;
  let draftThemeId = DEFAULT_THEME_ID;
  let draftAvatarStyle = "robot";
  /** Runtime role→profile map (settings.roleProfiles). UI must resolve like hermes.profileForRole. */
  let draftRoleProfiles = {};
  let draftParentProfile = "default";
  let draftSettingsTemplateId = null;

  function setStatus(msg, isErr = false) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.dataset.err = isErr ? "1" : "0";
  }

  function showOverlay() {
    overlay.classList.add("is-open");
    overlay.setAttribute("aria-hidden", "false");
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    // Keep panel pinned at top — don't let async content growth scroll it away
    overlay.scrollTop = 0;
    const panel = overlay.querySelector(".settings");
    const body = overlay.querySelector(".settings__body");
    if (panel) panel.scrollTop = 0;
    if (body) body.scrollTop = 0;
  }

  function hideOverlay() {
    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
    overlay.hidden = true;
    document.body.style.overflow = "";
  }

  async function api(path, opts = {}) {
    const res = await fetch(`${API}${path}`, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.reply || `HTTP ${res.status}`);
    return data;
  }

  async function loadProfiles() {
    const data = await api("/api/profiles");
    profiles = data.profiles || [];
    return profiles;
  }

  function fillProfileSelect(select, selected) {
    if (!select) return;
    const want = selected || "default";
    select.innerHTML = "";
    for (const p of profiles) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.id} · ${p.provider}/${p.model}`;
      select.appendChild(opt);
    }
    if (!profiles.length) {
      const opt = document.createElement("option");
      opt.value = "default";
      opt.textContent = "default";
      select.appendChild(opt);
    }
    // Keep unknown ids selectable so Save can't silently clobber them
    if (want && ![...select.options].some((o) => o.value === want)) {
      const opt = document.createElement("option");
      opt.value = want;
      opt.textContent = `${want} · (not listed)`;
      select.appendChild(opt);
    }
    select.value = want;
  }

  /** Same order as profileForRole / applySettingsToTemplate. */
  function effectiveProfileForRole(role) {
    const ov = draftRoleProfiles?.[role?.id];
    return (
      ov?.hermesProfile ||
      role?.hermesProfile ||
      draftParentProfile ||
      "default"
    );
  }

  /** Align draft template roles with settings.roleProfiles when editing the active org. */
  function applyRoleProfilesToDraft() {
    if (!draftTemplate?.roles?.length) return;
    if (
      draftSettingsTemplateId &&
      draftTemplate.id !== draftSettingsTemplateId
    ) {
      return;
    }
    draftTemplate.roles = draftTemplate.roles.map((role) => ({
      ...role,
      hermesProfile: effectiveProfileForRole(role),
    }));
  }

  function fillTemplateSelect(selected) {
    if (!templateSelect) return;
    templateSelect.innerHTML = "";
    for (const t of listTemplates()) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.name} (${t.roleCount} roles)`;
      if (t.id === selected) opt.selected = true;
      templateSelect.appendChild(opt);
    }
  }

  function fillOrchSelect() {
    if (!orchSelect || !draftTemplate) return;
    orchSelect.innerHTML = "";
    for (const role of draftTemplate.roles || []) {
      const opt = document.createElement("option");
      opt.value = role.id;
      opt.textContent = role.title;
      if (role.id === draftTemplate.orchestratorRoleId) opt.selected = true;
      orchSelect.appendChild(opt);
    }
  }

  function fillBossSelect(select, selected, selfId, { allowBoard = false } = {}) {
    if (!select || !draftTemplate) return;
    select.innerHTML = "";
    const orch = draftTemplate.orchestratorRoleId;
    if (allowBoard) {
      const board = document.createElement("option");
      board.value = "board";
      board.textContent = "Board";
      select.appendChild(board);
    }
    for (const r of draftTemplate.roles || []) {
      if (r.id === selfId) continue;
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.title;
      select.appendChild(opt);
    }
    const want = allowBoard
      ? normalizeBossId(selected) || "board"
      : normalizeBossId(selected) || orch || select.options[0]?.value;
    select.value = want;
    if (select.value !== want && select.options.length) {
      select.value = allowBoard ? "board" : select.options[0].value;
    }
  }

  function collectRolesFromDom() {
    const roles = [];
    for (const row of rolesEl.querySelectorAll(".settings__role")) {
      const id = row.dataset.roleId;
      const prev = (draftTemplate.roles || []).find((r) => r.id === id) || {};
      const title = row.querySelector('[data-field="title"]')?.value?.trim() || prev.title;
      const department =
        row.querySelector('[data-field="department"]')?.value?.trim() || prev.department;
      const description =
        row.querySelector('[data-field="description"]')?.value?.trim() ||
        prev.description ||
        "";
      const hermesProfile =
        row.querySelector('[data-field="hermesProfile"]')?.value ||
        prev.hermesProfile ||
        "default";
      const takesOrdersFrom = normalizeBossId(
        row.querySelector('[data-field="takesOrdersFrom"]')?.value ??
          prev.takesOrdersFrom
      );
      const reportsTo = normalizeBossId(
        row.querySelector('[data-field="reportsTo"]')?.value ?? prev.reportsTo
      );
      const roleKind = normalizeRoleKind(
        row.querySelector('[data-field="roleKind"]')?.value ?? prev.roleKind,
        { isOrchestrator: id === draftTemplate.orchestratorRoleId }
      );
      roles.push({
        ...prev,
        id,
        title,
        department,
        description,
        hermesProfile,
        roleKind,
        takesOrdersFrom,
        reportsTo,
      });
    }
    return roles;
  }

  function syncDraftFromDom() {
    if (!draftTemplate) return;
    draftTemplate.name = templateNameEl?.value?.trim() || draftTemplate.id;
    draftTemplate.orchestratorRoleId =
      orchSelect?.value || draftTemplate.orchestratorRoleId;
    draftTemplate.roles = collectRolesFromDom();
    // Board target: null/null. Everyone else: required takesOrdersFrom + reportsTo.
    const normalized = normalizeOrgChart(draftTemplate);
    draftTemplate.orchestratorRoleId = normalized.orchestratorRoleId;
    draftTemplate.roles = normalized.roles;
  }

  function renderRoleRows() {
    rolesEl.innerHTML = "";
    if (!draftTemplate) return;
    for (const role of draftTemplate.roles || []) {
      const row = document.createElement("div");
      row.className = "settings__role";
      row.dataset.roleId = role.id;

      const head = document.createElement("div");
      head.className = "settings__role-head";

      const titleInput = document.createElement("input");
      titleInput.className = "settings__input";
      titleInput.dataset.field = "title";
      titleInput.value = role.title || "";
      titleInput.placeholder = "Position title";

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn-ghost";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        syncDraftFromDom();
        if ((draftTemplate.roles || []).length <= 1) {
          setStatus("Keep at least one position", true);
          return;
        }
        const removedId = role.id;
        let orch = draftTemplate.orchestratorRoleId;
        if (orch === removedId) {
          orch = draftTemplate.roles.find((r) => r.id !== removedId)?.id;
          draftTemplate.orchestratorRoleId = orch;
        }
        draftTemplate.roles = scrubOrgRefs(
          draftTemplate.roles.filter((r) => r.id !== removedId),
          removedId,
          orch
        );
        fillOrchSelect();
        renderRoleRows();
      });

      head.append(titleInput, removeBtn);

      const deptLabel = document.createElement("label");
      deptLabel.className = "settings__label";
      deptLabel.textContent = "Department";
      const deptInput = document.createElement("input");
      deptInput.className = "settings__input";
      deptInput.dataset.field = "department";
      deptInput.value = role.department || "";

      const kindLabel = document.createElement("label");
      kindLabel.className = "settings__label";
      kindLabel.textContent = "Role kind";
      const kindSel = document.createElement("select");
      kindSel.className = "settings__select";
      kindSel.dataset.field = "roleKind";
      const isOrch = role.id === draftTemplate.orchestratorRoleId;
      for (const k of ROLE_KINDS) {
        if (isOrch && k.id !== "orchestrator") continue;
        if (!isOrch && k.id === "orchestrator") continue;
        const opt = document.createElement("option");
        opt.value = k.id;
        opt.textContent = `${k.name} — ${k.blurb}`;
        kindSel.appendChild(opt);
      }
      kindSel.value = normalizeRoleKind(role.roleKind, {
        isOrchestrator: isOrch,
      });
      if (isOrch) kindSel.disabled = true;

      const descLabel = document.createElement("label");
      descLabel.className = "settings__label";
      descLabel.textContent = "Description";
      const descInput = document.createElement("textarea");
      descInput.className = "settings__input settings__textarea";
      descInput.dataset.field = "description";
      descInput.rows = 2;
      descInput.placeholder = "What this role owns…";
      descInput.value = role.description || "";

      const ordersLabel = document.createElement("label");
      ordersLabel.className = "settings__label";
      ordersLabel.textContent = "Takes orders from";
      const ordersSel = document.createElement("select");
      ordersSel.className = "settings__select";
      ordersSel.dataset.field = "takesOrdersFrom";
      if (isOrch) {
        ordersSel.disabled = true;
        fillBossSelect(ordersSel, null, role.id, { allowBoard: true });
      } else {
        fillBossSelect(ordersSel, role.takesOrdersFrom, role.id);
      }

      const reportsLabel = document.createElement("label");
      reportsLabel.className = "settings__label";
      reportsLabel.textContent = "Reports to";
      const reportsSel = document.createElement("select");
      reportsSel.className = "settings__select";
      reportsSel.dataset.field = "reportsTo";
      if (isOrch) {
        reportsSel.disabled = true;
        fillBossSelect(reportsSel, null, role.id, { allowBoard: true });
      } else {
        fillBossSelect(reportsSel, role.reportsTo, role.id);
      }

      const profileLabel = document.createElement("label");
      profileLabel.className = "settings__label";
      profileLabel.textContent = "Hermes profile";
      const sel = document.createElement("select");
      sel.className = "settings__select";
      sel.dataset.field = "hermesProfile";
      fillProfileSelect(sel, effectiveProfileForRole(role));

      const meta = document.createElement("p");
      meta.className = "settings__role-meta";
      const syncMeta = () => {
        const p = profiles.find((x) => x.id === sel.value);
        const orders = normalizeBossId(ordersSel.value);
        const reports = normalizeBossId(reportsSel.value);
        const kind = kindSel.value || "executor";
        const org = `kind ${kind} · orders ← ${roleTitle(
          draftTemplate,
          orders
        )} · reports → ${roleTitle(draftTemplate, reports)}`;
        meta.textContent = p
          ? `Hermes profile · ${p.id} · role ${role.id} · ${org}`
          : `Hermes profile · ${sel.value || "default"} · role ${role.id} · ${org}`;
      };
      sel.addEventListener("change", syncMeta);
      kindSel.addEventListener("change", syncMeta);
      ordersSel.addEventListener("change", syncMeta);
      reportsSel.addEventListener("change", syncMeta);
      syncMeta();

      row.append(
        head,
        deptLabel,
        deptInput,
        kindLabel,
        kindSel,
        descLabel,
        descInput,
        ordersLabel,
        ordersSel,
        reportsLabel,
        reportsSel,
        profileLabel,
        sel,
        meta
      );
      rolesEl.appendChild(row);
    }
  }

  function loadTemplateIntoEditor(id) {
    let full = getTemplate(id);
    if (!full) {
      const live = getState()?.template;
      if (live && live.id === id) full = live;
    }
    if (!full) throw new Error(`Template missing: ${id}`);
    draftTemplate = structuredClone(full);
    applyRoleProfilesToDraft();
    if (templateNameEl) templateNameEl.value = draftTemplate.name || "";
    fillOrchSelect();
    renderRoleRows();
  }

  function renderAvatars() {
    if (!avatarsEl) return;
    avatarsEl.innerHTML = "";
    const previewColors = [
      ["#c62828", "#212121"],
      ["#1565c0", "#37474f"],
      ["#2e7d32", "#1b5e20"],
      ["#ef6c00", "#4e342e"],
    ];
    for (const style of AVATAR_STYLES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "avatar-style-card" +
        (style.id === draftAvatarStyle ? " is-active" : "");
      btn.dataset.avatarStyle = style.id;

      const previews = document.createElement("div");
      previews.className = "avatar-style-card__previews";
      previewColors.forEach(([skin, hair], i) => {
        const img = document.createElement("img");
        img.alt = "";
        img.width = 28;
        img.height = 28;
        img.src = swatchForStyle(skin, hair, style.id, i);
        previews.appendChild(img);
      });

      const text = document.createElement("div");
      text.className = "avatar-style-card__text";
      const name = document.createElement("p");
      name.className = "avatar-style-card__name";
      name.textContent = style.name;
      const blurb = document.createElement("p");
      blurb.className = "avatar-style-card__blurb";
      blurb.textContent = style.blurb;
      text.append(name, blurb);
      btn.append(previews, text);
      btn.addEventListener("click", () => {
        draftAvatarStyle = style.id;
        renderAvatars();
        setStatus(`Avatar style → ${style.name} (Save & apply to remount floor)`);
      });
      avatarsEl.appendChild(btn);
    }
  }

  function renderThemes() {
    themesEl.innerHTML = "";
    for (const theme of themes) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "theme-card" + (theme.id === draftThemeId ? " is-active" : "");
      btn.dataset.themeId = theme.id;
      btn.setAttribute("role", "option");
      btn.setAttribute(
        "aria-selected",
        theme.id === draftThemeId ? "true" : "false"
      );

      const sw = document.createElement("div");
      sw.className = "theme-card__swatches";
      for (const hex of theme.swatches) {
        const span = document.createElement("span");
        span.style.background = hex;
        sw.appendChild(span);
      }

      const meta = document.createElement("div");
      const name = document.createElement("p");
      name.className = "theme-card__name";
      name.textContent = `${theme.name} · ${theme.mode || "light"}`;
      const feel = document.createElement("p");
      feel.className = "theme-card__feel";
      feel.textContent = theme.feel;
      meta.append(name, feel);

      btn.append(sw, meta);
      btn.addEventListener("click", async () => {
        draftThemeId = theme.id;
        try {
          await persistTheme(theme.id);
        } catch {
          applyTheme(theme.id);
        }
        renderThemes();
      });
      themesEl.appendChild(btn);
    }
  }

  async function open() {
    showOverlay();
    // Palettes + avatars first — always visible even if Hermes/templates fail later
    draftThemeId =
      document.documentElement.dataset.theme || DEFAULT_THEME_ID;
    renderThemes();
    renderAvatars();
    setStatus("Loading profiles & templates…");
    try {
      await Promise.all([loadProfiles(), refreshTemplates()]);
      const liveSettings = getState()?.settings;
      const draftSettings = await api("/api/settings");
      // Prefer in-memory settings when present (covers soft-apply before remount)
      const source = liveSettings
        ? { ...draftSettings, ...liveSettings }
        : draftSettings;
      draftThemeId = source.themeId || DEFAULT_THEME_ID;
      draftAvatarStyle = source.avatarStyle || "robot";
      draftRoleProfiles =
        source.roleProfiles && typeof source.roleProfiles === "object"
          ? source.roleProfiles
          : {};
      draftParentProfile = source.parentProfile || "default";
      draftSettingsTemplateId = source.templateId || null;
      applyTheme(draftThemeId);
      renderThemes();
      renderAvatars();

      const state = getState();
      const selected =
        templateSelect?.value ||
        state.template?.id ||
        source.templateId ||
        listTemplates()[0]?.id;
      if (!selected) throw new Error("No templates available");

      fillTemplateSelect(selected);
      if (templateSelect) templateSelect.value = selected;
      fillProfileSelect(parentSelect, draftParentProfile);
      if (hermesBinEl) hermesBinEl.value = source.hermesBin || "";
      if (workspaceEl) workspaceEl.value = source.workspacePath || "";
      if (orchestrationEl) {
        orchestrationEl.value =
          source.orchestration === "client" ? "client" : "server";
      }
      loadTemplateIntoEditor(selected);
      const body = overlay.querySelector(".settings__body");
      if (body) body.scrollTop = 0;
      overlay.scrollTop = 0;
      setStatus(
        isBusy?.()
          ? "Task running — you can edit & save, but floor remount waits until idle"
          : `5 color palettes above · templates in ~/.hermes-factory`
      );
    } catch (err) {
      console.error("[settings] open failed", err);
      renderThemes();
      setStatus(String(err.message || err), true);
    }
  }

  function close() {
    hideOverlay();
  }

  function collectSettingsPayload() {
    syncDraftFromDom();
    const roleProfiles = {};
    for (const role of draftTemplate.roles || []) {
      const p = profiles.find((x) => x.id === role.hermesProfile);
      roleProfiles[role.id] = {
        hermesProfile: role.hermesProfile,
        provider: p?.provider || "unknown",
        model: p?.model || "unknown",
      };
    }
    return {
      templateId: draftTemplate.id,
      parentProfile: parentSelect?.value || "default",
      hermesBin: hermesBinEl?.value?.trim() || undefined,
      workspacePath: workspaceEl?.value?.trim() || undefined,
      orchestration:
        orchestrationEl?.value === "client" ? "client" : "server",
      roleProfiles,
      orchestratorRoleId: draftTemplate.orchestratorRoleId,
      themeId: draftThemeId || DEFAULT_THEME_ID,
      avatarStyle: draftAvatarStyle || "robot",
    };
  }

  templateSelect?.addEventListener("change", () => {
    try {
      syncDraftFromDom();
      loadTemplateIntoEditor(templateSelect.value);
      setStatus(`Editing ${draftTemplate.name}`);
    } catch (err) {
      setStatus(String(err.message || err), true);
    }
  });

  orchSelect?.addEventListener("change", () => {
    if (draftTemplate) draftTemplate.orchestratorRoleId = orchSelect.value;
  });

  addRoleBtn?.addEventListener("click", () => {
    if (!draftTemplate) return;
    syncDraftFromDom();
    const title = newTitleEl?.value?.trim();
    if (!title) {
      setStatus("Enter a position title", true);
      return;
    }
    const role = makeRole(draftTemplate, {
      title,
      department: newDeptEl?.value?.trim() || "General",
      hermesProfile: parentSelect?.value || "default",
    });
    draftTemplate.roles = [...(draftTemplate.roles || []), role];
    if (newTitleEl) newTitleEl.value = "";
    fillOrchSelect();
    renderRoleRows();
    setStatus(`Added ${role.title}`);
  });

  cloneBtn?.addEventListener("click", async () => {
    try {
      if (!draftTemplate) return;
      syncDraftFromDom();
      const name = prompt("New template name?", `${draftTemplate.name} Copy`);
      if (!name) return;
      setStatus("Saving current, then cloning…");
      await saveTemplate(draftTemplate);
      const cloned = await createTemplate({
        name,
        cloneFrom: draftTemplate.id,
      });
      fillTemplateSelect(cloned.id);
      if (templateSelect) templateSelect.value = cloned.id;
      loadTemplateIntoEditor(cloned.id);
      setStatus(`Created ${cloned.name}`);
    } catch (err) {
      setStatus(String(err.message || err), true);
    }
  });

  deleteBtn?.addEventListener("click", async () => {
    try {
      if (!draftTemplate) return;
      if (draftTemplate.id === "software-company") {
        setStatus("Cannot delete built-in software-company", true);
        return;
      }
      if (!confirm(`Delete template "${draftTemplate.name}"?`)) return;
      await deleteTemplate(draftTemplate.id);
      fillTemplateSelect("software-company");
      if (templateSelect) templateSelect.value = "software-company";
      loadTemplateIntoEditor("software-company");
      setStatus("Template deleted");
    } catch (err) {
      setStatus(String(err.message || err), true);
    }
  });

  openBtn.addEventListener("click", (e) => {
    e.preventDefault();
    open();
  });
  closeBtn?.addEventListener("click", close);
  cancelBtn?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  refreshBtn?.addEventListener("click", async () => {
    try {
      await loadProfiles();
      syncDraftFromDom();
      fillProfileSelect(parentSelect, parentSelect?.value);
      renderRoleRows();
      setStatus(`Refreshed — ${profiles.length} profile(s)`);
    } catch (err) {
      setStatus(String(err.message || err), true);
    }
  });

  saveBtn.addEventListener("click", async () => {
    try {
      if (!draftTemplate) throw new Error("Nothing to save — reopen Settings");
      const running = Boolean(isBusy?.());
      setStatus(
        running
          ? "Saving… (task running — floor remount deferred)"
          : "Saving template + settings…"
      );
      syncDraftFromDom();
      const savedTmpl = await saveTemplate(draftTemplate);
      draftTemplate = savedTmpl;
      const payload = collectSettingsPayload();
      const saved = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      draftRoleProfiles = payload.roleProfiles || {};
      draftParentProfile = payload.parentProfile || "default";
      draftSettingsTemplateId = payload.templateId || draftTemplate.id;
      await refreshTemplates();
      applyTheme(saved.themeId || draftThemeId);
      try {
        await onApply(saved, savedTmpl);
        setStatus("Saved to ~/.hermes-factory — floor remounted");
        close();
      } catch (err) {
        if (err?.soft || err?.code === "SOFT_APPLY" || err?.code === "BUSY_REMOUNT") {
          setStatus(String(err.message || err), false);
          // Keep settings open so user sees the note; theme already live
          return;
        }
        throw err;
      }
    } catch (err) {
      console.error("[settings] save failed", err);
      setStatus(String(err.message || err), true);
    }
  });

  window.hermesFactoryOpenSettings = open;
  window.hermesFactoryCloseSettings = close;

  return { open, close, api, loadProfiles };
}
