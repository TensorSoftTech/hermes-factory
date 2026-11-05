---
name: add-factory-template
description: >-
  Add or edit Hermes Factory company templates and positions. Templates are
  stored as JSON under ~/.hermes-factory/templates and edited in Settings.
  Every role needs roleKind plus takesOrdersFrom/reportsTo (except board target).
---

# Add / edit a Hermes Factory template

## Preferred: UI

1. Run `python3 server/bridge.py` → open Settings.
2. **Clone as new** (or edit `software-company`).
3. Set **Board talks to** (orchestrator / board chat target).
4. **Add position** (title + department), map Hermes profile, set **role kind**.
5. For every role **except** the board target, set:
   - **Role kind**: `manager` | `executor` | `evaluator`
   - **Takes orders from** (required — who assigns them work)
   - **Reports to** (required — who they `REPORT_UP` to; executors often report to an evaluator)
6. **Save & apply** → writes `~/.hermes-factory/templates/<id>.json`.

Board target locks to `roleKind: orchestrator` and both bosses `null`. Missing bosses default to the board target id; missing kind → `executor`.

## Role kinds (graph)

```
Board ⇄ Orchestrator ⇄ Manager → Executor ⇄ Manager (interval progress)
                                  │              ↑
                                  ↓              │
                             Evaluator ──────────┘
```

| `roleKind` | Role | Edges |
|------------|------|-------|
| `orchestrator` | Board contact (CEO) | Start + end; talks to managers |
| `manager` | CTO / COO / CFO… | **Decision:** `DELEGATE` executor **or** `REPORT_UP` orchestrator |
| `executor` | Hands-on workers | Interval progress → `takesOrdersFrom` (order-giver); when ready → evaluator |
| `evaluator` | QC / QA | Forced → manager (then manager chooses again) |

See README **Workflow example (Software Company)** for a full board→CEO→CTO→SWE⇄CTO→QA→CTO→CEO walk.

## File contract

Stored JSON shape:

| Field | Notes |
|-------|-------|
| `id` | kebab-case filename stem |
| `name` | display name |
| `orchestratorRoleId` | board chat target (only role allowed `null` bosses + orchestrator kind) |
| `rooms[]` | office tiles |
| `desks[]` | auto-synced from role `home` on save |
| `roles[]` | positions + **roleKind** + **org lines** |

### Role fields (required)

`id`, `title`, `department`, `hermesProfile`, `skin`, `hair`, `desk`, `home:[col,row]`,
**`roleKind`**, **`takesOrdersFrom`**, **`reportsTo`**:

- Board target (`id === orchestratorRoleId`): `roleKind` = `orchestrator`, both bosses `null`
- Every other role: `roleKind` in `manager` | `executor` | `evaluator`; both bosses a **different** existing role id
- Tip: executors set `reportsTo` to the evaluator; evaluator `reportsTo` the manager

Example (Software Company):

```json
{ "id": "ceo", "roleKind": "orchestrator", "takesOrdersFrom": null, "reportsTo": null },
{ "id": "cto", "roleKind": "manager", "takesOrdersFrom": "ceo", "reportsTo": "ceo" },
{ "id": "swe", "roleKind": "executor", "takesOrdersFrom": "cto", "reportsTo": "qa" },
{ "id": "qa", "roleKind": "evaluator", "takesOrdersFrom": "cto", "reportsTo": "cto" }
```

Bridge `normalize_org_chart` / client `normalizeOrgChart` always rewrite these on load/save.

Model/provider come from the Hermes profile at runtime — do not hardcode fakes.

## Seed / API

- Bundled seed: [`server/seed/software-company.json`](../../../server/seed/software-company.json) (copied once into `~/.hermes-factory/templates/`).
- `POST /api/templates` `{ "name", "cloneFrom" }`
- `PUT /api/templates/<id>` full document (org chart normalized)
- `DELETE /api/templates/<id>` (not `software-company`)
