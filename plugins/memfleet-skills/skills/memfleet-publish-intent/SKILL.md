---
name: memfleet-publish-intent
description: "Use BEFORE modifying any symbol in a multi-agent session to register structural intent and surface blast radius + active conflicts. Triggered by: about to refactor/rename/delete/modify code, planning an edit, checking if another agent is working on the same area, pre-edit coordination."
---

# MemFleet — Publish Intent

## When to use

Call `publish_intent` **before you edit**. It returns the precomputed blast radius (propagation set) and any active conflicts so you can replan before writing code instead of discovering the collision at merge time.

## MCP tool

`publish_intent(repo_id, symbol, intent_kind, reference_time, ttl_ms?)`

- `intent_kind` is one of the 9 typed variants:
  - `Refactor { pattern: RenameSymbol | ExtractFunction | ... }`
  - `FeatureAdd { surface: NewSymbol | NewField | ... }`
  - `BugFix { defect: NullHandling | RaceCondition | ... }`
  - `Cleanup { kind: DeadCode | FormatOnly | ... }`
  - `Performance { axis: Latency | Memory | ... }`
  - `SecurityFix { severity, cve? }`
  - `TestAdd { covers: [NodeIdentity] }`
  - `DocsOnly`
  - `Exploratory`

Pass the enum variant as JSON — do not compress to a string.

## Pattern

```
1. Identify the target symbol (use a symbol-search tool if unsure — `memtrace-search` when Memtrace is installed, otherwise your editor's go-to-definition)
2. Pick the IntentKind variant that matches your planned edit
3. Call publish_intent → read active_conflicts + propagation_set
4. If conflicts exist → consult memfleet-conflict-resolution
5. Otherwise proceed with the edit, then memfleet-record-episode
```

## Return shape

```json
{
  "intent_id": "01H…",
  "propagation_set": ["UserRoleRepo", "UserSessionService"],
  "active_conflicts": []
}
```

Read `propagation_set` — those are the nodes your edit will ripple into. Any teammates editing them get a structural signal.
