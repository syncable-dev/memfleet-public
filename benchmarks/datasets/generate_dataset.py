#!/usr/bin/env python3
"""
generate_dataset.py — MemFleet benchmark task dataset generator.

Produces tasks_1000.jsonl: 1000 agent task assignments covering all
IntentKind leaf variants across a simulated 10-service codebase.

Conflict class assignment follows classifier rules (crates/broker/src/crdt/classify.rs §6):
  - Additive (feature_add, test_add, docs_only) + no same-work race → A
  - Additive + same-work race (prior additive already claimed same nodes) → B
  - Non-additive, no prior overlap in zone → B  (first registrant, no active intents)
  - Non-additive, overlaps with prior destructive (change_signature/move_symbol/dead_code) → C
  - Non-additive, overlaps with prior non-destructive → B

Usage:
    python benchmark/datasets/generate_dataset.py
Output:
    benchmark/datasets/tasks_1000.jsonl
"""

from __future__ import annotations

import itertools
import json
import random
from pathlib import Path

SEED = 42
random.seed(SEED)

OUTPUT_PATH = Path(__file__).parent / "tasks_1000.jsonl"
TARGET_COUNT = 1000
NUM_OVERLAP_ZONES = 30

# ---------------------------------------------------------------------------
# Node pool — (service, file_path, symbol)
# ---------------------------------------------------------------------------

SERVICE_NODES: list[tuple[str, str, list[str]]] = [
    ("api-gateway", "services/api-gateway/src/server.ts", [
        "createApp", "authMiddleware", "rateLimiter", "corsConfig",
        "errorHandler", "healthCheck", "notificationsRouter", "tasksRouter",
        "metricsEndpoint", "swaggerDocs", "requestLogger", "bodyParser",
        "sessionMiddleware", "staticAssets", "gracefulShutdown",
    ]),
    ("auth-service", "services/auth-service/src/authService.ts", [
        "verifyJWT", "signJWT", "refreshAccessToken", "revokeToken",
        "hashPassword", "comparePassword", "generateOTP", "validateOTP",
        "blacklistToken", "getTokenClaims", "extendSession", "invalidateSession",
    ]),
    ("auth-service", "services/auth-service/src/tokenStore.ts", [
        "storeRefreshToken", "deleteRefreshToken", "findRefreshToken",
        "purgeExpiredTokens", "countActiveTokens", "rotateRefreshToken",
    ]),
    ("auth-service", "services/auth-service/src/middleware.ts", [
        "requireAuth", "requireRole", "requirePermission", "injectUser",
        "auditRequest", "validateApiKey",
    ]),
    ("user-service", "services/user-service/src/userController.ts", [
        "getUser", "createUser", "updateUser", "deleteUser",
        "listUsers", "searchUsers", "getUserProfile", "updateUserProfile",
        "getUserRoles", "assignRole", "revokeRole",
    ]),
    ("user-service", "services/user-service/src/userRepository.ts", [
        "findById", "findByEmail", "findByUsername", "dbInsert",
        "dbUpdate", "softDelete", "countByOrg", "listWithPagination",
        "bulkInsert", "upsert",
    ]),
    ("user-service", "services/user-service/src/profileService.ts", [
        "getProfileImage", "uploadProfileImage", "deleteProfileImage",
        "updateBio", "updatePreferences", "getPreferences",
        "getActivityFeed", "markActivitySeen",
    ]),
    ("task-service", "services/task-service/src/taskController.ts", [
        "createTask", "getTask", "updateTask", "deleteTask",
        "listTasks", "assignTask", "completeTask", "reopenTask",
        "archiveTask", "bulkUpdateTasks",
    ]),
    ("task-service", "services/task-service/src/db/taskStore.ts", [
        "taskStore.find", "taskStore.insert", "taskStore.update",
        "taskStore.delete", "taskStore.count", "taskStore.paginate",
        "TaskFilter", "taskStore.findByAssignee", "taskStore.findByParent",
    ]),
    ("task-service", "services/task-service/src/handlers/pricing.ts", [
        "batchEstimate", "CRITICAL_MULTIPLIER", "PRIORITY_MULTIPLIERS",
        "estimateTask", "applyDiscount", "calculateSLA", "computeOverhead",
    ]),
    ("workflow-service", "services/workflow-service/src/WorkflowService.ts", [
        "startWorkflow", "pauseWorkflow", "resumeWorkflow", "cancelWorkflow",
        "estimateTeamWorkload", "assignStep", "completeStep", "failStep",
        "getWorkflowState", "transitionState",
    ]),
    ("workflow-service", "services/workflow-service/src/workflowEngine.ts", [
        "evaluateCondition", "executeAction", "scheduleTimeout",
        "retryStep", "compensate", "rollback", "emitEvent",
        "loadDefinition", "validateDefinition",
    ]),
    ("notification-service", "services/notification-service/src/notificationService.ts", [
        "sendNotification", "sendBulkNotification", "scheduleNotification",
        "cancelNotification", "getNotification", "markRead", "markAllRead",
        "getUnreadCount", "subscribeToChannel", "unsubscribeFromChannel",
    ]),
    ("notification-service", "services/notification-service/src/emailSender.ts", [
        "sendEmail", "sendTemplatedEmail", "queueEmail", "retryFailedEmails",
        "validateEmailAddress", "renderTemplate", "attachFiles",
    ]),
    ("search-service", "services/search-service/src/searchIndex.ts", [
        "indexDocument", "deleteDocument", "updateDocument", "reindexAll",
        "getIndexStats", "createIndex", "deleteIndex", "bulkIndex",
    ]),
    ("search-service", "services/search-service/src/queryBuilder.ts", [
        "buildQuery", "applyFilters", "applySort", "applyPagination",
        "buildAggregation", "highlightResults", "suggestCompletions",
        "parseQueryString", "validateQuery",
    ]),
    ("analytics-service", "services/analytics-service/src/metricsCollector.ts", [
        "recordEvent", "recordMetric", "flushMetrics", "startCollector",
        "stopCollector", "getMetricSummary", "resetMetrics",
        "exportToPrometheus", "exportToInflux",
    ]),
    ("analytics-service", "services/analytics-service/src/reportGenerator.ts", [
        "generateReport", "scheduleReport", "cancelReport",
        "getReportStatus", "downloadReport", "listReports",
        "applyDateRange", "groupByDimension",
    ]),
    ("storage-service", "services/storage-service/src/blobClient.ts", [
        "uploadBlob", "downloadBlob", "deleteBlob", "listBlobs",
        "copyBlob", "moveBlob", "getBlobMetadata", "setBlobMetadata",
        "generateSasUrl", "streamBlob",
    ]),
    ("storage-service", "services/storage-service/src/fileStore.ts", [
        "storeFile", "retrieveFile", "deleteFile", "listFiles",
        "getFileMetadata", "computeChecksum", "validateMimeType",
    ]),
    ("shared", "shared/utils/auth.ts", [
        "verifyJWT", "refreshAccessToken", "decodeToken", "isTokenExpired",
        "buildAuthHeader", "extractBearerToken",
    ]),
    ("shared", "shared/utils/cache.ts", [
        "CacheManager", "invalidateByPrefix", "setWithTTL", "getOrCompute",
        "warmCache", "drainCache", "getCacheStats",
    ]),
    ("shared", "shared/utils/audit.ts", [
        "writeAuditEvent", "startFlushLoop", "auditBuffer",
        "formatAuditEntry", "filterSensitiveFields",
    ]),
    ("shared", "shared/events/index.ts", [
        "DomainEvent", "CommentAddedEvent", "TaskCreatedEvent",
        "UserRegisteredEvent", "WorkflowStartedEvent", "NotificationSentEvent",
        "BlobUploadedEvent", "ReportGeneratedEvent",
    ]),
    ("shared", "shared/types/index.ts", [
        "TaskFilter", "UserFilter", "PaginationOptions", "SortOptions",
        "ApiResponse", "ErrorResponse", "HealthStatus",
        "Role", "Permission", "AuditEntry",
    ]),
]

# Flatten to (service, file_path, symbol) triples
ALL_NODES: list[tuple[str, str, str]] = [
    (svc, fp, sym)
    for svc, fp, symbols in SERVICE_NODES
    for sym in symbols
]

# ---------------------------------------------------------------------------
# Intent leaf variants — all 38
# ---------------------------------------------------------------------------
# Serialized in MemFleet's externally-tagged serde format.
# "docs_only" and "exploratory" are plain strings (unit variants).

INTENTS: list[dict | str] = [
    # Refactor × 9
    {"refactor": {"pattern": "rename_symbol"}},
    {"refactor": {"pattern": "extract_function"}},
    {"refactor": {"pattern": "inline_function"}},
    {"refactor": {"pattern": "move_symbol"}},
    {"refactor": {"pattern": "change_signature"}},
    {"refactor": {"pattern": "extract_interface"}},
    {"refactor": {"pattern": "pull_up_field"}},
    {"refactor": {"pattern": "push_down_method"}},
    {"refactor": {"pattern": "replace_conditional_with_polymorphism"}},
    # FeatureAdd × 6
    {"feature_add": {"surface": "new_symbol"}},
    {"feature_add": {"surface": "new_field"}},
    {"feature_add": {"surface": "new_variant"}},
    {"feature_add": {"surface": "new_module"}},
    {"feature_add": {"surface": "new_endpoint"}},
    {"feature_add": {"surface": "new_migration"}},
    # BugFix × 8
    {"bug_fix": {"defect": "null_handling"}},
    {"bug_fix": {"defect": "off_by_one"}},
    {"bug_fix": {"defect": "race_condition"}},
    {"bug_fix": {"defect": "logic_error"}},
    {"bug_fix": {"defect": "type_error"}},
    {"bug_fix": {"defect": "resource_leak"}},
    {"bug_fix": {"defect": "regression"}},
    {"bug_fix": {"defect": "input_validation"}},
    # Cleanup × 5
    {"cleanup": {"kind": "dead_code"}},
    {"cleanup": {"kind": "unused_import"}},
    {"cleanup": {"kind": "format_only"}},
    {"cleanup": {"kind": "comment_only"}},
    {"cleanup": {"kind": "rename_for_clarity"}},
    # Performance × 4
    {"performance": {"axis": "latency"}},
    {"performance": {"axis": "memory"}},
    {"performance": {"axis": "throughput"}},
    {"performance": {"axis": "startup_time"}},
    # SecurityFix × 4
    {"security_fix": {"severity": "critical", "cve": "CVE-2024-0001"}},
    {"security_fix": {"severity": "high",     "cve": None}},
    {"security_fix": {"severity": "medium",   "cve": None}},
    {"security_fix": {"severity": "low",      "cve": None}},
    # TestAdd, DocsOnly, Exploratory
    {"test_add": {"covers": []}},  # covers filled in per task
    "docs_only",
    "exploratory",
]

_ADDITIVE_KINDS = {"feature_add", "test_add", "docs_only"}

# Destructive = triggers Class C when a subsequent intent overlaps with this one
_DESTRUCTIVE_REFACTOR_PATTERNS = {"change_signature", "move_symbol"}
_DESTRUCTIVE_CLEANUP_KINDS = {"dead_code"}


def _intent_key(intent: dict | str) -> str:
    return list(intent.keys())[0] if isinstance(intent, dict) else intent


def is_additive(intent: dict | str) -> bool:
    return _intent_key(intent) in _ADDITIVE_KINDS


def is_destructive(intent: dict | str) -> bool:
    """Returns True iff this intent is a Class-C trigger when active."""
    if isinstance(intent, str):
        return False
    key = _intent_key(intent)
    if key == "refactor":
        return intent[key]["pattern"] in _DESTRUCTIVE_REFACTOR_PATTERNS
    if key == "cleanup":
        return intent[key]["kind"] in _DESTRUCTIVE_CLEANUP_KINDS
    return False


def resolve_intent(intent: dict | str, touched_symbols: list[str]) -> dict | str:
    """Fill test_add covers with the task's touched nodes."""
    if isinstance(intent, dict) and "test_add" in intent:
        return {"test_add": {"covers": touched_symbols[:3]}}
    return intent


def expected_class(intent: dict | str, prior_intents_in_zone: list[dict | str]) -> str:
    """
    Compute the expected ConflictClass for `intent` given `prior_intents_in_zone`
    (the intents already registered by earlier agents touching the same nodes).

    Mirrors the logic in crates/broker/src/crdt/classify.rs::classify().
    """
    if is_additive(intent):
        # Same-work race: any prior additive in the zone means this is B
        for prior in prior_intents_in_zone:
            if is_additive(prior):
                return "B"
        return "A"

    # Non-additive: if no prior intents overlap → B (safe first-mover)
    if not prior_intents_in_zone:
        return "B"

    # Any prior destructive intent → C
    for prior in prior_intents_in_zone:
        if is_destructive(prior):
            return "C"

    return "B"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def describe_task(intent: dict | str, touched: list[str], service: str) -> str:
    node_str = ", ".join(touched[:2])
    suffix = f" (+{len(touched) - 2} more)" if len(touched) > 2 else ""
    key = _intent_key(intent)
    templates = {
        "refactor":    f"Refactor {node_str}{suffix} in {service}",
        "feature_add": f"Add feature to {node_str}{suffix} in {service}",
        "bug_fix":     f"Fix bug in {node_str}{suffix} in {service}",
        "cleanup":     f"Clean up {node_str}{suffix} in {service}",
        "performance": f"Optimize {node_str}{suffix} in {service}",
        "security_fix":f"Patch security issue in {node_str}{suffix} in {service}",
        "test_add":    f"Add tests covering {node_str}{suffix} in {service}",
        "docs_only":   f"Document {node_str}{suffix} in {service}",
        "exploratory": f"Explore {node_str}{suffix} in {service}",
    }
    return templates.get(key, f"Work on {node_str}{suffix} in {service}")


def build_tags(intent: dict | str, zone: int, cls: str) -> list[str]:
    tags = [f"class:{cls}"]
    if zone > 0:
        tags.append(f"zone:{zone}")
    key = _intent_key(intent)
    tags.append(f"intent:{key}")
    if isinstance(intent, dict):
        sub = intent[key]
        if isinstance(sub, dict):
            for k, v in sub.items():
                if v is not None and k != "covers":
                    tags.append(f"{k}:{v}")
    return tags


# ---------------------------------------------------------------------------
# Main generator
# ---------------------------------------------------------------------------

def build_overlap_zones(
    all_nodes: list[tuple[str, str, str]],
    num_zones: int,
    zone_size_range: tuple[int, int] = (3, 5),
) -> list[list[tuple[str, str, str]]]:
    """Pick groups of nodes that will be shared across multiple agents."""
    pool = list(all_nodes)
    random.shuffle(pool)

    zones = []
    idx = 0
    for _ in range(num_zones):
        size = random.randint(*zone_size_range)
        chunk = pool[idx: idx + size]
        if not chunk:
            break
        idx += size
        zones.append(chunk)
    return zones


def make_record(
    task_id: int,
    agent_id: str,
    intent: dict | str,
    touched_symbols: list[str],
    file_path: str,
    service: str,
    overlap_zone: int,
    cls: str,
) -> dict:
    return {
        "id": f"T{task_id:04d}",
        "agent_id": agent_id,
        "intent": intent,
        "touched_nodes": touched_symbols,
        "files_touched": [file_path],
        "overlap_zone": overlap_zone,
        "expected_conflict_class": cls,
        "service": service,
        "description": describe_task(intent, touched_symbols, service),
        "tags": build_tags(intent, overlap_zone, cls),
    }


def generate() -> None:
    all_nodes = list(ALL_NODES)
    random.shuffle(all_nodes)

    # Build overlap zones
    zones = build_overlap_zones(all_nodes, NUM_OVERLAP_ZONES)

    # Track which symbols are consumed by zones (deduplicated)
    zone_symbols: set[str] = {sym for zone in zones for (_, _, sym) in zone}

    # Remaining nodes not in any zone
    unique_nodes = [n for n in all_nodes if n[2] not in zone_symbols]

    records: list[dict] = []
    task_id = 0
    intent_iter = itertools.cycle(INTENTS)

    # ── Zone tasks ──────────────────────────────────────────────────────────
    for zone_idx, zone_nodes in enumerate(zones):
        num_agents = random.randint(3, 5)
        touched_symbols = [sym for (_, _, sym) in zone_nodes]
        service = zone_nodes[0][0]
        file_path = zone_nodes[0][1]

        prior_intents: list[dict | str] = []

        for seq in range(num_agents):
            intent = resolve_intent(next(intent_iter), touched_symbols)
            cls = expected_class(intent, prior_intents)
            prior_intents.append(intent)
            task_id += 1
            records.append(make_record(
                task_id=task_id,
                agent_id=f"agent-z{zone_idx + 1:02d}-{seq + 1}",
                intent=intent,
                touched_symbols=touched_symbols,
                file_path=file_path,
                service=service,
                overlap_zone=zone_idx + 1,
                cls=cls,
            ))

    # ── Unique-node tasks ────────────────────────────────────────────────────
    unique_pool = list(unique_nodes)
    random.shuffle(unique_pool)
    ui = 0

    while len(records) < TARGET_COUNT and ui < len(unique_pool):
        batch_size = random.choice([1, 1, 2, 2, 3])
        batch = unique_pool[ui: ui + batch_size]
        if not batch:
            break
        ui += batch_size

        intent = resolve_intent(next(intent_iter), [sym for (_, _, sym) in batch])
        touched_symbols = [sym for (_, _, sym) in batch]
        service = batch[0][0]
        file_path = batch[0][1]
        # No prior intents → A (additive) or B (non-additive)
        cls = "A" if is_additive(intent) else "B"

        task_id += 1
        records.append(make_record(
            task_id=task_id,
            agent_id=f"agent-u{task_id:04d}",
            intent=intent,
            touched_symbols=touched_symbols,
            file_path=file_path,
            service=service,
            overlap_zone=0,
            cls=cls,
        ))

    # ── Pad to exactly TARGET_COUNT ──────────────────────────────────────────
    while len(records) < TARGET_COUNT:
        node = random.choice(all_nodes)
        intent = resolve_intent(next(intent_iter), [node[2]])
        cls = "A" if is_additive(intent) else "B"
        task_id += 1
        records.append(make_record(
            task_id=task_id,
            agent_id=f"agent-p{task_id:04d}",
            intent=intent,
            touched_symbols=[node[2]],
            file_path=node[1],
            service=node[0],
            overlap_zone=0,
            cls=cls,
        ))

    # Trim and shuffle
    records = records[:TARGET_COUNT]
    random.shuffle(records)

    # Write JSONL
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    # ── Stats ────────────────────────────────────────────────────────────────
    class_counts: dict[str, int] = {"A": 0, "B": 0, "C": 0}
    intent_kinds: dict[str, int] = {}
    unique_nodes_used: set[str] = set()

    for rec in records:
        class_counts[rec["expected_conflict_class"]] += 1
        key = _intent_key(rec["intent"])
        intent_kinds[key] = intent_kinds.get(key, 0) + 1
        for n in rec["touched_nodes"]:
            unique_nodes_used.add(n)

    print(f"Written {len(records)} tasks → {OUTPUT_PATH}")
    print(f"\nConflict class distribution:")
    for cls, count in sorted(class_counts.items()):
        pct = 100 * count / len(records)
        print(f"  Class {cls}: {count:4d}  ({pct:5.1f}%)")
    print(f"\nIntent kind distribution:")
    for kind, count in sorted(intent_kinds.items()):
        print(f"  {kind:<40} {count:4d}")
    print(f"\nUnique nodes touched: {len(unique_nodes_used)} / {len(ALL_NODES)} total")
    print(f"Overlap zones: {NUM_OVERLAP_ZONES}")


if __name__ == "__main__":
    generate()
