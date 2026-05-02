---
name: memfleet-node-state
description: "Always use to read current coordination state for a symbol — recent episodes, active intents, dominant intent, conflict density, Y-doc thread. Triggered by: 'is anyone working on X', pre-edit reconnaissance, checking fleet activity on a symbol, reading another agent's recent work, debugging why a publish_intent returned a conflict. Do not grep the codebase to figure out 'who edited this last' — the broker has a precomputed O(1) rollup. Do not call get_node_state in a tight loop expecting push semantics; for streaming, use subscribe."
---

## Overview

Read the precomputed `NodeState` rollup for a symbol. One call returns:

- The N most recent episodes that touched the node
- Every active intent currently targeting it
- The `dominant_intent` (most-recent, most-impactful)
- `conflict_density` — how often edits collide here

This is the query that **replaces "read 500 lines of prose context from other agents"**. Use it before touching any symbol you did not edit yourself in this session.

## Quick Reference

| Tool | Purpose |
|---|---|
| `get_node_state` | Rollup + top-N recent episodes (O(1), precomputed by `record_episode`) |
| `ydoc_read` | Full Y-doc thread + current NodeState blob (richer; use when you need history) |

> **Parameter types:** MCP parameters are strictly typed. `last_n` MUST be a JSON number, not a quoted string. `repo_id` and `symbol` are required string fields.

## Steps

### 1. Identify the symbol

`symbol` is a NodeIdentity — usually the qualified name (`UserRoleRepo.find`, `payments::charge`). The broker treats it as an opaque string keyed by `(repo_id, symbol)`.

### 2. Call `get_node_state`

```
mcp__memfleet__get_node_state({
  repo_id: "my-repo",
  symbol:  "UserRole",
  last_n:  5
})
```

**Parameters:**
- `repo_id` — string, required.
- `symbol` — string, required. NodeIdentity.
- `last_n` — integer, optional. How many recent episodes to include. Default 10, cap 50.

**Success criteria:** the broker returns `dominant_intent`, `active_intents[]`, `recent_episodes[]`, `conflict_density`.

### 3. Interpret the rollup

| Field | Means | Action |
|---|---|---|
| `dominant_intent: null` | Nothing in flight | Safe to publish_intent and edit |
| `dominant_intent` is `Refactor(RenameSymbol)` and your plan is another rename | Active rename in progress | Wait or replan; do NOT publish a competing rename |
| `dominant_intent` is your own from earlier this session | You already scouted | Skip Step 1 of safe-edit; go straight to publish |
| `active_intents.len() > 1` | Multiple agents in scope | Read each; expect contention |
| `conflict_density` high (e.g. > 0.3) | Hot battleground | Use a shorter `ttl_ms` on your `publish_intent` to release fast |
| `recent_episodes[0].conflict_class == "C"` | Last edit was blocked | Investigate before adding more pressure |

### 4. (Optional) Drill into the Y-doc thread

For full history including the CRDT operations, call `ydoc_read`:

```
mcp__memfleet__ydoc_read({
  repo_id: "my-repo",
  symbol:  "UserRole"
})
```

Returns the full Y-doc thread (every CRDT op against the symbol) plus the current NodeState rollup blob. Heavier than `get_node_state` — use only when you need the operation-level history.

## Decision Points

| Situation | Action |
|---|---|
| About to edit an unfamiliar symbol | Call `get_node_state` first; it's O(1), no excuse to skip |
| About to edit a symbol you edited 5 minutes ago | Skip — your own state is fresh |
| Need to know "who is editing X right now" | `active_intents` + their `agent_id` field |
| Debugging a `publish_intent` conflict | `active_intents` shows exactly who is in scope |
| Polling for new activity on a single symbol | `get_node_state` works but is wasteful; prefer [`memfleet-subscribe`](memfleet-subscribe.md) |
| Need the full operation log, not just rollup | `ydoc_read` |

## Common Mistakes

| Mistake | Reality |
|---|---|
| Grepping the codebase to find "who last touched X" | The broker has a precomputed rollup. `get_node_state` is one call. |
| Calling `get_node_state` in a busy poll loop | NodeState is precomputed and cheap, but for streaming use `subscribe` instead — push beats poll. |
| Treating `dominant_intent: null` as "no one is working here ever" | It means no in-flight intent. Recent episodes still tell you who was here. |
| Quoting `last_n` as a string | Must be a JSON number. |
| Using `ydoc_read` when you only need the rollup | `get_node_state` is much cheaper. Reserve `ydoc_read` for full history. |
| Passing a file path as `symbol` | `symbol` is a NodeIdentity (qualified name). File paths are not stable across renames. |

## Scaling Note

`get_node_state` is **O(1)** — the rollup is precomputed by `record_episode`, not recomputed on read. There is no cost to calling it on hot paths like Step 1 of every safe-edit. The whole point is that reads are free; the work happens once at write time.

## Skill Priority

This is a **lookup skill** — typically the first MCP call in a safe-edit. Pair with:

- The end-to-end loop → [`memfleet-safe-edit`](../workflows/memfleet-safe-edit.md)
- The next call (declare intent) → [`memfleet-publish-intent`](memfleet-publish-intent.md)
- Streaming alternative → [`memfleet-subscribe`](memfleet-subscribe.md)
- Fleet-wide rollup → [`memfleet-fleet-status`](memfleet-fleet-status.md)
