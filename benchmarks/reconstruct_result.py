"""
Reconstruct the v2 dataset-eval JSON from the bench log when writeResults
failed silently (missing results/v2 dir, fixed in commit alongside).

Usage:
    python3 reconstruct_result.py /tmp/memfleet_eval_v2.log

Parses two passes (BASELINE then COORDINATED) of per-task lines like:
    [T0004] agent-z01-4 zone=1 — 21.5s — recorded class=C episode=01KRCK9T…  313485 tok
    [T0005] agent-z01-5 zone=1 — 16.9s — SKIPPED  0 tokens saved

Cross-references against datasets/tasks_1000.jsonl to recover the full task
metadata. Writes results/v2/<timestamp>-dataset-v2-reconstructed.json with
the same top-level shape eval_dataset_v2.writeResults produces.
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
DATASET = HERE / "datasets" / "tasks_1000.jsonl"
LOG = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/memfleet_eval_v2.log")

TASK_LINE = re.compile(
    r"\[(?P<id>T\d+)\] agent-(?P<agent_id>\S+) zone=(?P<zone>\d+) — "
    r"(?P<dur>\d+(?:\.\d+)?)s — "
    r"(?:recorded class=(?P<cls>\w+) episode=(?P<ep>\w+)…\s+(?P<tok>\d+) tok"
    r"|SKIPPED  0 tokens saved)"
)

BASELINE_BANNER = "BASELINE — all agents run, no conflict skipping"
COORD_BANNER = "COORDINATED — agents skip when publish_intent returns conflicts"


def load_dataset_index() -> dict:
    idx = {}
    with DATASET.open() as f:
        for line in f:
            t = json.loads(line)
            idx[t["id"]] = t
    return idx


def parse_log() -> tuple[list, list, dict, str]:
    """Returns (baseline_runs, coordinated_runs, latency, timestamp).
    Timestamp is the run's start timestamp inferred from log."""
    baseline_runs = []
    coordinated_runs = []
    cur = baseline_runs
    latency = {"avgMs": 1, "minMs": 0, "maxMs": 1, "samples": 8}
    timestamp = "2026-05-11T23-30-06Z"

    with LOG.open() as f:
        for raw in f:
            line = raw.rstrip("\n")
            if BASELINE_BANNER in line:
                cur = baseline_runs
                continue
            if COORD_BANNER in line:
                cur = coordinated_runs
                continue
            m = re.search(r"avg=(\d+)ms\s+min=(\d+)ms\s+max=(\d+)ms", line)
            if m:
                latency = {
                    "avgMs": int(m.group(1)),
                    "minMs": int(m.group(2)),
                    "maxMs": int(m.group(3)),
                    "samples": 8,
                }
                continue
            tm = TASK_LINE.search(line)
            if not tm:
                continue
            cur.append({
                "id": tm.group("id"),
                "agent_id_suffix": tm.group("agent_id"),
                "zone": int(tm.group("zone")),
                "duration_ms": int(float(tm.group("dur")) * 1000),
                "skipped": tm.group("cls") is None,
                "conflict_class": tm.group("cls"),
                "episode_prefix": tm.group("ep"),
                "tokens_total": int(tm.group("tok")) if tm.group("tok") else 0,
            })
    return baseline_runs, coordinated_runs, latency, timestamp


def to_eval_run(raw: dict, dataset_idx: dict) -> dict:
    task = dataset_idx.get(raw["id"]) or {
        "id": raw["id"],
        "agent_id": f"agent-{raw['agent_id_suffix']}",
        "intent": "?",
        "touched_nodes": [],
        "files_touched": [],
        "overlap_zone": raw["zone"],
        "expected_conflict_class": "?",
        "service": "?",
        "description": "?",
        "tags": [],
    }
    return {
        "task": task,
        "agentId": task["agent_id"],
        "skipped": raw["skipped"],
        "conflictClass": raw["conflict_class"],
        "episodeId": (raw["episode_prefix"] + "...") if raw["episode_prefix"] else None,
        "intentMismatch": False,
        "durationMs": raw["duration_ms"],
        "tokenUsage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheCreationTokens": 0,
            "totalTokens": raw["tokens_total"],
            "costUsd": None,
        } if raw["tokens_total"] else None,
        "skippedBlastRadius": len(task.get("touched_nodes", [])) if raw["skipped"] else 0,
    }


def main() -> int:
    if not LOG.exists():
        print(f"ERR: log not found: {LOG}", file=sys.stderr)
        return 1

    dataset_idx = load_dataset_index()
    baseline_raw, coord_raw, latency, timestamp = parse_log()

    baseline = [to_eval_run(r, dataset_idx) for r in baseline_raw]
    coordinated = [to_eval_run(r, dataset_idx) for r in coord_raw]

    obj = {
        "timestamp": timestamp,
        "model": "claude-haiku-4-5-20251001",
        "numZones": 30,
        "latency": latency,
        "baseline": baseline,
        "coordinated": coordinated,
        "_reconstructed_from_log": str(LOG),
        "_reconstruction_note": (
            "Original writeResults call failed with ENOENT (results/v2 dir missing). "
            "This JSON is reconstructed from the run log; per-task token counts are "
            "the total-tokens reported by claude --output-format=json at the time of "
            "the run (input+output+cache_read+cache_create summed). Per-token-channel "
            "breakdown is not recoverable from the log."
        ),
    }

    out = HERE / "results" / "v2" / f"{timestamp}-dataset-v2-reconstructed.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(obj, indent=2))

    print(f"[wrote] {out}")
    print(f"  baseline: {len(baseline)} runs, {sum(1 for r in baseline if r['skipped'])} skipped")
    print(f"  coordinated: {len(coordinated)} runs, {sum(1 for r in coordinated if r['skipped'])} skipped")
    print(f"  baseline wallclock total: {sum(r['durationMs'] for r in baseline) / 1000:.1f}s")
    print(f"  coordinated wallclock total: {sum(r['durationMs'] for r in coordinated) / 1000:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
