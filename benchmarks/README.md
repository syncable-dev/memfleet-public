# MemFleet Coordination Benchmark — Public Harness

End-to-end measurement of what MemFleet's structural-intent coordination does for a parallel agent fleet, on a controlled overlap-zone dataset. Same agents, same model, same codebase, same tasks — the only variable is whether MemFleet coordination is on or off.

**This is the public mirror.** All result JSONs, the 1000-task dataset, the K=10 extension, the harness source, and the methodology disclosures live here so anyone can rerun the numbers from a fresh checkout. The first three runs (K=2, K=5, K=10) and their JSON outputs are committed below; you can verify them or re-execute against your own MemFleet broker.

**Public path**: `https://github.com/syncable-dev/memfleet-public/tree/main/benchmarks`

## Headline (three measured densities)

The bench has been run at K=2, K=5, and K=10 agents per overlap zone. Each is a real A/B: 30 overlap zones, every zone has multiple agents touching the same symbols, each pass is a separate run of all agents end-to-end.

| Metric | K=2 | K=5 | **K=10** |
|---|---:|---:|---:|
| Tasks per pass | 60 | 115 | **300** |
| Dataset | curated | curated | extended (synthetic agents tagged) |
| **Redundant agents eliminated** | 51.7% | 73.9% | **90.3%** |
| **Wall-clock time saved** | 20.2% | 45.2% | **38.0%** |
| **Class C (destructive) conflicts** | 7 → 3 (**−57%**) | 20 → 3 (**−85%**) | **77 → 3 (−96.1%)** |
| **Nodes protected from overwrite** | 118 | 327 | **1040** |
| Coordination overhead | 0.00% of run | 0.01% of run | **0.01% of run** |
| publish_intent p95 latency | 1ms | 1ms | **1ms** |
| Total cost (Haiku, baseline+coord) | $0.83 | $14.14 | $36.82 |

Result JSONs (re-runnable, verifiable):
- K=2: `results/v2/2026-05-11T23-30-06Z-dataset-v2-reconstructed.json`
- K=5: `results/v2/2026-05-12T00-57-44Z-k5-dataset-v2.json`
- K=10: `results/v2/2026-05-12T03-39-12Z-k10-dataset-v2.json`

## (N−1)/N curve — predicted vs measured

Conflict prevention follows the **(N−1)/N coordination curve** as predicted: agents in the same overlap zone race to publish intent; the first wins, the rest skip. Three measured points plus projection:

| K (agents/zone) | Predicted skip rate | Measured skip rate | Class C reduction (measured) |
|---:|---:|---:|---:|
| 2 | 50% | 51.7% | −57% |
| 5 | 80% | 73.9% (dataset avg 3.83/zone) | −85% |
| **10** | **90%** | **90.3%** | **−96.1%** |
| 17 | 94% | (projection) | ~−97% |
| 20 | 95% | (projection) | ~−98% |
| 50 | 98% | (projection — unrealistic in practice) | (projection) |

## What the bench actually does

For each run:

1. **Dataset selection.** Pulls tasks from `datasets/tasks_1000.jsonl` (curated, real intents) or `datasets/tasks_1000_k10.jsonl` (extended with synthetic agents for K>5; synthetic tasks carry `synthetic:true` tag for honest filtering). `--zones N` controls how many overlap zones; `--per-zone K` controls how many agents per zone. Picks the first K tasks of each of N zones.
2. **Baseline pass.** Spawns each task as a real `claude -p` Haiku subprocess with MemFleet MCP attached. Each agent calls `publish_intent`, then proceeds *regardless* of returned conflicts, then calls `record_episode`. Sequential execution.
3. **Coordinated pass.** Same task set, same agents, same model — agents call `publish_intent` and if `active_conflicts` is non-empty, output `SKIPPED` and exit without doing the work or recording an episode.
4. **Compares.** Wall-clock, agents that ran, token usage, conflict-class distribution (A/B/C), nodes protected from destructive overwrite.

The only variable between passes is the conditional skip on intent conflicts.

## Reproducing

```bash
# 1. Start MemFleet MCP server on :3040
memfleet start &
memfleet status   # confirm running

# 2. Set Anthropic key (the agents are real claude subprocesses on Haiku)
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Install deps
npm install

# 4. Run any density
npm run eval:v2 -- --zones 30 --per-zone 2                                         # K=2 on real dataset
npm run eval:v2 -- --zones 30 --per-zone 5                                         # K=5 on real dataset (caps at 3-5 per zone)
npm run eval:v2 -- --zones 30 --per-zone 10 --dataset datasets/tasks_1000_k10.jsonl  # K=10 on extended dataset
```

Each run produces `results/v2/<timestamp>-k<K>-dataset-v2.json` + a console comparison table.

Cost (Haiku): $0.83 (K=2) / $14 (K=5) / $37 (K=10). Wallclock: ~45 min (K=2) / ~100 min (K=5) / ~5 hrs (K=10).

## Generating the extended dataset

The curated `tasks_1000.jsonl` caps at 3–5 agents per zone (avg 3.83). For K=10 and above, generate an extension:

```bash
python3 datasets/extend_dataset.py --in tasks_1000.jsonl --out tasks_1000_k10.jsonl --per-zone 10
```

Deterministic given the seed (default 42). Synthetic tasks are tagged `synthetic:true` so any downstream filtering can separate real from extended.

## Methodology disclosures (read before quoting numbers)

These are the things a brutal reviewer would ask, answered up front:

- **Sequential execution.** The harness runs agents sequentially within each pass, not in true parallel. The coordination signal comes from intent overlap within the broker's 120-second TTL window. A real parallel fleet would surface *more* conflicts that MemFleet would catch — so this is a **conservative floor**, not a ceiling.
- **Designed overlap zones.** The dataset is constructed to exercise the coordination protocol — every zone has multiple agents touching the same symbols. This is a synthetic stress test of the coordination layer, not a survey of typical fleet workloads. Real fleets with low overlap see proportionally smaller benefits.
- **K=10 uses synthetic agents.** Zones in the curated dataset cap at 3–5 agents. To measure at K=10, the extender script clones each zone's first task into additional agents with rotated intent kinds (cycling through `feature_add`, `bug_fix`, `refactor`, `cleanup`, `performance`, `test_add`, `exploratory`) so they collide on the same nodes. Marked `synthetic:true` in the dataset; honest framing for downstream.
- **Class A vs B vs C.**
  - **Class A** = clean (no overlap detected).
  - **Class B** = auto-merged via Last-Writer-Wins. **NOT a "merge conflict"** in the practical sense — MemFleet resolves it automatically without human intervention.
  - **Class C** = destructive/contradictory. **The real merge conflict** — needs human intervention. The headline conflict-reduction number always references Class C.
- **Classification accuracy** in the bench (the % column near the conflict counts) is "did MemFleet's classifier match the dataset's expected class for the agent that ran?" — it's a property of the classifier under contention, not of coordination effectiveness. Useful as a separate signal but doesn't move the headline numbers.
- **Wall-clock @ K=10 (38%) is slightly under K=5 (45%).** Reason: when most agents skip, the wall-clock per skip becomes dominated by Claude Code's startup+cache-creation overhead (~10–15s per spawn) rather than actual task work. At K=10 we spawn 271 skip-only subprocesses, each consuming ~10s of overhead even though it does no real work. A truly parallel fleet would amortize this; the sequential harness can't.
- **Cost reported** uses Anthropic list price for `claude-haiku-4-5-20251001` (~$0.80/MTok input, ~$4/MTok output, cache reads at ~10% of input).
- **Single run per K.** No variance estimate per density yet. Running the same K twice would surface run-to-run stability. Recommended before external publication beyond pilot/blog.

## What this benchmark does NOT measure

- **Parallel agent contention.** Would show more conflicts at any given K, more coordination wins. Roadmap.
- **Real merge-conflict prevention at git level.** Episodes are recorded synthetically (agents don't actually edit files in this v2 path — they describe the change in 2 sentences). Conflict classes come from MemFleet's classifier on structural intent, not from post-edit merge analysis.
- **Long-horizon agent sessions.** All agents complete within ~30s. Fleets with multi-hour agents would show different dynamics.

## Files

| File | Purpose |
|---|---|
| `src/eval_dataset_v2.ts` | The harness. Spawns Haiku agents, runs both passes, prints comparison, writes JSON. Supports `--per-zone K` (default 2) and `--dataset PATH` flags |
| `src/v2/mcp.ts` | HTTP MCP client used to query MemFleet's episode store |
| `datasets/tasks_1000.jsonl` | Curated 1000-task dataset across 30 overlap zones, 38 intent kinds, 10 simulated services. 3–5 agents per zone |
| `datasets/tasks_1000_k10.jsonl` | Extended dataset with synthetic agents bringing every zone up to 10 agents. Synthetic tasks tagged `synthetic:true` |
| `datasets/extend_dataset.py` | Deterministic extender; clones zone first-task with rotated intents to target any K |
| `results/v2/*.json` | Per-run output JSONs, timestamped + density-tagged |
| `reconstruct_result.py` | Recovers a result JSON from a bench log if `writeResults` failed (mkdir bug, now fixed) |

## Per-zone breakdown (K=10, sample — every zone identical 9-of-10 skip pattern)

```
Zone 1: 10 agents, 9 skipped, class=[B], 2,513,619 tok, 27 nodes protected
Zone 7: 10 agents, 9 skipped, class=[B], 2,526,759 tok, 45 nodes protected
Zone 13: 10 agents, 9 skipped, class=[C], 2,626,579 tok, 36 nodes protected
Zone 18: 10 agents, 9 skipped, class=[C], 2,619,419 tok, 27 nodes protected
Zone 22: 10 agents, 9 skipped, class=[C], (full data in JSON)
... (30 zones total, every zone produces identical 9/10 skip outcome)
```

Full per-zone data in the K=10 result JSON.
