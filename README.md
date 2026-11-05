# Hermes Factory

Company of Hermes subagents — isometric office UI on **real** Nous Hermes profiles. Templates and positions are editable and stored on disk.

## Run

```bash
cd hermes-factory
python3 server/bridge.py
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787).

## Settings → palette, templates & positions


Open **Settings**:

| Action | Where |
|--------|--------|
| **Color palette** | Colors section (office tiles follow the palette) |
| **Avatar style** | Minecraft · Dinosaurs · Gummy bears |
| Pick Hermes parent profile / binary | Hermes section |
| Switch company template | Active template |
| Rename template | Display name |
| **Board talks to** | Orchestrator / board chat target (usually CEO) |
| **Add position** | Positions → title + department → Add |
| **Role kind** | Per role: orchestrator / manager / executor / evaluator |
| Edit org lines | Per role: **Takes orders from** + **Reports to** (required) |
| Edit / remove positions | Per-role rows (title, dept, kind, Hermes profile) |
| **Clone as new** company | Clone as new |
| Delete custom template | Delete template (not `software-company`) |
| **Save & apply** | Writes template + settings, remounts floor |

### Role kinds (communication graph)

Roles are nodes; allowed talk paths are directed edges — not a one-shot pipeline:

```
Board ⇄ Orchestrator ⇄ Manager → Executor ⇄ Manager (interval progress)
                                  │              ↑
                                  ↓              │
                             Evaluator ──────────┘
```

| Kind | Who | Edges |
|------|-----|-------|
| `orchestrator` | Usually CEO | Board ↔ orch; orch → managers; managers → orch (start **and** end) |
| `manager` | CTO / COO / CFO… | **Chooses:** → executor (`DELEGATE`) **or** → orchestrator (`REPORT_UP`) / `HOLD` |
| `executor` | Engineers, etc. | **While working:** interval progress → `takesOrdersFrom` (who gave the order). **When ready:** → evaluator (QC) |
| `evaluator` | QC / QA | → manager only (validate + recommend; manager decides again) |

So after QC the manager can send more work to an executor **or** report up. Orchestrator verifies + `DELIVERED` when a manager reports up.

### Org chart (always in the template)

Every role **must** define reporting lines + `roleKind` in the company JSON:

| Role | `takesOrdersFrom` | `reportsTo` | `roleKind` |
|------|-------------------|-------------|------------|
| Board target (`orchestratorRoleId`, e.g. CEO) | `null` (Board) | `null` (Board) | `orchestrator` |
| Everyone else | **required** role id | **required** role id | `manager` / `executor` / `evaluator` |

| Field | Meaning |
|-------|---------|
| `takesOrdersFrom` | Who assigns work / gives orders. For **executors**, interval progress reports go here. |
| `reportsTo` | Structural next hop when finished (executors often → evaluator; managers → orchestrator). |

Defaults when missing on save/load: non-board roles get the board target id for both bosses; missing kind → `executor`.

### Software Company seed (template example)

Bundled at `server/seed/software-company.json`:

| Role | Kind | Takes orders from | Reports to |
|------|------|-------------------|------------|
| CEO | orchestrator | Board | Board |
| CTO / COO | manager | CEO | CEO |
| SWE / SWE II / Architect | executor | CTO | QA |
| QA | evaluator | CTO | CTO |

Minimal role lines (same idea for any custom template):

```json
{ "id": "ceo", "roleKind": "orchestrator", "takesOrdersFrom": null, "reportsTo": null },
{ "id": "cto", "roleKind": "manager", "takesOrdersFrom": "ceo", "reportsTo": "ceo" },
{ "id": "swe", "roleKind": "executor", "takesOrdersFrom": "cto", "reportsTo": "qa" },
{ "id": "qa", "roleKind": "evaluator", "takesOrdersFrom": "cto", "reportsTo": "cto" }
```

A manager can have **many executors**. On `DELEGATE` they pick one `role_id`. Handoffs are walk → talk → **return home**; the next agent starts only after the walker is back.

### Workflow example (Software Company)

Board says: *“Ship a login fix.”*

1. **Board → CEO** (orchestrator) — CEO is at their desk, takes the ask.
2. **CEO → CTO** — CEO walks to CTO, hands off, returns home. Only then CTO starts.
3. **CTO decides** — `DELEGATE: swe` (or another engineer), or later `REPORT_UP` / `HOLD`.
4. **CTO → SWE** — CTO walks to SWE, returns home; SWE starts at their own desk.
5. **SWE works (executor property)** — SWE works at their desk, then always walks to **CTO** (`takesOrdersFrom`) with a progress update and returns. If still open, one more work+report cycle. Not to QA yet.
6. **SWE → QA** — after reporting to CTO, when ready (`TASK_STATE: done`), SWE hands off to the evaluator.
7. **QA → CTO** — QC validates and reports back to the manager.
8. **CTO again** — more work (`DELEGATE`) **or** `REPORT_UP` to CEO.
9. **CEO verifies** — when work is truly done, CEO reports to the board (`DELIVERED`).

Same pattern for any template: wire `roleKind` + bosses, then the graph walk follows those edges.

### Storage

| Path | Contents |
|------|----------|
| `~/.hermes-factory/settings.json` | Active template, theme, avatarStyle, role→profile map |
| `~/.hermes-factory/templates/*.json` | Full company templates (roles + org lines, desks, rooms) |
| `server/seed/*.json` | Built-in seeds (copied once if missing) |

## Work

- **Talk to board target** / **Assign task** → real `hermes -p <profile> -z … --usage-file`
- Org graph by role kind: manager chooses executor vs report-up; executor interval-progress → order-giver, then → evaluator → manager; orchestrator start+end
- **API history** — click a call for latency, headers, prompt, response, usage

## Bridge API

| Method | Path |
|--------|------|
| GET | `/api/profiles` |
| GET/PUT | `/api/settings` |
| GET | `/api/templates` |
| GET/PUT/DELETE | `/api/templates/<id>` |
| POST | `/api/templates` `{ "name", "cloneFrom" }` |
| POST | `/api/run` `{ "profile", "prompt" }` |
