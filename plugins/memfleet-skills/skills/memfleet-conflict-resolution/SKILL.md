---
name: memfleet-conflict-resolution
description: "Use when publish_intent or record_episode returned an active conflict or a Class B/C conflict payload. Triggered by: 'publish_intent returned conflicts', 'record_episode classified as B and I lost', 'Class C block', understanding who else is editing, deciding whether to retry / replan / escalate."
---

# MemFleet — Conflict Resolution

## Conflict classes

| Class | Meaning | Resolution |
|---|---|---|
| **A** | Additive — new symbols, no removals | No action. Never blocks. |
| **B** | Modification — body / type / rename | LWW by `reference_time`. Loser replans with `replan_hint`. |
| **C** | Breaking — removes live symbol or changes signature with active callers | Blocked. Human review. |

## Class B — you lost

Your edit's `reference_time` was older than the winning edit's. Read `replan_hint`:

```json
{
  "won": false,
  "winner_episode_id": "01H…",
  "winner_intent_kind": {"Refactor": {"pattern": "RenameSymbol"}},
  "replan_hint": {
    "kind": "ApplyToRenamedTarget",
    "new_name": "UserRoleV2"
  }
}
```

Map your edit onto the new target (e.g. apply the NullHandling fix to `UserRoleV2` instead of `UserRole`) and `record_episode` again with the new touched_nodes.

### Intent-kind auto-merge

`Refactor(RenameSymbol)` + `BugFix(NullHandling)` on the same symbol are orthogonal — the broker can apply both. This is Phase-2 behavior; Phase-1 returns `replan_hint` and lets you do it.

## Class C — blocked

Your intent removes a live symbol OR changes a signature that has active callers. `publish_intent` returns:

```json
{
  "active_conflicts": [{
    "cause": "SignatureChangeWithActiveCallers",
    "callers": ["UserRoleRepo.find", "UserSessionService.check"],
    "blocker_agent": "agent-alice"
  }]
}
```

Do NOT attempt to edit. Options:

1. Narrow the scope — edit only internals, keep signature stable
2. Coordinate out-of-band with `blocker_agent`
3. Call `resolve_conflict` (Phase-2) with prose rationale — the ONLY place prose is required

## Retry pattern

```
r = publish_intent(...)
while r.active_conflicts ≠ ∅:
   wait(exp_backoff)
   ns = get_node_state(symbol)
   if ns.active_intents == [] → retry publish_intent
   if elapsed > deadline → escalate
```
