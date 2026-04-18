---
name: memfleet-node-state
description: "Use to read current coordination state for a symbol — recent episodes, active intents, dominant intent, conflict density, Y-doc thread. Triggered by: 'is anyone working on X', pre-edit reconnaissance, checking fleet activity on a symbol, reading another agent's recent work."
---

# MemFleet — Node State

## When to use

Before touching an unfamiliar symbol, read its `NodeState` rollup. In one call you get:

- The N most recent episodes on this node
- Every active intent targeting it
- The dominant intent (most-recent, most-impactful)
- Conflict density (how often edits collide here)

This is the query that replaces "read 500 lines of prose from other agents".

## MCP tools

- `get_node_state(repo_id, symbol, last_n?)` — rollup + top episodes (O(1))
- `ydoc_read(repo_id, symbol)` — full thread + current NodeState blob

## Pattern

```
1. get_node_state on the symbol you are about to touch
2. If dominant_intent is a Refactor(RenameSymbol) in-flight → wait or replan
3. If conflict_density is high → assume collision, publish_intent with shorter TTL
4. If recent episodes include your Exploratory intent → you already probed here
```

## Scaling note

`get_node_state` is synchronous and O(1) — the rollup is precomputed by `record_episode`. Do not worry about calling it on hot paths.
