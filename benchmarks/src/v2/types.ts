import type { LatencyStats } from "../types.js";

export type IntentKind =
  | { feature_add: { surface: string } }
  | { bug_fix: { defect: string } }
  | { refactor: { pattern: string } }
  | { cleanup: { kind: string } }
  | { performance: { axis: string } }
  | { test_add: { covers: string[] } }
  | "docs_only"
  | "exploratory";

export interface V2AgentAssignment {
  id: string;
  agentId: string;
  overlapZone: number;
  expectedConflictClass: "A" | "B" | "C";
  expectedIntent: IntentKind;
  touchedNodes: string[];
  filesTouched: string[];
  taskPrompt: string;
}

export interface IntentClassification {
  agentId: string;
  expectedIntent: IntentKind;
  /** Intent the agent published via publish_intent. Null if agent skipped it. */
  actualIntent: IntentKind | null;
  topLevelMatch: boolean;
}

export interface V2AgentResult {
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  diff: string;
}

export interface V2AgentRun {
  assignment: V2AgentAssignment;
  episodeId: string | null;
  conflictClass: string | null;
  autoMerged: boolean;
  mergeRule: string | null;
  intentMismatch: boolean;
  classification: IntentClassification;
  durationMs: number;
  slaViolations: string[];
}

export interface V2PhaseResult {
  agentCount: number;
  runs: V2AgentRun[];
  conflictCounts: { A: number; B: number; C: number };
  autoMergedCount: number;
  classificationAccuracy: number;
  latency: {
    acquire_lease: LatencyStats;
    record_episode: LatencyStats;
    release_lease: LatencyStats;
  };
  slaViolations: number;
}

export interface V2BenchmarkResult {
  runId: string;
  startedAt: string;
  phases: V2PhaseResult[];
  overall: {
    classificationAccuracy: number;
    autoMergeRate: number;
    conflictCounts: { A: number; B: number; C: number };
  };
}
