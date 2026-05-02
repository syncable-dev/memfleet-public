---
name: memfleet-subscribe
description: "Use to register a streaming subscription so the broker pushes episode notifications filtered by symbol, module, or intent kind. Triggered by: long-running agent sessions (anything > one edit), follower role in a leader-orchestrated wave, watching a specific module for fleet activity, ops dashboards. Do not register a subscription for a single one-shot edit (use get_node_state and skip the channel). Phase-1 push is stub — verify with a kickoff probe before relying on push semantics."
---

## Overview

Register a long-lived subscription with the broker. The broker pushes episode notifications through the MCP notification channel — filtered, coalesced, and budget-limited by the broker's subscription router.

Use this for any agent that stays resident across more than one edit. Replaces tight `query_episodes` polling loops with push semantics.

> **Phase-1 caveat:** Subscription **push** is stub in Phase-1, and there is no `unsubscribe` tool — subscriptions expire implicitly when the MCP session ends. Until Phase-2 lands real push + `unsubscribe`, fall back to `query_episodes` with a cursor as the reliable streaming pattern. See "Verifying push works" below.

## Quick Reference

| Tool | Purpose |
|---|---|
| `subscribe` | Register a long-lived notification channel; returns `sub_id` |
| `query_episodes` | Phase-1 fallback when push is stub; cursor-based polling |

> **Parameter types:** MCP parameters are strictly typed. `quiet_period_ms` and `budget` MUST be JSON numbers. `intent_kinds` is an array of enum-shaped objects, not flat strings.

## Steps

### 1. Pick the filter shape

The narrower the filter, the lower the noise. Combine any subset:

| Filter field | Type | Example |
|---|---|---|
| `symbols` | string array | `["UserRoleRepo.find", "UserSessionService.check"]` |
| `modules` | string array (prefixes) | `["auth/", "billing/"]` |
| `intent_kinds` | enum array | `[{"Refactor": {}}, {"BugFix": {}}]` |
| `quiet_period_ms` | integer | `5000` (debounce — coalesce notifications fired within this window) |

### 2. Call `subscribe`

```
mcp__memfleet__subscribe({
  repo_id: "my-repo",
  filter:  { modules: ["auth/"], intent_kinds: [{"Refactor": {}}] },
  budget:  100                     // max notifications per minute
})
```

**Parameters:**
- `repo_id` — string, required.
- `filter` — object, optional but strongly recommended (no filter = firehose).
- `budget` — integer, optional. Per-minute cap on notifications. Default 60. The broker drops the oldest when exceeded.

**Success criteria:** the broker returns `sub_id`. Notifications begin arriving on the MCP notification channel (where supported by your harness).

### 3. Process notifications

```
on notification(n):
    if n.intent_kind in {Refactor(RenameSymbol), Cleanup(DeadCode)}:
        invalidate_local_cache(n.touched_nodes)
    elif n.conflict_class == "C":
        alert_human(n)
    else:
        update_dashboard(n)
```

Notifications carry the same shape as `query_episodes` results — episode metadata, intent kind, conflict class, touched nodes, agent_id.

### 4. (Phase-1 fallback) Verify push works; otherwise poll

```
# Kickoff probe: call subscribe, then immediately record a tiny Exploratory
# episode and watch for the notification.
sub_id = subscribe({...})
record_episode({
  intent_id:     <a fresh probe intent>,
  diff_summary:  "Exploratory",
  touched_nodes: ["__sub_probe__"]
})
# wait up to 5s for the notification
```

If the notification never arrives, push is stub — fall back to `query_episodes` with a cursor (see [`memfleet-query-episodes`](memfleet-query-episodes.md)).

## Decision Points

| Situation | Action |
|---|---|
| One-shot edit, single agent | Skip subscribe; use `get_node_state` + `record_episode` |
| Long-running agent (any kind) | Subscribe at session start with the narrowest useful filter |
| Follower role in a leader/follower wave | Subscribe with `intent_kinds: [Refactor, FeatureAdd]` and the wave's module scope; filter further by correlation tag in your handler |
| Ops dashboard watching everything | Subscribe with no `symbols` / `modules` filter but cap with `budget` to avoid firehose |
| Push verification fails (Phase-1) | Drop to `query_episodes` polling with a `since` cursor |
| MCP session is about to end | No `unsubscribe` in Phase-1 — subscription dies with the session |

## Common Mistakes

| Mistake | Reality |
|---|---|
| Subscribing without a filter | You get the firehose. Always filter by module / intent kind / symbol. |
| Subscribing for a one-shot edit | Use `get_node_state` instead — subscriptions are for resident agents. |
| Quoting `quiet_period_ms` or `budget` as strings | Must be JSON numbers. |
| Passing flat strings in `intent_kinds` (`"Refactor"` instead of `{"Refactor": {}}`) | Schema rejects flat strings. Use the JSON-object form. |
| Assuming notifications arrived (Phase-1 push is stub) | Run the kickoff probe (Step 4) to verify. If push doesn't fire, poll. |
| Hoping the broker will deduplicate across overlapping subscriptions | It won't. Pick one filter shape per session. |
| Setting `budget` too low | The broker drops the oldest when exceeded. Low budget = lost notifications under load. |
| Looking for an `unsubscribe` tool in Phase-1 | Doesn't exist yet. Subscriptions die with the MCP session. |

## Skill Priority

This is the **streaming primitive**. Pair with:

- Polling fallback (Phase-1) → [`memfleet-query-episodes`](memfleet-query-episodes.md)
- Per-symbol read → [`memfleet-node-state`](memfleet-node-state.md)
- Multi-agent wave consumption → [`memfleet-fleet-coordination`](../workflows/memfleet-fleet-coordination.md)
