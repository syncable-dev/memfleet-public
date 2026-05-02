---
name: memfleet-record-episode
description: "Always use IMMEDIATELY AFTER an edit completes to record the structural episode, classify A/B/C conflict class, and update NodeState rollups for all touched + propagated nodes. Triggered by: finished writing code, about to commit, reporting edit completion to the fleet, multi-agent wave follower reporting back. Do not record multiple episodes for one semantic edit, do not pass a prose diff_summary, and do not delay the call until 'end of session' — every other agent reads stale rollups until you record."
---

## Overview

Report a finished edit to the broker. The broker:

1. Classifies the conflict class (A additive, B modification, C breaking) from the diff + the active intent registry.
2. Precomputes the transitive impact set once, so downstream `get_node_state` reads are O(1).
3. Updates the NodeState rollup on every touched + propagated node.

Every agent that subsequently reads any of those nodes gets the rollup picture immediately. You never re-emit — **one episode per semantic edit**.

## Quick Reference

| Tool | Purpose |
|---|---|
| `record_episode` | Report a finished edit; get back a class A/B/C |
| `publish_intent` | (Pre-call) the intent whose `intent_id` you reference here |
| `get_node_state` | (Optional, post-call) verify the rollup updated as expected |

> **Parameter types:** MCP parameters are strictly typed. `diff_summary` MUST be a JSON object naming the IntentKind variant (same shape as `publish_intent`'s `intent_kind`). `reference_time` MUST be RFC3339 — it is the LWW arbitration field for Class B.

## Steps

### 1. Finish your edit

Make all your code changes through your normal harness loop. Do not call `record_episode` mid-edit; wait until the diff is final.

### 2. Enumerate the touched nodes

`touched_nodes` is the set of NodeIdentities your diff actually changed — not the planned set, not the `propagation_set` from `publish_intent`. The broker uses this to update the right rollups.

If your edit changed:
- A function body → the function's NodeIdentity
- A type signature → the type AND every method/field whose signature changed
- A module-level constant → the constant's NodeIdentity (and any shadowing locals)

### 3. Call `record_episode`

```
mcp__memfleet__record_episode({
  intent_id:      "01H…",                       // from publish_intent
  diff_summary:   {"Refactor": {"pattern": "RenameSymbol"}},
  touched_nodes:  ["UserRole", "UserRoleRepo.find"],
  reference_time: "2026-04-18T09:30:00Z"
})
```

**Parameters:**
- `intent_id` — string (ULID), required. The intent you published before editing.
- `diff_summary` — JSON object, required. The structural shape of the change as an `IntentKind`-compatible enum, NOT prose.
- `touched_nodes` — string array, required. The NodeIdentities your diff actually changed.
- `reference_time` — RFC3339 string, required. Used for LWW arbitration on Class B collisions.
- `agent_id` — string, optional. Useful for `query_episodes` filtering downstream.

**Success criteria:** the broker returns `episode_id`, `conflict_class`, and (for B/C) `won` / `replan_hint` / `conflict_report`.

### 4. Branch on the returned class

| `conflict_class` | Meaning | Action |
|---|---|---|
| **A** | Additive — new symbols, no signature changes, no removals | Done. Auto-accepted. |
| **B** | Modification collides with another in-flight edit on the same symbol | Read `won`. If `false`, follow `replan_hint`. See [`memfleet-conflict-resolution`](../workflows/memfleet-conflict-resolution.md). |
| **C** | Breaking — removes live symbol or changes a signature with active callers | Blocked. Read `conflict_report.cause`. Branch to [`memfleet-conflict-resolution`](../workflows/memfleet-conflict-resolution.md). |

## Decision Points

| Situation | Action |
|---|---|
| You are part of a leader/follower wave | Use the wave's correlation tag in `diff_summary`'s surface so the leader can match your episode |
| The edit was a no-op (you decided not to change anything) | Skip `record_episode` — there is nothing structural to report. Optionally release the intent. |
| Your diff also touched test files | Decide: was the test for the same symbol (include in `touched_nodes`) or a parallel `TestAdd` (publish a separate intent)? |
| Class B `won: true` | Done; the loser will replan. |
| Class B `won: false` | Re-edit on `replan_hint`'s target; record a fresh episode under a new intent. |
| Class C | Do NOT retry. Coordinate first. |

## Common Mistakes

| Mistake | Reality |
|---|---|
| Writing a prose `diff_summary` ("Renamed UserRole to UserRoleV2 because…") | Prose is what we are replacing. The enum variant IS the coordination signal. |
| Recording multiple episodes for one semantic edit | One episode = one structural change. Multiples inflate conflict counts and confuse the rollup. |
| Delaying the call until end-of-session | Every other agent reads stale rollups until you record. Call immediately after the edit. |
| Putting the planned set in `touched_nodes` instead of what actually changed | The broker can't trust your propagation if the touched set is wrong. Be precise. |
| Reusing `intent_id` from a prior session | The intent has TTL'd out. Publish a fresh intent for the current edit. |
| Quoting `reference_time` as Unix epoch ("1735689600") | RFC3339 only. Wrong format silently breaks LWW arbitration. |
| Skipping `record_episode` after an `Exploratory` intent | Even probes should record (often as `DocsOnly` or another `Exploratory`) so the rollup shows the symbol was scouted. |

## Skill Priority

This is the **last MCP call** in the safe-edit loop. Pair with:

- The intent you reference → [`memfleet-publish-intent`](memfleet-publish-intent.md)
- The end-to-end loop → [`memfleet-safe-edit`](../workflows/memfleet-safe-edit.md)
- Conflict-class branching → [`memfleet-conflict-resolution`](../workflows/memfleet-conflict-resolution.md)
- Post-record verification → [`memfleet-node-state`](memfleet-node-state.md)
