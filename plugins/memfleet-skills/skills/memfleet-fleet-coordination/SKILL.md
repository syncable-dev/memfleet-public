---
name: memfleet-fleet-coordination
description: "Use when orchestrating a multi-step fleet edit: large refactors that span many symbols, leader-driven work split across follower agents, or any plan where one agent declares the shape and others execute leaf changes. Triggered by: 'coordinate the fleet on this refactor', 'split this work', 'I'm the leader, watch the followers', 'spread these renames across agents', leader/follower patterns. Do not start the leader phase without first checking fleet_status; do not let followers free-claim leaves without a correlation tag — you will not be able to aggregate results. Skip this skill for single-agent edits and small (≤ 3 symbol) changes where the safe-edit loop alone is enough."
---

# MemFleet — Fleet Coordination

## Overview

The leader/follower pattern for refactors that touch many symbols. The leader declares the coordinated set of intents with a shared correlation tag; followers subscribe, claim leaves off the propagation set, edit, and report back under the same tag. The leader aggregates results, retries Class B losers, and escalates Class C blockers.

This is the workflow for the cases where [`memfleet-safe-edit`](memfleet-safe-edit.md) alone is not enough because no single agent is going to do all the work.

## Harness Notes

Designed for any harness that can hold an MCP session open across multiple tool calls (Claude Code, Codex, Copilot CLI). For one-shot harnesses without persistent sessions, the leader role can be played by `fleet-cli` invocations and the followers can be regular MCP-speaking agents.

## When to use

| Situation | Use this skill? |
|---|---|
| Single-agent edit on 1–3 symbols | No — use [`memfleet-safe-edit`](memfleet-safe-edit.md) |
| Single-agent edit on a large symbol set | Optional — leader-only pattern, no followers |
| Multi-agent refactor with shared scope | **Yes** — full leader/follower |
| Independent edits by parallel agents on disjoint scopes | No — each agent runs `memfleet-safe-edit` independently |
| Emergency hotfix coordinated across services | **Yes** — leader pins the correlation tag, followers gate on it |

## The Pattern

### Leader

```
1. fleet_status({ window_ms: 1_800_000 })
   → confirm the fleet is idle enough for a coordinated wave

2. For each planned symbol S in the refactor:
     publish_intent(repo_id, S, intent_kind, ttl_ms,
                    correlation_tag = TAG)

3. Announce TAG on the shared channel
   (or via a single "kickoff" record_episode with intent_kind = Exploratory
    and a touched_nodes list naming every leaf)

4. subscribe(repo_id, { correlation_tag: TAG })

5. Loop on incoming notifications:
     - On record_episode with class A → mark leaf done
     - On record_episode with class B (won=false) → reissue intent for that leaf
     - On record_episode with class C → ABORT the wave, call resolve_conflict
     - On TTL expiry without an episode → reassign the leaf
```

### Follower

```
1. subscribe(repo_id, { intent_kinds: [Refactor, FeatureAdd], modules: [<area>] })

2. On notification with correlation_tag == TAG:
     - claim by calling publish_intent on the leaf symbol with the same TAG
     - if claim succeeds (no active_conflicts) → memfleet-safe-edit on that leaf
     - if claim fails → another follower beat you to it; skip

3. record_episode for each leaf with the same TAG

4. On any class C → STOP; let the leader handle the wave abort
```

### Correlation tag

Phase-1 has no native `correlation_tag` field. Encode it inside `intent_kind`'s free-form surface until Phase-2 lands the typed field:

```json
{"FeatureAdd": {"surface": {"NewField": "coord=01HXXXX"}}}
{"Refactor":   {"pattern":  {"RenameSymbol": "coord=01HXXXX"}}}
```

Use a fresh ULID per coordinated wave so leaders can disambiguate concurrent waves.

## Steps

### 1. Leader — pre-flight check

```
mcp__memfleet__fleet_status({ window_ms: 1_800_000 })
```

**Inspect:**
- `active_intents` — if a class B/C storm is ongoing on your target modules, abort and reschedule.
- `conflict_density` per module — pick a window where the modules you will touch are below the team's threshold.

**Success criteria:** the affected modules are quiet enough that the wave will not collide with unrelated work.

### 2. Leader — declare the wave

For each symbol in the planned set, call `publish_intent` with the correlation tag baked into the intent kind. Save every returned `intent_id` keyed by symbol — you will need them in Step 5 to match incoming episodes.

### 3. Leader — kickoff signal

Either:
- Post the correlation tag on the team's chat / shared MCP channel, OR
- Record a single `Exploratory` episode with `touched_nodes` naming every leaf and the tag in the surface. Followers see it via `subscribe` or `query_episodes`.

### 4. Follower — claim and execute

When a follower sees a notification matching the tag, it claims the leaf with its own `publish_intent` (under the same tag). If the broker returns `active_conflicts`, the leaf is already claimed — move on. Otherwise run [`memfleet-safe-edit`](memfleet-safe-edit.md) on that leaf and `record_episode` with the tag.

### 5. Leader — aggregate

Watch incoming episodes filtered by the tag. Match them back to the planned set; track A/B/C tallies; reassign on TTL expiry. The wave is done when every planned leaf has a class-A or class-B-won episode under the tag.

## Safety Rails

| Rail | Mechanism |
|---|---|
| **Deadline** | Attach a ULID-derived TTL to every coordinated `intent_id`. If the leader dies, followers time out on the TTL. |
| **Poison** | If any follower returns class C, the leader aborts the whole wave and calls `resolve_conflict` (Phase-2) rather than letting partial state land. |
| **Idempotency** | Each follower's `record_episode` uses the same `intent_id` it claimed with — replays are no-ops. |
| **Leader liveness** | Followers stop claiming new leaves if they have not seen a leader heartbeat (an episode with the tag, by the leader's `agent_id`) within `2 × heartbeat_period`. |

## Phase-1 caveat

`subscribe` push is stub in Phase-1. In practice today both leader and followers poll `query_episodes` with a `since` cursor, filtered by intent surface containing `"coord=<tag>"`. Upgrade to real push subscriptions when Phase-2 lands.

## Common Mistakes

| Mistake | Reality |
|---|---|
| Leader skips `fleet_status` and just publishes the wave | A coordinated wave on top of an existing class-B storm produces an unresolvable mess. |
| Followers claim leaves without the correlation tag | The leader cannot match returned episodes back to the wave. Aggregation breaks. |
| Re-using a correlation tag across waves | Episodes from the prior wave bleed into the new one's aggregate. Always use a fresh ULID. |
| Leader records the kickoff as a `Refactor` instead of `Exploratory` | Followers' classifier treats it as a real edit and may try to claim it as a leaf. Use `Exploratory` for kickoffs. |
| Followers continue after a class C | Class C means the wave's structural premise is broken. Stop and let the leader abort. |
| No TTL on coordinated intents | A dead leader leaves intents pinned forever; the broker has no way to know the wave is dead. |
| Waiting for `subscribe` push in Phase-1 | Push is stub. Poll `query_episodes` with a cursor. |

## Decision Points

| Situation | Action |
|---|---|
| `fleet_status` shows the modules are hot | Reschedule or pick a different time window |
| Follower's claim returns `active_conflicts` | Another follower won; skip the leaf, look for the next |
| Leader sees TTL expire without an episode | Reassign the leaf — issue a fresh `publish_intent` under the tag |
| Class B (won=false) on a coordinated leaf | Reissue the intent at the new target; do not abort the wave |
| Class C on any coordinated leaf | Abort the entire wave; do not let partial state land |
| Wave done, every leaf class A or B-won | Record one final `Exploratory` episode summarising counts; release any leftover intents |

## Skill Priority

This is an **orchestration skill** — it composes [`memfleet-safe-edit`](memfleet-safe-edit.md) across many agents. Pair with:

- The single-edit loop each follower runs → [`memfleet-safe-edit`](memfleet-safe-edit.md)
- Conflict handling within the wave → [`memfleet-conflict-resolution`](memfleet-conflict-resolution.md)
- Fleet-wide pre-flight → [`memfleet-fleet-status`](../commands/memfleet-fleet-status.md)
- Push notifications (Phase-2) → [`memfleet-subscribe`](../commands/memfleet-subscribe.md)
- Polling fallback (Phase-1) → [`memfleet-query-episodes`](../commands/memfleet-query-episodes.md)
