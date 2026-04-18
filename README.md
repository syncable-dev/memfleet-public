<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo-dark.svg" alt="MemFleet" width="100" height="100" />
  </picture>
</p>

<h1 align="center">MemFleet</h1>

<p align="center">
  <strong>Structural intent coordination for agent fleets.</strong><br/>
  Typed intent, precomputed blast radius, O(1) coordination reads — no prose, no timing windows.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/memfleet"><img src="https://img.shields.io/npm/v/memfleet?style=flat-square&color=00D4B8&label=npm" alt="npm version" /></a>
  <a href="https://github.com/syncable-dev/memfleet-public/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Proprietary%20EULA-0A1628?style=flat-square" alt="license" /></a>
  <a href="https://memfleet.io"><img src="https://img.shields.io/badge/docs-memfleet.io-00D4B8?style=flat-square" alt="docs" /></a>
</p>

> **Early Access** — Phase 1 (intent registry, episode store, NodeState rollup, Class A/B/C, Y-doc, stdio MCP) is stable. Phase 2 (leases, shadow overlays, intent-aware auto-merge) and Phase 3 (in-process Memtrace, Ed25519 signing, CEL policy) are in flight. [Report issues here.](https://github.com/syncable-dev/memfleet-public/issues)

---

## The problem

Ten coding agents editing the same repo. The naive options:

- **Prose rationale** — each agent writes a paragraph. Others read it. 200+ tokens per edit, does not scale, vendor-specific, resists structural querying.
- **Timing-based notification** — broadcast in a 500 ms window, others subscribe. Works for two agents, floods at ten, breaks on network jitter.

Both produce the same outcome: silent collisions, overwrites, wasted tokens re-reading work that could have been predicted.

## The solution

MemFleet treats **intent as a structural type**, not a paragraph. Every edit emits a typed `IntentKind` enum with a precomputed impact set, attached to the graph nodes it touches. Any agent reading those nodes receives the coordination picture — O(1), no prose, no timing window.

```bash
npm install -g memfleet     # binary + 10 skills + MCP server — one command
memfleet                    # MCP server auto-launched by Claude / Cursor on connect
```

Claude Code, Claude Desktop, and Cursor (v2.4+) pick up the skills and MCP tools automatically.

## Typed intent — the core contribution

9 variants, 41 leaf values:

```rust
pub enum IntentKind {
    Refactor    { pattern: RefactorPattern },
    FeatureAdd  { surface: FeatureSurface },
    BugFix      { defect: DefectClass },
    Cleanup     { kind: CleanupKind },
    Performance { axis: PerfAxis },
    SecurityFix { severity: Severity, cve: Option<String> },
    TestAdd     { covers: Vec<NodeIdentity> },
    DocsOnly,
    Exploratory,
}
```

One intent ≈ 20 tokens. One prose rationale ≈ 200+. Across a 10-agent fleet running 100 edits — **~90,000 tokens saved per fleet-turn**.

## Conflict classes

| Class | Meaning | Broker action |
|-------|---------|---------------|
| **A** | Additive only — new symbols, no removals | Auto-accepted. Zero coordination cost. |
| **B** | Modification to an existing symbol — body / type / rename | LWW by `reference_time`. Loser receives a typed `ReplanHint`. |
| **C** | Removes a live symbol or changes a signature with active callers | Blocked at intent time. Structured conflict report. |

`Refactor(RenameSymbol)` + `BugFix(NullHandling)` on the same symbol are orthogonal — the broker auto-merges (Phase 2).

## 8 MCP Tools

| Tool | Purpose |
|:--|:--|
| `publish_intent` | Register structural intent before an edit; returns blast radius and active conflicts |
| `record_episode` | Record a structural episode after an edit; classifies A/B/C, precomputes impact, updates rollups |
| `get_node_state` | O(1) read of recent episodes, active intents, dominant intent, conflict density for a symbol |
| `get_episode` | Fetch a single episode by id |
| `query_episodes` | Filtered episode search by node / intent / time range |
| `ydoc_read` | Read the Y-doc thread + NodeState blob for a symbol |
| `subscribe` | Register a streaming subscription with filters and budget |
| `fleet_status` | Active intents, open subscriptions, episode count, conflict counts by class |

## 10 Agent Skills

| | Skill | You say... |
|:--|:------|:-----------|
| **Intent** | `memfleet-publish-intent` | _"I'm about to refactor X"_ |
| **Episode** | `memfleet-record-episode` | _"I just edited X"_ |
| **Node state** | `memfleet-node-state` | _"is anyone working on X"_ |
| **Query** | `memfleet-query-episodes` | _"what changed today"_ |
| **Subscribe** | `memfleet-subscribe` | _"watch the auth module"_ |
| **Status** | `memfleet-fleet-status` | _"how busy is the fleet"_ |

Plus **4 workflow skills** that chain multiple tools:

| Skill | You say... |
|:------|:-----------|
| `memfleet-first` | Meta-router — the first skill to reach for in any multi-agent edit |
| `memfleet-safe-edit` | _"implement/rename/modify X safely"_ — full publish → edit → record loop |
| `memfleet-conflict-resolution` | _"I hit a B/C conflict — what now"_ |
| `memfleet-fleet-coordination` | _"coordinate agents on this multi-symbol refactor"_ |

## Architecture

```
Agent (Claude Code / Cursor / CI bot)
        │  MCP (stdio or SSE)
        ▼
memfleet-mcp          ← single MCP endpoint agents see
        │
        ▼
broker crate          ← intent registry, episode store, CRDT classifier,
        │               rollup cache, subscription router, Y-doc, provenance log
        ▼
MemtraceBackend trait ← Phase 1: over-MCP client to a running memtrace-mcp
                        Phase 3: in-process trait swap, zero other code changes
```

MemFleet is **composition**, not replacement: it uses Memtrace for structural blast radius today and will embed it in-process in Phase 3.

## Compatibility

| Editor / Agent | MCP Tools | Skills | Install |
|:---------------|:---------:|:------:|:--------|
| **Claude Code** | ✅ | ✅ | `npm install -g memfleet` — fully automatic |
| **Claude Desktop** | ✅ | ✅ | Automatic — shared with Claude Code |
| **Cursor** (v2.4+) | ✅ | ✅ | `npm install -g memfleet` — fully automatic |
| **Windsurf** | ✅ | Coming soon | Add MCP server manually |
| **VS Code (Copilot)** | ✅ | — | Add MCP server manually |
| **Any MCP client** | ✅ | — | Add MCP server manually |

## Setup

### Claude Code + Claude Desktop

`npm install -g memfleet` handles everything automatically — binary, 10 skills, MCP server, plugin, and marketplace all register in one command.

For manual setup:

```bash
claude plugin marketplace add syncable-dev/memfleet-public
claude plugin install memfleet-skills@memfleet --scope user
claude mcp add memfleet -- memfleet mcp
```

### Cursor

Cursor v2.4+ supports Agent Skills natively. `npm install -g memfleet` writes:

- **MCP server** → `~/.cursor/mcp.json`
- **10 skills** → `~/.cursor/skills/memfleet-*/SKILL.md`

Project-local install (skills travel with the repo):

```bash
memfleet install --only cursor --local
```

### Other Editors (Windsurf, VS Code, Cline)

After `npm install -g memfleet`, add the MCP server to your editor config:

```json
{
  "mcpServers": {
    "memfleet": {
      "command": "memfleet",
      "args": ["mcp"],
      "env": { "RUST_LOG": "info" }
    }
  }
}
```

### Uninstall

```bash
memfleet uninstall
npm uninstall -g memfleet
```

## Requirements

| Dependency | Purpose |
|:-----------|:--------|
| **Node.js ≥ 18** | npm installation |
| **Rust (toolchain)** | Only if building from source — binaries are prebuilt |
| **Memtrace** (optional) | Full structural impact — Phase-1 broker runs without it via stub |

<br/>

<p align="center">
  <a href="https://memfleet.io">Documentation</a> · <a href="https://www.npmjs.com/package/memfleet">npm</a> · <a href="https://github.com/syncable-dev/memfleet-public/issues">Issues</a>
</p>

<p align="center">
  <sub>Built by <a href="https://syncable.dev">Syncable</a> · <a href="LICENSE">Proprietary EULA</a> · Free to use</sub>
</p>
