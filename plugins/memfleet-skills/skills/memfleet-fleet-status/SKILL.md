---
name: memfleet-fleet-status
description: "Always use as the once-per-session opener and as the periodic dashboard refresh. Returns active intents, open subscriptions, episode counts, and conflict counts split by class. Triggered by: 'how busy is the fleet', 'are there open conflicts', 'is anyone working on this repo', pre-release coordination check, leader pre-flight before a coordinated wave, periodic ops dashboard. Do not skip this call before launching a multi-symbol refactor — high class-B/C counts mean the wave will collide. Do not use it as a per-symbol query; for that use get_node_state."
---

## Overview

One-shot dashboard for the broker's coordination state across all repos (or one repo if scoped). Cheap enough to call every few minutes; designed to be the session-opener after `memfleet start`.

Returns four things you need for any coordinated decision:

- Active intents (who is working on what, right now)
- Open subscriptions (who is watching what)
- Episodes recorded in the last window (recent activity volume)
- Conflict counts split by class (A/B/C — the health signal)

## Quick Reference

| Tool | Purpose |
|---|---|
| `fleet_status` | Cross-repo or repo-scoped coordination snapshot |

> **Parameter types:** MCP parameters are strictly typed. `window_ms` MUST be a JSON number, not a quoted string. `repo_id` is a string; omit to get a cross-repo rollup.

## Steps

### 1. Pick the window

`window_ms` controls how far back to count episodes and conflicts. Sensible defaults:

| Use case | `window_ms` |
|---|---|
| Session opener | `1_800_000` (30 min) |
| Pre-coordinated-wave check | `300_000` (5 min) — only the freshest signal matters |
| Periodic dashboard refresh | `60_000` (1 min) |
| Daily ops review | `86_400_000` (24 hr) |

### 2. Call `fleet_status`

```
mcp__memfleet__fleet_status({
  repo_id:   "my-repo",        // omit for cross-repo
  window_ms: 1_800_000
})
```

**Parameters:**
- `repo_id` — string, optional. Scope to one repo. Omit for fleet-wide rollup.
- `window_ms` — integer, optional. Lookback window for episode and conflict counts. Default 1,800,000 (30 min).

**Success criteria:** the broker returns active intents, subscriptions, episode count, and conflict counts.

### 3. Interpret the response

| Signal | Meaning | Action |
|---|---|---|
| `active_intents == 0` | Fleet is idle in this window | Safe for large refactors |
| `active_intents` is high but `conflict_count_C == 0` | Healthy busy fleet | Proceed; expect normal Class B arbitration |
| `conflict_count_C > 0` | Active blocking conflicts | Read each via `query_episodes` with `conflict_class: "C"` before adding work |
| `conflict_density` on a module above the team's threshold | That module is a battleground | Avoid it OR coordinate via [`memfleet-fleet-coordination`](../workflows/memfleet-fleet-coordination.md) |
| `episodes_in_window` very high vs baseline | Burst of activity | Likely a coordinated wave in progress; check for shared correlation tags |
| `subscriptions_open == 0` and you expected watchers | Phase-1 stub or watchers crashed | Don't rely on push; poll `query_episodes` instead |

## Decision Points

| Situation | Action |
|---|---|
| Session opener | Call once with `window_ms: 1_800_000`; cache the result for the rest of the session |
| About to launch a coordinated wave (leader role) | Call with `window_ms: 300_000`; if any class-C is open, abort the wave |
| Periodic dashboard | Call with `window_ms: 60_000` every few minutes; show deltas |
| Need per-symbol activity | This tool is the wrong shape — use `get_node_state` instead |
| Need to filter by intent_kind | Combine with `query_episodes(intent_kind=...)`; `fleet_status` is unfiltered by design |
| Cross-repo rollup | Omit `repo_id` |

## Common Mistakes

| Mistake | Reality |
|---|---|
| Using `fleet_status` for per-symbol checks | `fleet_status` is a global rollup. For per-symbol, use `get_node_state`. |
| Skipping it before a coordinated wave | A wave on top of an open Class C produces unresolvable state. Always pre-check. |
| Quoting `window_ms` as a string | Must be a JSON number. |
| Treating `subscriptions_open == 0` as a bug | Phase-1 subscriptions are stub. Poll instead. |
| Calling it in a tight loop | Designed for periodic refresh, not continuous polling. Every-few-minutes is fine; every-second is wasteful. |

## Phase-1 Note

`fleet-cli` is the interactive face of the same data. Use `fleet_status` inside agents and `fleet-cli` for human eyes. Both go through the same broker tool; they cannot disagree.

## Skill Priority

This is a **session-opener** + periodic ops tool. Pair with:

- Per-symbol equivalent → [`memfleet-node-state`](memfleet-node-state.md)
- Filtered episode views (e.g., conflict inbox) → [`memfleet-query-episodes`](memfleet-query-episodes.md)
- Pre-flight for a leader-orchestrated wave → [`memfleet-fleet-coordination`](../workflows/memfleet-fleet-coordination.md)
