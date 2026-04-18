---
name: memfleet-fleet-status
description: "Use to get a snapshot of fleet coordination health — active intents, open subscriptions, episode count, conflict counts by class. Triggered by: 'how busy is the fleet', 'are there open conflicts', periodic dashboard refresh, pre-release coordination check."
---

# MemFleet — Fleet Status

## When to use

One-shot dashboard. Cheap enough to call every few minutes. Returns:

- Active intents (by repo / by intent_kind)
- Open subscriptions
- Episodes recorded in the last window
- Conflict counts split by class A / B / C
- Quiet nodes vs hot nodes

## MCP tool

`fleet_status(repo_id?, window_ms?)`

Omit `repo_id` to get a cross-repo rollup.

## Pattern

```
// Session opener:
fleet_status({ window_ms: 1_800_000 })  // last 30 min

// Interpret:
//   high class-C count → conflict storm; read each via query_episodes
//   zero active intents → safe to do large refactors
//   conflict_density > threshold on a module → avoid or coordinate
```

## Phase-1 note

The CLI dashboard (`fleet-cli`) is the interactive face of the same data. Use `fleet_status` inside agents, `fleet-cli` for human eyes.
