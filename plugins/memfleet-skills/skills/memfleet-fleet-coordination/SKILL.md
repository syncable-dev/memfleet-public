---
name: memfleet-fleet-coordination
description: "Use when orchestrating a multi-step fleet edit involving multiple agents, multi-symbol refactors, or when you are the leader agent coordinating followers. Triggered by: 'coordinate agents on this refactor', 'split this work across the fleet', 'watch the fleet while I drive a large change', leader-follower patterns."
---

# MemFleet — Fleet Coordination

## When to use

Large refactors that touch many symbols benefit from a leader/follower pattern. The leader publishes a coordinated set of intents; followers subscribe and pick work off the propagation set.

## The pattern

### Leader

```
1. fleet_status(window_ms=1_800_000) — confirm the fleet is idle enough
2. For each planned symbol, publish_intent with a common correlation tag
3. Announce the correlation tag on the shared MCP channel (or via a single "kickoff" episode)
4. Subscribe with the correlation tag filter
5. Wait for followers' record_episode events → aggregate class, retry losers, escalate C
```

### Follower

```
1. Subscribe to { intent_kinds: [Refactor, FeatureAdd], modules: [<area>] }
2. On notification, if correlation_tag matches → claim with a publish_intent of your own on the leaf symbol
3. If claim succeeds → memfleet-safe-edit on that symbol
4. Report back via record_episode with the correlation tag
```

### Correlation tag

Since Phase-1 does not have a native tag field, encode the tag in `intent_kind`'s free-form surface (e.g. `FeatureAdd { surface: NewField("coord=<ulid>") }`) until Phase-2 adds it.

## Safety rails

- **Deadline** — attach a ULID to every coordinated intent. If the leader dies, followers time out on the ULID's ttl.
- **Poison** — if any follower returns Class C on a coordinated intent, the leader aborts and calls `resolve_conflict` (Phase-2) rather than letting partial state land.
- **Idempotency** — each follower's `record_episode` uses the same intent_id it claimed with; replays are no-ops.

## Phase-1 caveat

Subscriptions are stub. In practice today, leader + followers poll `query_episodes` with a `since` cursor and filter by the correlation tag embedded in the intent surface. Upgrade to real push subscriptions in Phase-2.
