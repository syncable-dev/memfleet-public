---
name: memfleet-safe-edit
description: "Always use as the end-to-end workflow around any edit in a multi-agent session — get_node_state → publish_intent → edit → record_episode → branch on conflict class. Triggered by: 'implement X', 'rename Y', 'add feature Z', 'apply this fix' when other agents may be active. Do not skip publish_intent because you 'know' the symbol is quiet, do not record_episode with a prose diff_summary instead of a structural one, and do not retry on Class C without reading the conflict report. This is the canonical fleet-safe edit loop."
---

# MemFleet — Safe Edit Workflow

## Overview

The end-to-end protocol that wraps every coordinated edit. Six steps, one MCP tool per step (mostly), with explicit branching on the returned conflict class. Skipping any step turns silent collisions into silent overwrites.

Use this workflow whenever you are about to modify a symbol that other agents could plausibly be touching. For one-shot conflict triage or leader-orchestrated multi-symbol refactors, see the sibling skills under "Skill Priority" below.

## Harness Notes

Examples below use `mcp__memfleet__*` tool names. Substitute `fleet-cli <subcommand>` if your harness has no MCP bridge — the CLI mirrors every tool.

## The Protocol

```
STEP 1  (read)    get_node_state(symbol)            — who's been here?
STEP 2  (lock)    publish_intent(symbol, kind, ttl) — declare + get conflicts
STEP 3  (decide)  if active_conflicts ≠ ∅           — branch to conflict-resolution
STEP 4  (edit)    make your code changes            — your normal edit loop
STEP 5  (report)  record_episode(intent_id, ...)    — classify + update rollup
STEP 6  (class)   branch on returned conflict_class — A done / B replan / C blocked
```

## Steps

### 1. Read — `get_node_state`

```
mcp__memfleet__get_node_state({
  repo_id: "my-repo",
  symbol:  "UserRole",
  last_n:  5
})
```

**Inspect:**
- `dominant_intent` — if it is an in-flight `Refactor(RenameSymbol)` and your plan is another rename → **replan**. Do not proceed.
- `recent_episodes[]` — if your own `Exploratory` intent is in the list, you have already probed this symbol; skip the scout.
- `conflict_density` — high density means this node is a recurring battleground; consider a shorter `ttl_ms` on Step 2.

**Success criteria:** you have a defensible reason to either proceed, replan, or wait.

### 2. Lock — `publish_intent`

```
mcp__memfleet__publish_intent({
  repo_id:    "my-repo",
  symbol:     "UserRole",
  intent_kind:{"Refactor": {"pattern": "RenameSymbol"}},
  ttl_ms:     300000
})
```

Save `r.intent_id` — every subsequent step refers to it.

**Inspect:**
- `r.propagation_set` — these nodes are implicated by your edit. Other agents on those nodes get a structural signal.
- `r.active_conflicts` — non-empty means another agent is already mid-flight on overlapping scope.

**Success criteria:** you have an `intent_id` and you have looked at both `propagation_set` and `active_conflicts`.

### 3. Decide

| `r.active_conflicts` | Action |
|---|---|
| Empty | Proceed to Step 4 |
| Non-empty | STOP. Branch to [`memfleet-conflict-resolution`](memfleet-conflict-resolution.md). Do **not** edit. |

### 4. Edit

Make your code changes through your normal harness loop (Edit / Write / Apply Patch). The protocol does not care how you edit — only that the structural before/after is captured in the next step.

### 5. Report — `record_episode`

```
mcp__memfleet__record_episode({
  intent_id:      r.intent_id,
  diff_summary:   {"Refactor": {"pattern": "RenameSymbol"}},
  touched_nodes:  ["UserRole", "UserRoleRepo.find"],
  reference_time: "2026-04-18T09:30:00Z"
})
```

**Required:**
- `touched_nodes` — every NodeIdentity your diff actually changed (not your `propagation_set`, not the planned set).
- `diff_summary` — the structural shape of the change as an `IntentKind`-compatible enum, **not** prose.
- `reference_time` — RFC3339. Used for LWW arbitration on Class B.

**Success criteria:** the broker returns an `episode_id` and a `conflict_class`.

### 6. Class — branch on `e.conflict_class`

| `conflict_class` | Meaning | Action |
|---|---|---|
| **A** | Additive — pure new symbols, no removals or signature changes | Done. Auto-accepted. |
| **B** | Modification — body / type / rename collides with another in-flight edit | Read `e.won`. If `false`, you lost LWW; read `e.replan_hint` and re-edit on the new target. |
| **C** | Breaking — removes a live symbol or changes a signature with active callers | **Blocked.** Read `e.conflict_report.cause`. Branch to [`memfleet-conflict-resolution`](memfleet-conflict-resolution.md). |

## Decision Points

| Situation | Action |
|---|---|
| `dominant_intent` is your own from earlier this session | Skip Step 1 scout; proceed straight to Step 2 |
| `propagation_set` is huge (hundreds of nodes) | Consider splitting the intent into multiple narrower ones |
| `active_conflicts` payload mentions a `blocker_agent` | Coordinate out-of-band before re-attempting |
| Class B `won: true` | The other agent's edit will replan onto your target |
| Class B `won: false` and `replan_hint.kind == ApplyToRenamedTarget` | Re-edit on the new name; goto Step 5 with a fresh intent |
| Class C | Do not retry blindly. Narrow scope, coordinate, or escalate via `resolve_conflict` (Phase-2) |

## Common Mistakes

| Mistake | Reality |
|---|---|
| Skipping Step 1 because "the symbol is quiet" | `get_node_state` is O(1) — the rollup is precomputed by `record_episode`. There is no cost to checking. |
| Writing a prose `diff_summary` | Prose is what we are replacing. The enum variant IS the coordination signal. |
| Recording multiple episodes for one semantic edit | One episode = one structural change. Multiple records inflate conflict counts. |
| Ignoring `propagation_set` after Step 2 | Those are the nodes other agents will see flagged. Cross-check that they make sense before editing. |
| Retrying on Class C | Class C means active callers will break. Editing forces the breakage. Resolve first. |
| Using a Unix timestamp for `reference_time` | RFC3339 only. The broker arbitrates LWW on this exact field. |
| Assuming silence after `publish_intent` means "no one cares" | The signal goes to NodeState rollups, not push notifications. Other agents see it on their next read. |

## Why not just git

git detects **textual** conflicts after-the-fact at merge time. MemFleet detects **structural** conflicts at intent time, before the wasted edit happens. Both are needed — the Safe Edit Workflow is the upstream half.

## Skill Priority

This is a **process skill** — it runs ONCE per edit, BEFORE the implementation skills you would normally use. Pair with:

- Pre-flight checks → [`memfleet-first`](memfleet-first.md)
- Conflict handling → [`memfleet-conflict-resolution`](memfleet-conflict-resolution.md)
- Multi-agent orchestration → [`memfleet-fleet-coordination`](memfleet-fleet-coordination.md)
- Per-tool deep dives → [`memfleet-publish-intent`](../commands/memfleet-publish-intent.md), [`memfleet-record-episode`](../commands/memfleet-record-episode.md)
