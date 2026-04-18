---
name: memfleet-subscribe
description: "Use to register a streaming subscription so the broker pushes episode notifications filtered by symbol, module, or intent kind. Triggered by: long-running agent sessions, need for push-based coordination, watching a specific module for fleet activity."
---

# MemFleet — Subscribe

## When to use

When your agent stays resident for more than one edit, register a subscription instead of polling. The broker pushes episode notifications through the MCP notification channel — filtered, coalesced, and budget-limited by the broker's subscription router.

## MCP tool

`subscribe(repo_id, filter, budget?)`

Returns a `sub_id`. Notifications arrive on the MCP channel.

`filter` accepts:

- `symbols` — exact NodeIdentity list
- `modules` — prefix matches
- `intent_kinds` — enum variants to watch
- `quiet_period_ms` — debounce window

## Pattern

```
session_start:
  sub_id = subscribe(repo_id, { modules: ["auth/"] })

session_loop:
  on notification:
    if intent_kind ∈ {Refactor(RenameSymbol), Cleanup(DeadCode)}:
      invalidate local cache for notification.nodes
    else:
      inform the user / replan

session_end:
  // unsubscribe is Phase-2; for Phase-1 the sub_id is implicitly dropped when the MCP session ends
```

## Phase-1 note

In Phase 1, subscription push is stub and there is no `unsubscribe` tool — subscriptions expire implicitly when the MCP session ends. Use `query_episodes` with a cursor as the reliable streaming pattern until Phase 2 lands push + `unsubscribe`.
