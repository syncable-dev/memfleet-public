---
name: memfleet-record-episode
description: "Use IMMEDIATELY AFTER an edit completes to record the structural episode, classify A/B/C conflict class, and update NodeState rollups for all touched + propagated nodes. Triggered by: finished writing code, about to commit, reporting edit completion to the fleet."
---

# MemFleet — Record Episode

## When to use

Call `record_episode` the moment you finish an edit. The broker:

1. Classifies the conflict class (A additive, B modification, C breaking) from the diff + active intent registry
2. Precomputes the transitive impact set once
3. Updates the `NodeState` rollup on every touched + propagated node

Every other agent that subsequently reads any of those nodes gets the O(1) picture. You never re-emit — one call per edit.

## MCP tool

`record_episode(intent_id, diff_summary, touched_nodes, reference_time)`

- `intent_id` — the ULID returned from `publish_intent`
- `touched_nodes` — the NodeIdentity array of symbols your diff actually changed
- `diff_summary` — structural, not prose. Use an `IntentKind`-compatible enum.

## Pattern

```
1. Finish your edit
2. Enumerate the symbols you actually touched (file + line or qualified name)
3. Call record_episode with the intent_id from step 1 of the flow
4. If class == C → STOP and read the conflict payload (memfleet-conflict-resolution)
5. If class == B → merge is LWW by reference_time; check if you lost
6. If class == A → you're done
```

## Anti-patterns

- Do NOT write a prose "rationale". The enum variant is the coordination signal. Prose is what we are replacing.
- Do NOT call `record_episode` multiple times for a single semantic edit. One episode = one structural change.
