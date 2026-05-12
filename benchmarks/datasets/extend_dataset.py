"""
Extend the curated tasks_1000.jsonl to N agents per overlap zone.

For each zone that has fewer than N tasks, synthesize additional tasks by
cloning the zone's first task (same files_touched, touched_nodes, overlap_zone,
service) but rotating intent kinds and agent IDs. Synthetic tasks are tagged
`synthetic:true` so downstream readers can filter for honest reporting.

Usage:
    python3 extend_dataset.py --in tasks_1000.jsonl --out tasks_1000_k10.jsonl --per-zone 10

Output is deterministic given the same input + same --per-zone value (seeded
RNG, sorted iteration order).
"""
import argparse
import json
import random
import sys
from collections import defaultdict
from pathlib import Path

INTENT_VARIANTS = [
    {"feature_add": {"surface": "new_symbol"}},
    {"bug_fix": {"defect": "null_handling"}},
    {"refactor": {"pattern": "extract_method"}},
    {"refactor": {"pattern": "rename_field"}},
    {"cleanup": {"kind": "remove_dead_code"}},
    {"cleanup": {"kind": "rename_for_clarity"}},
    {"performance": {"axis": "reduce_allocations"}},
    {"performance": {"axis": "cache_hot_path"}},
    {"test_add": {"covers": ["happy_path"]}},
    {"feature_add": {"surface": "extend_existing"}},
    "exploratory",
]

# Mapping intent → expected conflict class (matches the curated dataset's logic):
#   feature_add → A (additive, no collision unless same symbol)
#   bug_fix     → B (modification, LWW resolved)
#   refactor    → C (destructive, blocked at intent)
#   cleanup     → B
#   performance → B
#   test_add    → A
#   exploratory → A
EXPECTED_CLASS = {
    "feature_add": "A",
    "bug_fix": "B",
    "refactor": "C",
    "cleanup": "B",
    "performance": "B",
    "test_add": "A",
    "exploratory": "A",
}


def intent_kind(intent) -> str:
    if isinstance(intent, str):
        return intent
    return next(iter(intent.keys()))


def synthesize_task(template: dict, idx: int, zone: int, intent) -> dict:
    """Clone a template task into a new synthetic task with a different intent."""
    kind = intent_kind(intent)
    expected = EXPECTED_CLASS.get(kind, "B")
    tags = [f"class:{expected}", f"zone:{zone}", f"intent:{kind}", "synthetic:true"]
    if isinstance(intent, dict):
        sub = next(iter(next(iter(intent.values())).items()))
        tags.append(f"{sub[0]}:{sub[1]}")

    return {
        "id": f"S{zone:02d}{idx:03d}",  # SXXyyy = Synthetic, zone XX, slot yyy
        "agent_id": f"agent-z{zone:02d}-{idx}",
        "intent": intent,
        "touched_nodes": list(template["touched_nodes"]),
        "files_touched": list(template["files_touched"]),
        "overlap_zone": zone,
        "expected_conflict_class": expected,
        "service": template["service"],
        "description": f"Synthetic {kind} on {', '.join(template['touched_nodes'][:2])} (zone {zone}, agent {idx})",
        "tags": tags,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in", dest="inp", default="tasks_1000.jsonl")
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--per-zone", type=int, required=True)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    here = Path(__file__).parent
    inp_path = here / args.inp if not Path(args.inp).is_absolute() else Path(args.inp)
    out_path = here / args.out if not Path(args.out).is_absolute() else Path(args.out)

    # Load original
    by_zone = defaultdict(list)
    other = []
    with inp_path.open() as f:
        for line in f:
            t = json.loads(line)
            if t["overlap_zone"] > 0:
                by_zone[t["overlap_zone"]].append(t)
            else:
                other.append(t)

    # Sort tasks within each zone by id for determinism
    for z in by_zone:
        by_zone[z].sort(key=lambda t: t["id"])

    rng = random.Random(args.seed)
    out_tasks = list(other)  # keep zone-0 tasks as-is
    n_synthesized = 0
    for zone in sorted(by_zone):
        existing = by_zone[zone]
        out_tasks.extend(existing)
        deficit = args.per_zone - len(existing)
        if deficit <= 0:
            continue
        # Synthesize `deficit` more tasks, cycling through INTENT_VARIANTS
        # deterministically per zone (seed-driven shuffle so identical inputs
        # produce identical extensions).
        template = existing[0]
        intents = list(INTENT_VARIANTS)
        rng.shuffle(intents)
        start_idx = len(existing) + 1
        for i in range(deficit):
            intent = intents[i % len(intents)]
            new_task = synthesize_task(template, start_idx + i, zone, intent)
            out_tasks.append(new_task)
            n_synthesized += 1

    with out_path.open("w") as f:
        for t in out_tasks:
            f.write(json.dumps(t) + "\n")

    print(f"[wrote] {out_path}")
    print(f"  total tasks: {len(out_tasks)}")
    print(f"  synthetic added: {n_synthesized}")
    print(f"  per-zone target: {args.per_zone}")
    # Verify per-zone counts
    final_counts = defaultdict(int)
    for t in out_tasks:
        if t["overlap_zone"] > 0:
            final_counts[t["overlap_zone"]] += 1
    achieved = {z: c for z, c in final_counts.items() if c < args.per_zone}
    if achieved:
        print(f"  WARN — zones under target: {achieved}")
    else:
        print(f"  all 30 overlap zones now have exactly {args.per_zone} agents")
    return 0


if __name__ == "__main__":
    sys.exit(main())
