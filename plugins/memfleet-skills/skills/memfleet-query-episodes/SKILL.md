---
name: memfleet-query-episodes
description: "Always use to search episodes across a repository filtered by node, intent type, conflict class, time range, or agent. Triggered by: 'what changed this morning', 'who last touched the auth module', 'show me the conflict inbox', 'did anyone try X recently', polling for new fleet activity when no subscription is registered, post-incident retrospective. Do not use it for per-symbol activity (get_node_state is cheaper) or for fetching a single known episode (use get_episode). Polling with query_episodes is the FALLBACK when subscribe push is unavailable; in Phase-2, prefer subscribe."
---

## Overview

The generic, filtered episode search. Use it for:

- **Polling** — fall-back streaming when `subscribe` push is unavailable (Phase-1)
- **Retrospective** — "what changed in the auth module this morning"
- **Conflict inbox** — `conflict_class: "B"` or `"C"` to find episodes that need attention
- **Audit** — every coordinated edit, by intent kind / agent / time range

For per-symbol activity, use [`memfleet-node-state`](memfleet-node-state.md) (cheaper, precomputed). For a single known `episode_id`, use `get_episode`.

## Quick Reference

| Tool | Purpose |
|---|---|
| `query_episodes` | Filtered episode list with cursor-based pagination |
| `get_episode` | Fetch one episode by `episode_id` |

> **Parameter types:** MCP parameters are strictly typed. `limit` MUST be a JSON number. `since` is an opaque cursor string returned by a prior call (NOT a timestamp). `intent_kind` and `conflict_class` are JSON-shaped enum filters.

## Steps

### 1. Pick the filter

Build a `filter` object from any subset of:

| Filter field | Type | Example |
|---|---|---|
| `symbol` | string (NodeIdentity) | `"UserRoleRepo.find"` |
| `module` | string (prefix) | `"auth/"` |
| `intent_kind` | enum | `{"BugFix": {}}` (matches any BugFix variant) |
| `conflict_class` | enum (`"A"` / `"B"` / `"C"`) | `"C"` (the conflict inbox) |
| `agent` | string (`agent_id`) | `"agent-alice"` |

Multiple fields AND together. Empty filter returns everything (use with `limit`).

### 2. Call `query_episodes`

```
mcp__memfleet__query_episodes({
  repo_id: "my-repo",
  filter:  { intent_kind: {"BugFix": {}}, since_time: "2026-04-18T00:00:00Z" },
  limit:   50,
  since:   "01H…"          // optional cursor from prior call
})
```

**Parameters:**
- `repo_id` — string, required.
- `filter` — object, optional. See table above.
- `limit` — integer, optional. Page size. Default 25, cap 200.
- `since` — string (cursor), optional. Pass the `next_cursor` from a prior page to continue.

**Success criteria:** the broker returns `episodes[]` and `next_cursor` (or null when the page is the last one).

### 3. (Optional) Fetch one by id

```
mcp__memfleet__get_episode({ episode_id: "01H…" })
```

Returns the full episode payload — useful when `query_episodes` returned only metadata and you want the full diff_summary, conflict_report, or replan_hint.

## Standard Patterns

### Polling fallback (Phase-1, when `subscribe` push is stub)

```
cursor = None
while True:
    r = query_episodes({
        repo_id: "my-repo",
        filter:  { module: "auth/" },
        limit:   50,
        since:   cursor
    })
    handle(r.episodes)
    cursor = r.next_cursor or cursor
    sleep(5)
```

The cursor is opaque — pass it through unchanged. The broker guarantees no episode is returned twice across a continuous cursor chain.

### Conflict inbox

```
mcp__memfleet__query_episodes({
  repo_id: "my-repo",
  filter:  { conflict_class: "C" },
  limit:   100
})
```

This is the "what's broken right now" list. Class C means active callers will break — every entry is a real blocker.

### Retrospective ("what did the BugFix wave this morning touch?")

```
mcp__memfleet__query_episodes({
  repo_id: "my-repo",
  filter:  { intent_kind: {"BugFix": {}}, since_time: "2026-04-18T00:00:00Z" },
  limit:   100
})
```

### Single agent's recent work

```
mcp__memfleet__query_episodes({
  repo_id: "my-repo",
  filter:  { agent: "claude-code-session-42" },
  limit:   50
})
```

## Decision Points

| Situation | Action |
|---|---|
| You want per-symbol activity | Use `get_node_state`, NOT `query_episodes` (rollup is precomputed) |
| You have a single `episode_id` | Use `get_episode`, not a filtered query |
| You want push, not poll | Register `subscribe`; fall back to `query_episodes` only if Phase-1 push is stub |
| Result list is huge (> page size) | Use `next_cursor` to paginate; do NOT increase `limit` past the cap |
| You want to filter by multiple intent kinds | Multiple calls in parallel, OR omit the kind filter and post-filter in your code |
| Investigating a class-C blocker | Combine `conflict_class: "C"` filter with `module:` prefix to scope |

## Common Mistakes

| Mistake | Reality |
|---|---|
| Using `query_episodes` for per-symbol checks | `get_node_state` is O(1) and precomputed. `query_episodes` scans. |
| Treating `since` as a timestamp | `since` is an opaque cursor from a prior call. Use `since_time` in the filter for time-window queries. |
| Quoting `limit` as a string | Must be a JSON number. |
| Building a poll loop without a cursor | You will re-process the same episodes each poll. Always thread `next_cursor` through. |
| Polling at sub-second intervals | The broker is not rate-limited but you are wasting resources. 1–5s polls are typical. |
| Ignoring `next_cursor: null` | Null means you've reached the end; do not keep polling forward without new activity. |
| Filtering by `conflict_class: "A"` | Class A is auto-accepted noise. Filter on B/C for actionable items. |

## Skill Priority

This is the **fallback streaming + retrospective** tool. Pair with:

- Push streaming (Phase-2) → [`memfleet-subscribe`](memfleet-subscribe.md)
- Per-symbol O(1) read → [`memfleet-node-state`](memfleet-node-state.md)
- Fleet-wide rollup → [`memfleet-fleet-status`](memfleet-fleet-status.md)
- Conflict handling for items in the C inbox → [`memfleet-conflict-resolution`](../workflows/memfleet-conflict-resolution.md)
