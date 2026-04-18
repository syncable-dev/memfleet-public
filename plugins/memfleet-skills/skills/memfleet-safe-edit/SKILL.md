---
name: memfleet-safe-edit
description: "Use as the end-to-end workflow around any edit in a multi-agent session — publish intent → check node state → edit → record episode → handle conflict class. Triggered by: 'implement X', 'rename Y', 'add feature Z' when other agents may be active. This is the canonical fleet-safe edit loop."
---

# MemFleet — Safe Edit Workflow

## The protocol

```
STEP 1  (read)   get_node_state(symbol)
STEP 2  (lock)   publish_intent(symbol, intent_kind, ttl_ms)
STEP 3  (decide) if active_conflicts ≠ ∅ → memfleet-conflict-resolution
STEP 4  (edit)   make your changes
STEP 5  (report) record_episode(intent_id, diff_summary, touched_nodes)
STEP 6  (class)  branch on returned conflict_class
```

## Full pattern

### Step 1 — read

```
ns = get_node_state(repo_id="my-repo", symbol="UserRole", last_n=5)
```

If `ns.dominant_intent` is a running `Refactor(RenameSymbol)` and your plan is another rename → replan. Do not proceed.

### Step 2 — lock

```
r = publish_intent(
  repo_id="my-repo",
  symbol="UserRole",
  intent_kind={"Refactor": {"pattern": "RenameSymbol"}},
  ttl_ms=300_000
)
```

Save `r.intent_id`. Read `r.propagation_set` — those nodes are implicated.

### Step 3 — decide

If `r.active_conflicts` is non-empty: `memfleet-conflict-resolution`. Do NOT edit.

### Step 4 — edit

Make your code changes.

### Step 5 — report

```
e = record_episode(
  intent_id=r.intent_id,
  diff_summary={"Refactor": {"pattern": "RenameSymbol"}},
  touched_nodes=["UserRole", "UserRoleRepo.find"],
  reference_time="2026-04-18T09:30:00Z"
)
```

### Step 6 — class

| `e.conflict_class` | Action |
|---|---|
| `A` | done — additive, auto-accepted |
| `B` | check `e.won == true`; if false, the other agent's edit wins LWW — read `e.replan_hint` |
| `C` | blocked — read `e.conflict_report.cause` and coordinate out-of-band |

## Why not just git

git detects textual conflicts after-the-fact at merge time. MemFleet detects structural conflicts at intent time, before the wasted edit happens. Both are needed.
