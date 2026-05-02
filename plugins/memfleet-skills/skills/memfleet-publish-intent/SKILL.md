---
name: memfleet-publish-intent
description: "Always use BEFORE modifying any symbol in a multi-agent session to register structural intent and surface blast radius + active conflicts. Triggered by: about to refactor / rename / delete / modify code, planning an edit, checking if another agent is working on the same area, pre-edit coordination, leader-driven multi-symbol waves. Do not edit first and publish after — the whole point is to surface conflicts BEFORE the wasted edit. Do not pass intent_kind as a flat string; it is a typed enum with a JSON-object shape."
---

## Overview

Register a structural intent against a symbol BEFORE editing. Returns the precomputed blast radius (the propagation set of nodes implicated by your edit) and any conflicts already declared by other agents.

This is the **first** call in [`memfleet-safe-edit`](../workflows/memfleet-safe-edit.md) Step 2. Skipping it means you discover collisions at merge time instead of at intent time, which is exactly what MemFleet exists to prevent.

## Quick Reference

| Tool | Purpose |
|---|---|
| `publish_intent` | Declare intent; get blast radius + active conflicts |
| `get_node_state` | (Optional pre-call) inspect recent activity on the symbol first |
| `fleet_status` | (Optional pre-call) confirm the broker is up and not in a conflict storm |

> **Parameter types:** MCP parameters are strictly typed. `intent_kind` MUST be a JSON object naming the variant (`{"Refactor": {"pattern": "RenameSymbol"}}`); a flat string like `"Refactor(RenameSymbol)"` is rejected. Numbers (`ttl_ms`) must be JSON numbers, not quoted strings.

## Steps

### 1. Identify the target symbol

Locate the symbol you are about to edit using whatever discovery tool your harness has:

- **Memtrace installed?** → Use `find_symbol` / `find_code` (they return the canonical NodeIdentity).
- **No Memtrace?** → Use your editor's go-to-definition or `grep` for the qualified name. The `symbol` field is a free-form string the broker treats as the NodeIdentity.

### 2. Pick the IntentKind variant

Choose the variant matching your planned edit:

| Variant | Use for |
|---|---|
| `Refactor { pattern: RenameSymbol \| ExtractFunction \| ... }` | Structural rewrites that preserve behaviour |
| `FeatureAdd { surface: NewSymbol \| NewField \| NewEndpoint \| ... }` | Net-new functionality |
| `BugFix { defect: NullHandling \| RaceCondition \| OffByOne \| ... }` | Behaviour corrections |
| `Cleanup { kind: DeadCode \| FormatOnly \| Lint \| ... }` | Non-semantic tidying |
| `Performance { axis: Latency \| Memory \| Throughput \| ... }` | Optimisations |
| `SecurityFix { severity, cve? }` | Security patches; CVE optional |
| `TestAdd { covers: [NodeIdentity] }` | New tests covering specific symbols |
| `DocsOnly` | Comments, docstrings, README — no semantic change |
| `Exploratory` | Probe / scout / kickoff signals; not a real edit |

Pass the variant as JSON, never as a flat string.

### 3. Call `publish_intent`

```
mcp__memfleet__publish_intent({
  repo_id:    "my-repo",
  symbol:     "UserRole",
  intent_kind:{"Refactor": {"pattern": "RenameSymbol"}},
  ttl_ms:     300000,
  agent_id:   "claude-code-session-42"   // optional but recommended
})
```

**Parameters:**
- `repo_id` — string, required. The repository the symbol lives in.
- `symbol` — string, required. The NodeIdentity (qualified name) of the target.
- `intent_kind` — JSON object, required. One of the variants above.
- `ttl_ms` — integer, required. How long the intent stays live without renewal. Default sane choice: `300_000` (5 minutes).
- `reference_time` — RFC3339 string, optional. Defaults to "now". Used for LWW arbitration on Class B.
- `agent_id` — string, optional. Helps `fleet_status` / `get_node_state` attribute the intent to a person/session.

**Success criteria:** the broker returns `intent_id`, `propagation_set`, and `active_conflicts` (possibly empty).

### 4. Read the response

```json
{
  "intent_id": "01H…",
  "propagation_set": ["UserRoleRepo", "UserSessionService"],
  "active_conflicts": []
}
```

| Field | Meaning |
|---|---|
| `intent_id` | ULID. Save it — every subsequent `record_episode` references it. |
| `propagation_set` | Nodes the broker thinks your edit will ripple into. Other agents on these nodes get a structural signal in their next `get_node_state`. |
| `active_conflicts` | Empty = clear to edit. Non-empty = branch to [`memfleet-conflict-resolution`](../workflows/memfleet-conflict-resolution.md). |

### 5. Decide

| `active_conflicts` | Action |
|---|---|
| Empty | Proceed with the edit (next step in [`memfleet-safe-edit`](../workflows/memfleet-safe-edit.md)). |
| Non-empty | STOP. Branch to [`memfleet-conflict-resolution`](../workflows/memfleet-conflict-resolution.md). Do **not** edit. |

## Decision Points

| Situation | Action |
|---|---|
| You are about to touch multiple symbols | Publish one intent per symbol; collect all `intent_id`s before editing |
| The edit is exploratory (probe, hypothesis test) | Use `intent_kind: "Exploratory"` so others know it is not a real edit |
| You already published earlier this session and it timed out | Publish a fresh intent; TTL has expired so the prior intent is no longer in `active_intents` |
| `propagation_set` is enormous (>50 nodes) | Consider splitting the intent into narrower scopes before proceeding |
| Multi-agent wave (leader/follower) | Encode the correlation tag in the intent surface — see [`memfleet-fleet-coordination`](../workflows/memfleet-fleet-coordination.md) |

## Common Mistakes

| Mistake | Reality |
|---|---|
| Editing first, publishing after | The whole point is to detect conflicts BEFORE the wasted edit. Reverse the order. |
| Passing `intent_kind` as a flattened string (`"Refactor(RenameSymbol)"`) | Rejected by the schema. Use the JSON-object form. |
| Quoting `ttl_ms` as a string (`"300000"`) | Rejected; must be a JSON number. |
| Using a Unix epoch for `reference_time` | RFC3339 only. Wrong format = silent fall-through to "now". |
| Setting `ttl_ms` to a huge value "to be safe" | Long TTLs pin the intent and starve other agents. Pick the actual edit horizon (5–15 min typical). |
| Ignoring `propagation_set` | Those are the nodes other agents will see flagged. Sanity-check that they make sense. |
| Treating an `Exploratory` intent as "publishing nothing" | Exploratory still creates a NodeState entry — useful for later `get_node_state` introspection. |

## Skill Priority

This is the **first MCP call** in any coordinated edit. Pair with:

- End-to-end loop → [`memfleet-safe-edit`](../workflows/memfleet-safe-edit.md)
- Pre-call reconnaissance → [`memfleet-node-state`](memfleet-node-state.md)
- Post-edit reporting → [`memfleet-record-episode`](memfleet-record-episode.md)
- Conflict branch → [`memfleet-conflict-resolution`](../workflows/memfleet-conflict-resolution.md)
