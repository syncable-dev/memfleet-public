---
name: memfleet-first
description: "Use at the START of any edit in a multi-agent session before writing code, opening files, or reasoning about changes. Triggered by: 'I'm about to edit X', planning a refactor, joining a running fleet session, coordinating with other agents. DO NOT USE for solo-agent sessions with no fleet, for docs-only edits (→ DocsOnly intent still, but skip the ceremony), or when the repo has no MemFleet MCP server registered."
---

# MemFleet First

## The Iron Law

```
IN A MULTI-AGENT SESSION → MEMFLEET TOOLS BEFORE EDITS. NO EXCEPTIONS.
  1. publish_intent
  2. edit
  3. record_episode
```

MemFleet is the coordination memory of the fleet. Every edit is a typed structural event. Skipping the protocol means silent collisions, overwrites, and wasted tokens re-reading work another agent already did.

## The 80-token rule

A typed intent serializes to ~20 tokens. A prose rationale averages 200+. A 10-agent fleet × 100 edits = 90,000 tokens saved per fleet-turn when the fleet uses MemFleet correctly.

## Routing

| You are about to… | Call first | Then |
|---|---|---|
| Edit a specific symbol | `memfleet-publish-intent` | `memfleet-node-state` if you want to check activity first |
| Commit / end an edit | `memfleet-record-episode` | done |
| Check what the fleet is doing on a module | `memfleet-node-state` or `memfleet-fleet-status` | |
| Poll for new activity | `memfleet-query-episodes` | or `memfleet-subscribe` if session is long |
| Discovered a conflict payload | `memfleet-conflict-resolution` | |
| Orchestrating a multi-step fleet edit | `memfleet-fleet-coordination` | |

## Parameter types

All MemFleet MCP tools are strictly typed (rmcp + schemars). Pass JSON numbers as numbers, enums as JSON objects with the variant name, timestamps as RFC3339 strings.

```json
// CORRECT
{"intent_kind": {"Refactor": {"pattern": "RenameSymbol"}}, "ttl_ms": 300000}

// WRONG
{"intent_kind": "Refactor(RenameSymbol)", "ttl_ms": "300000"}
```
