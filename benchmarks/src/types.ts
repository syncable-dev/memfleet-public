// ── Timing ─────────────────────────────────────────────────────────────────
export interface TimedResult<T> {
  result: T;
  elapsedMs: number;
}

export type ToolName = "publish_intent" | "record_episode" | "get_node_state" | "fleet_status";

export interface RawTiming {
  tool: ToolName;
  elapsedMs: number;
}

// ── MemFleet MCP response shapes ────────────────────────────────────────────
export interface PublishIntentResponse {
  intent_id: string;
  expires_at: string;
  impact_preview: string[];
  active_conflicts: unknown[];
  warnings: unknown[];
}

export interface RecordEpisodeResponse {
  episode_id: string;
  conflict_class: "A" | "B" | "C";
  propagated: string[];
  supersedes: string[];
  replan_hint: string;
}

export interface FleetStatusResponse {
  active_intents: number;
  active_subscriptions: number;
  recent_episodes: number;
  conflict_counts: { A: number; B: number; C: number };
  recent_log: string[];
}

export interface NodeStateResponse {
  node: string;
  recent_episodes: unknown[];
  active_intents: unknown[];
  dominant_intent: unknown | null;
  conflict_density: number;
}

// ── Assignments ─────────────────────────────────────────────────────────────
export type ConflictClass = "A" | "B" | "C";

export interface AgentAssignment {
  id: string;
  agentId: string;
  taskPrompt: string;
  touchedNodes: string[];
  intent: Record<string, unknown>;
  filesTouched: string[];
  overlapZone: number;
  expectedConflictClass: ConflictClass;
}

// ── Token usage ──────────────────────────────────────────────────────────────
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
}

// ── Agent run results ────────────────────────────────────────────────────────
export interface AgentRun {
  assignment: AgentAssignment;
  exitCode: number;
  stdout: string;
  diff: string;
  agentElapsedMs: number;
  intentId: string;
  publishElapsedMs: number;
  episodeId: string | null;
  conflictClass: ConflictClass | null;
  recordElapsedMs: number | null;
  tokenUsage: TokenUsage | null;
  slaViolations: string[];
}

// ── Phase results ────────────────────────────────────────────────────────────
export interface PhaseResult {
  agentCount: number;
  agentsSkipped: number;
  runs: AgentRun[];
  nodeStateTimings: RawTiming[];
  conflictCounts: { A: number; B: number; C: number };
  /** Latency stats per tool. fleet_status is omitted — called once at startup, not per-phase. */
  latency: {
    publish_intent: LatencyStats;
    record_episode: LatencyStats;
    get_node_state: LatencyStats;
  };
  tokenTotals: TokenUsage;
  slaViolations: string[];
}

export interface LatencyStats {
  calls: number;
  p50: number;
  p95: number;
  max: number;
}

// ── Overall benchmark result ─────────────────────────────────────────────────
export interface BenchmarkResult {
  runId: string;
  phases: PhaseResult[];
  overall: {
    totalEpisodes: number;
    agentsSkipped: number;
    conflictCounts: { A: number; B: number; C: number };
    tokenTotals: TokenUsage;
    slaViolations: string[];
  };
}
