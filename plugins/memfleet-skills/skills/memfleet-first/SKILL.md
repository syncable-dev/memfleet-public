---
name: memfleet-first
description: "Always use FIRST in any multi-agent session before reading code, planning a refactor, or making an edit on a repo with a registered MemFleet broker. Triggered by: 'I'm about to edit X', 'rename Y across the fleet', 'plan this refactor', joining a running fleet session, coordinating with other agents, prose hand-offs between agents. Do not write a prose rationale for an edit, do not grep for 'who else might be touching this', and do not skip publish_intent because 'it's just a small change'. Empty fleet_status is not permission to skip the protocol — it just means you're the first agent in this window. Skip ONLY for solo-agent sessions with no broker registered or for pure docs-only edits where coordination has zero value."
---

# MemFleet First

## The Iron Law

```
IN A MULTI-AGENT SESSION → MEMFLEET TOOLS BEFORE EDITS. NO EXCEPTIONS.
  1. publish_intent  (declare structural intent, get blast radius + conflicts)
  2. edit            (your normal edit loop)
  3. record_episode  (classify A/B/C, update NodeState rollups for the fleet)
```

MemFleet is the **coordination memory** of the fleet, not a chat channel. Every edit is a typed structural event with a known blast radius. Skipping the protocol means silent collisions, overwrites at merge time, and the rest of the fleet wasting tokens re-reading work you already did.

**A typed intent serializes to ~20 tokens. A prose rationale averages 200+. A 10-agent fleet × 100 edits = 90,000 tokens saved per fleet-turn when the protocol is followed.**

## Harness Notes — Claude Code, Codex, Copilot

MemFleet ships as a single MCP server consumed by every harness. The skill is harness-agnostic:

- **Claude Code / Codex / Copilot CLI** — call MemFleet tools by their MCP names (`mcp__memfleet__publish_intent`, etc.). All examples below use this prefix.
- **Editor harness without an MCP bridge** — fall back to `fleet-cli` for the same operations; the CLI mirrors every MCP tool one-to-one.
- **Stdio-only harness** — set `MEMFLEET_STDIO=1` so the broker exposes the stdio MCP transport; otherwise it stays HTTP-only on `:3040/mcp`.

If your harness lacks structured MCP-tool argument validation, pass enum variants as JSON (see Parameter Types below) — string-flattened forms like `"Refactor(RenameSymbol)"` will be rejected.

## Check Broker First (Once Per Session)

```
mcp__memfleet__fleet_status({ window_ms: 1_800_000 })
```

If the broker responds → MemFleet is active. Follow this skill for every coordinated edit.
If it does not respond → no broker registered for this session; offer to start one with `memfleet start`, then follow this skill.

## Routing — Question → Skill

| You are about to… | Call first | Then |
|---|---|---|
| Edit a specific symbol in a coordinated session | [`memfleet-publish-intent`](../commands/memfleet-publish-intent.md) | [`memfleet-node-state`](../commands/memfleet-node-state.md) if you want to scout activity first |
| Run the full safe-edit loop end-to-end | [`memfleet-safe-edit`](memfleet-safe-edit.md) | done |
| Finish an edit and report it to the fleet | [`memfleet-record-episode`](../commands/memfleet-record-episode.md) | done |
| Check what the fleet is doing on a module | [`memfleet-node-state`](../commands/memfleet-node-state.md) or [`memfleet-fleet-status`](../commands/memfleet-fleet-status.md) | |
| Poll for new fleet activity | [`memfleet-query-episodes`](../commands/memfleet-query-episodes.md) | or [`memfleet-subscribe`](../commands/memfleet-subscribe.md) for long sessions |
| Got back an active conflict / Class B/C payload | [`memfleet-conflict-resolution`](memfleet-conflict-resolution.md) | |
| Orchestrate a multi-step fleet edit (leader/follower) | [`memfleet-fleet-coordination`](memfleet-fleet-coordination.md) | |

## Parameter Types — Read This Before Calling Any Tool

All MemFleet MCP tools are strictly typed (rmcp + schemars). Pass JSON numbers as numbers, enums as JSON objects with the variant name, timestamps as RFC3339 strings.

| Parameter | Correct | WRONG |
|---|---|---|
| `intent_kind` | `{"Refactor": {"pattern": "RenameSymbol"}}` | `"Refactor(RenameSymbol)"` |
| `ttl_ms`, `last_n`, `window_ms`, `limit` | `ttl_ms: 300000` | `ttl_ms: "300000"` |
| `repo_id`, `symbol`, `agent_id` | `"my-repo"` | `my-repo` (unquoted) |
| `reference_time` | `"2026-04-18T09:30:00Z"` | `"yesterday"` / Unix epoch |

If you see `failed to deserialize parameters: ...`, it is almost always a string passed where the schema wants a number, an unquoted string, or a flattened enum.

## Empty fleet_status is not a license to skip

If `fleet_status` returns zero active intents, it means **you are the first agent in this 30-minute window** — not that no protocol is needed. Run `publish_intent` anyway:

1. Your intent becomes the dominant intent on the touched nodes.
2. Any agent that joins later sees your work in their first `get_node_state` call.
3. `record_episode` updates the NodeState rollup for everyone, with O(1) reads downstream.

Skipping the protocol on a "quiet" fleet is exactly how silent collisions show up two hours later when a second agent joins and re-edits the same symbol.

## Standard Workflows

### Coordinated edit (most common)
1. `fleet_status` (once per session) → confirm the broker is up.
2. `get_node_state` on the symbol → who's been here recently?
3. `publish_intent` → register, read `propagation_set` and `active_conflicts`.
4. If conflicts → [`memfleet-conflict-resolution`](memfleet-conflict-resolution.md).
5. Edit normally.
6. `record_episode` → branch on the returned `conflict_class`.

### Pre-refactor scout
1. `fleet_status({ window_ms: 1_800_000 })` → fleet-wide snapshot.
2. `get_node_state` on each affected symbol → activity per node.
3. If any `dominant_intent` is in-flight on your targets → wait or replan.

### Long-running watcher
1. `subscribe(repo_id, { modules: [...] })` once at session start.
2. Process notifications; fall back to `query_episodes` with a cursor if push is unavailable.

## Red Flags — STOP, Use the Protocol Instead

You are violating this skill if you think:

| Thought | Reality |
|---|---|
| "It's a one-line change, skip publish_intent" | One-line changes still rename symbols. The fleet still needs to know. |
| "I'll just write a prose summary in the PR" | Prose ≠ structural signal. Other agents do not read your PR description. |
| "fleet_status is empty, no need" | Empty = you are first. Publish so the next agent sees you. |
| "I'll record_episode at the end of the day" | The NodeState rollup is what other agents read. Stale rollup = stale plans. |
| "I don't see a `subscribe` notification, so nothing changed" | Phase-1 subscriptions are stub. Poll `query_episodes` with a cursor. |
| "I got a Class B 'lost' — I'll just retry blindly" | Read `replan_hint`. The winner may have renamed the target. |
| "I got a Class C — let me edit anyway and resolve at merge" | Class C means active callers will break. Coordinate, do not edit. |
| "MemFleet is a chat channel" | It is a structural event log. ~20 tokens per intent vs 200+ for prose. |

## When the Protocol is Genuinely Optional

Skip MemFleet ONLY for:

- **Solo session, no broker registered.** `fleet_status` errors out → there is literally nothing to coordinate against.
- **Pure docs-only edits** (`*.md`, comments, log strings) where no other agent's plan depends on the line you touched. Use `intent_kind: "DocsOnly"` if you want the audit trail without the ceremony.
- **Throwaway exploration in a sandbox** that will not be committed.

For everything else, the protocol applies.

## Skill Priority

This is a **process skill** — it runs BEFORE any implementation, search, or refactoring skill. Pair it with:

- Discovery → [`memtrace-search`](../../../Memtrace/skills/commands/memtrace-search.md) (when Memtrace is also installed)
- Blast radius → [`memtrace-impact`](../../../Memtrace/skills/commands/memtrace-impact.md)
- The end-to-end loop → [`memfleet-safe-edit`](memfleet-safe-edit.md)
- Conflict handling → [`memfleet-conflict-resolution`](memfleet-conflict-resolution.md)
- Multi-agent orchestration → [`memfleet-fleet-coordination`](memfleet-fleet-coordination.md)
