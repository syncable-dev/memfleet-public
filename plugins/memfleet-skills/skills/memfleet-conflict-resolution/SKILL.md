---
name: memfleet-conflict-resolution
description: "Always use when publish_intent returned a non-empty active_conflicts list, or when record_episode classified the result as Class B (you may have lost LWW) or Class C (blocked). Triggered by: 'publish_intent returned conflicts', 'I got a Class B and lost', 'Class C blocker_agent', 'who is blocking my edit', deciding whether to retry, replan, or escalate. Do not retry blindly on Class B without reading replan_hint, do not edit through a Class C — it will break active callers — and do not invent a prose 'rationale'; structural conflicts get structural resolutions."
---

# MemFleet — Conflict Resolution

## Overview

Decision tree for the two conflict shapes the broker can hand back: pre-edit conflicts surfaced by `publish_intent`, and post-edit classifications surfaced by `record_episode`. Both reduce to the same A/B/C taxonomy.

The classifier is structural — it knows about renames, signature changes, and active callers, not about the prose intent of your edit. Resolution is therefore also structural: replan onto a new target, narrow scope, or escalate.

## Harness Notes

Examples below use `mcp__memfleet__*` tool names. The same flows work via `fleet-cli` for harnesses without MCP.

## Conflict Classes

| Class | Meaning | Resolution |
|---|---|---|
| **A** | Additive — pure new symbols, no removals or signature changes | No action. Class A never blocks. |
| **B** | Modification — body / type / rename collides with another in-flight edit on the same symbol | LWW arbitration by `reference_time`. The loser reads `replan_hint` and re-edits onto the new target. |
| **C** | Breaking — the intent removes a live symbol or changes a signature with active callers | Blocked. Human or leader-agent review. Do not retry without resolving. |

## Steps

### 1. Identify which surface gave you the conflict

| Source | Field that carries the conflict | What it means |
|---|---|---|
| `publish_intent` | `active_conflicts[]` | Pre-edit — another agent already declared overlapping intent |
| `record_episode` | `conflict_class` (+ `conflict_report` for C, `replan_hint` for B) | Post-edit — your finished edit collided with a parallel one |

Pre-edit conflicts are cheap to resolve (you have not edited yet). Post-edit conflicts are more expensive (you may have to redo work). Either way, the resolution rules below apply.

### 2. Class B — you may have lost LWW

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

**If `won: true`:** the other agent will replan onto your target. You are done.

**If `won: false`:** read `replan_hint.kind` and act:

| `replan_hint.kind` | Action |
|---|---|
| `ApplyToRenamedTarget` | Re-apply your fix to `replan_hint.new_name` instead of the original symbol. |
| `MergeIntoRefactoredBody` | The body you patched was rewritten; rebase your hunk onto the new body. |
| `NoOpYourEditWasSubsumed` | The winner's edit already includes your change. Drop your work. |
| `EscalateToHuman` | The conflict cannot be auto-replanned. Hand off to a human or leader agent. |

After replanning, go back to [`memfleet-safe-edit`](memfleet-safe-edit.md) Step 2 with a fresh `publish_intent` on the new target.

### 3. Class B intent-kind auto-merge (Phase-2)

`Refactor(RenameSymbol)` + `BugFix(NullHandling)` on the same symbol are orthogonal — the broker can apply both. This is **Phase-2** behaviour; Phase-1 returns `replan_hint` and lets you do the merge manually. If you see a Phase-2 broker auto-merge, you will get `won: true, auto_merged: true` and no replan is needed.

### 4. Class C — blocked

```json
{
  "active_conflicts": [{
    "cause": "SignatureChangeWithActiveCallers",
    "callers": ["UserRoleRepo.find", "UserSessionService.check"],
    "blocker_agent": "agent-alice"
  }]
}
```

**Do NOT edit.** Choose one of:

1. **Narrow scope** — keep the public signature stable; edit only internals. Re-`publish_intent` with the narrower scope and verify Class C clears.
2. **Coordinate out-of-band** with `blocker_agent` (chat, ticket, leader agent). Once they ack, retry.
3. **Phase-2 escalation** — call `resolve_conflict` with a prose rationale. This is the **only** place prose is required in the protocol; everywhere else uses structural enums.

### 5. Retry pattern

When you have replanned (Class B) or coordinated (Class C), use exponential backoff to avoid thrashing the broker:

```
attempt = 0
while True:
    r = publish_intent(...)
    if not r.active_conflicts:
        break
    attempt += 1
    if attempt > MAX_ATTEMPTS or elapsed > deadline:
        escalate()
    sleep(min(2 ** attempt, 60))    # cap at 60s
    ns = get_node_state(symbol)
    if not ns.active_intents:
        continue                     # blocker has cleared, retry now
```

**Success criteria:** `r.active_conflicts == []` OR you have escalated.

## Decision Points

| Situation | Action |
|---|---|
| `publish_intent` returns A-only conflicts | A is never blocking; proceed. |
| `record_episode` returns Class A | Done; no action. |
| Class B `won: true` | Done; the loser replans. |
| Class B `won: false` + `replan_hint.kind == ApplyToRenamedTarget` | Re-edit on `new_name` and re-record. |
| Class B `won: false` + `replan_hint.kind == NoOpYourEditWasSubsumed` | Drop your edit; record nothing further. |
| Class C with `blocker_agent` named | Coordinate first; do not retry blindly. |
| Class C with no `blocker_agent` (system-level lock) | Wait for the lock to clear; poll `get_node_state`. |
| Repeated Class C across retries on same symbol | Escalate. The structural change is genuinely incompatible. |

## Common Mistakes

| Mistake | Reality |
|---|---|
| Retrying on Class C | Active callers will break. Editing through a C is the protocol violation it is designed to prevent. |
| Ignoring `replan_hint` and re-editing the original symbol | The original symbol may not exist anymore. The hint is the only structurally-correct replan target. |
| Writing a prose explanation in `diff_summary` to "resolve" the conflict | `diff_summary` is the structural shape, not the narrative. Prose belongs only in `resolve_conflict` (Phase-2). |
| Treating Class A as a conflict | A is the success case for additive edits. No action is the correct action. |
| Tight retry loops without backoff | The blocker_agent may be mid-edit. Backoff gives them room to finish. |
| Re-using the original `intent_id` after replanning | Replans are new intents. Publish a fresh one and use the new `intent_id`. |
| Assuming `active_conflicts: []` on a re-poll means the conflict is resolved | The blocker may have just released their intent's TTL. Verify with `get_node_state` before re-editing. |

## Skill Priority

This is a **branch skill** — it is reached when [`memfleet-safe-edit`](memfleet-safe-edit.md) Steps 3 or 6 detect a non-empty conflict. Pair with:

- Mainline edit loop → [`memfleet-safe-edit`](memfleet-safe-edit.md)
- Pre-edit reconnaissance → [`memfleet-node-state`](../commands/memfleet-node-state.md)
- Multi-agent escalation → [`memfleet-fleet-coordination`](memfleet-fleet-coordination.md)
- Conflict-inbox queries → [`memfleet-query-episodes`](../commands/memfleet-query-episodes.md) (`conflict_class: "B"` or `"C"`)
