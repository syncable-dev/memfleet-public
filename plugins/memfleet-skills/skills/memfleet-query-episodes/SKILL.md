---
name: memfleet-query-episodes
description: "Use to search episodes across a repository filtered by node, intent type, or time range. Triggered by: 'what changed this morning', 'who last touched the auth module', 'did anyone try X recently', polling for new fleet activity when no subscription is registered."
---

# MemFleet — Query Episodes

## When to use

`query_episodes` is the generic filter. Use it for polling, retrospective analysis, and fleet-wide searches. For per-symbol activity use `get_node_state` (cheaper). For a single episode by id use `get_episode`.

## MCP tools

- `query_episodes(repo_id, filter, limit?, since?)` — filtered list
- `get_episode(episode_id)` — fetch one by id

`filter` accepts:

- `symbol` — a NodeIdentity
- `module` — prefix match
- `intent_kind` — enum variant
- `agent` — the agent that recorded it

## Pattern

```
// Polling (fallback when no subscription):
loop every 5s:
  query_episodes(repo_id, { since: last_cursor }) → new episodes
  advance cursor

// Retrospective:
query_episodes(repo_id, { intent_kind: "BugFix", since: today_start })
```

## Prefer subscriptions

If you are streaming, register a `subscribe` once and consume its notifications (see `memfleet-subscribe`). Polling with `query_episodes` is the fallback.
