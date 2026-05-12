/**
 * eval_dataset_v2.ts — Dynamic agent evaluation from tasks_1000.jsonl.
 *
 * Each agent is a real claude subprocess with --mcp-config pointing to the
 * memfleet HTTP server. Agents call publish_intent and record_episode
 * themselves — the harness only spawns, waits, and queries the episode store.
 *
 * Baseline pass:  agents always proceed (no skipping).
 * Coordinated pass: agents skip if publish_intent returns active conflicts.
 *
 * Usage:  npx tsx src/eval_dataset_v2.ts [--zones N] [--model <model>]
 */

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { MemFleetHttpClient } from "./v2/mcp.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATASET_PATH = join(__dirname, "../datasets/tasks_1000.jsonl");
const HTTP_PORT = 3040; // use already-running memfleet instance
const HTTP_BASE_URL = `http://localhost:${HTTP_PORT}`;
const CLAUDE_BIN = "claude";
const AGENT_MODEL = "claude-haiku-4-5-20251001";
const AGENT_TIMEOUT_MS = 120_000;

// Parse CLI args
const args = process.argv.slice(2);
const numZonesArg = args.indexOf("--zones");
const NUM_ZONES = numZonesArg >= 0 ? parseInt(args[numZonesArg + 1], 10) : 5;

const modelArg = args.indexOf("--model");
const MODEL = modelArg >= 0 ? args[modelArg + 1] : AGENT_MODEL;

// --per-zone K: how many agents to draw from each overlap zone (default 2,
// the original behaviour). Caps at the zone's available task count.
const perZoneArg = args.indexOf("--per-zone");
const PER_ZONE = perZoneArg >= 0 ? parseInt(args[perZoneArg + 1], 10) : 2;

// --dataset PATH: optional override to point at an extended-density dataset
// (e.g. datasets/tasks_1000_k10.jsonl). Defaults to the curated 1000-task set.
const datasetArg = args.indexOf("--dataset");
const DATASET_OVERRIDE = datasetArg >= 0 ? args[datasetArg + 1] : null;

// Unique run ID so intent/episode state doesn't bleed between benchmark runs.
const RUN_ID = Date.now().toString(36);

// ---------------------------------------------------------------------------
// Dataset types (mirrors tasks_1000.jsonl)
// ---------------------------------------------------------------------------

interface DatasetTask {
  id: string;
  agent_id: string;
  intent: Record<string, unknown> | string;
  touched_nodes: string[];
  files_touched: string[];
  overlap_zone: number;
  expected_conflict_class: "A" | "B" | "C";
  service: string;
  description: string;
  tags: string[];
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number | null;
}

interface PublishIntentLatency {
  avgMs: number;
  minMs: number;
  maxMs: number;
  samples: number;
}

interface EvalRun {
  task: DatasetTask;
  agentId: string;
  skipped: boolean;
  conflictClass: string | null;
  episodeId: string | null;
  intentMismatch: boolean;
  durationMs: number;
  tokenUsage: TokenUsage | null;
  // nodes that would have been overwritten if this agent hadn't been skipped
  skippedBlastRadius: number;
}

// ---------------------------------------------------------------------------
// Dataset loading + selection
// ---------------------------------------------------------------------------

function loadDataset(): DatasetTask[] {
  const path = DATASET_OVERRIDE ?? DEFAULT_DATASET_PATH;
  const lines = readFileSync(path, "utf8").trim().split("\n");
  return lines.map((l) => JSON.parse(l) as DatasetTask);
}

/** Select the first N overlap zones, K tasks per zone (capped at zone's available count). */
function selectTasks(all: DatasetTask[], numZones: number, perZone: number): DatasetTask[] {
  const byZone = new Map<number, DatasetTask[]>();
  for (const t of all) {
    if (t.overlap_zone === 0) continue;
    const list = byZone.get(t.overlap_zone) ?? [];
    list.push(t);
    byZone.set(t.overlap_zone, list);
  }

  // Zones must have at least 2 tasks to be useful (need contention).
  const eligible = [...byZone.entries()]
    .filter(([, tasks]) => tasks.length >= 2)
    .sort(([a], [b]) => a - b)
    .slice(0, numZones);

  const selected: DatasetTask[] = [];
  for (const [, tasks] of eligible) {
    selected.push(...tasks.slice(0, perZone));
  }
  return selected;
}

// ---------------------------------------------------------------------------
// MCP config
// ---------------------------------------------------------------------------

function writeMcpConfig(): string {
  const configPath = join(tmpdir(), `memfleet-eval-v2-${Date.now()}.json`);
  const config = {
    mcpServers: {
      memfleet: {
        type: "http",
        url: `${HTTP_BASE_URL}/mcp`,
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

// ---------------------------------------------------------------------------
// Agent prompt
// ---------------------------------------------------------------------------

function intentStr(intent: Record<string, unknown> | string): string {
  return typeof intent === "string" ? `"${intent}"` : JSON.stringify(intent);
}

function buildPrompt(task: DatasetTask, repoId: string, coordinated: boolean): string {
  const intent = intentStr(task.intent);
  const touched = JSON.stringify(task.touched_nodes);

  return `You are benchmark agent "${task.agent_id}" in a MemFleet fleet evaluation.
You have access to the MemFleet MCP server. Follow these steps exactly.

STEP 1 — Call the publish_intent tool:
  repo_id: "${repoId}"
  agent_id: "${task.agent_id}"
  touched: ${touched}
  intent: ${intent}
  ttl_seconds: 120

${
  coordinated
    ? `STEP 2 — Read the "active_conflicts" array in the response.
  If it is non-empty: output the single word SKIPPED and stop. Do NOT call record_episode.
  If it is empty: proceed to STEP 3.`
    : `STEP 2 — Proceed regardless of any conflicts (baseline mode, never skip).`
}

STEP 3 — Describe in exactly 2 sentences what you would change and why for this task:
  Task: ${task.description}
  Service: ${task.service}
  Nodes: ${task.touched_nodes.join(", ")}

STEP 4 — Call the record_episode tool:
  repo_id: "${repoId}"
  agent_id: "${task.agent_id}"
  touched: ${touched}
  intent: ${intent}
  diff: <your 2-sentence description from STEP 3>

Do not edit any files. Do not call any other tools.`.trim();
}

// ---------------------------------------------------------------------------
// Run one agent subprocess
// ---------------------------------------------------------------------------

function runAgent(
  prompt: string,
  mcpConfigPath: string
): { durationMs: number; exitCode: number | null; tokenUsage: TokenUsage | null } {
  const t0 = Date.now();
  const result = spawnSync(
    CLAUDE_BIN,
    [
      "-p",
      "--dangerously-skip-permissions",
      "--model", MODEL,
      "--output-format", "json",
      "--mcp-config", mcpConfigPath,
    ],
    {
      input: prompt,
      encoding: "utf8",
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      // Default to the directory the bench is run from. Set
      // MEMFLEET_BENCH_AGENT_CWD if you want each Claude subprocess to run in
      // a different working directory.
      cwd: process.env.MEMFLEET_BENCH_AGENT_CWD ?? process.cwd(),
    }
  );
  const durationMs = Date.now() - t0;

  let tokenUsage: TokenUsage | null = null;
  try {
    const json = JSON.parse(result.stdout ?? "");
    const u = json.usage ?? json.result?.usage ?? null;
    if (u) {
      const input = u.input_tokens ?? 0;
      const output = u.output_tokens ?? 0;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const cacheCreate = u.cache_creation_input_tokens ?? 0;
      tokenUsage = {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreate,
        totalTokens: input + output + cacheRead + cacheCreate,
        costUsd: json.cost_usd ?? json.total_cost_usd ?? null,
      };
    }
  } catch {
    // Non-JSON output (e.g. plain-text mode or error) — leave tokenUsage null
  }

  return { durationMs, exitCode: result.status, tokenUsage };
}

// ---------------------------------------------------------------------------
// publish_intent latency probe
// ---------------------------------------------------------------------------

async function measurePublishIntentLatency(
  client: MemFleetHttpClient,
  samples = 8,
): Promise<PublishIntentLatency> {
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    await client.publishIntent({
      repoId: "latency-probe",
      agentId: `probe-${i}`,
      touched: [`probe::symbol_${i}`],
      intent: "exploratory",
      ttlSeconds: 1,
    });
    times.push(Date.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    avgMs: Math.round(times.reduce((s, t) => s + t, 0) / times.length),
    minMs: times[0],
    maxMs: times[times.length - 1],
    samples,
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function waitForServer(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`MemFleet HTTP server did not become ready within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Evaluation pass
// ---------------------------------------------------------------------------

async function runPass(
  client: MemFleetHttpClient,
  tasks: DatasetTask[],
  mcpConfigPath: string,
  label: string,
  repoId: string,
  coordinated: boolean
): Promise<EvalRun[]> {
  console.log(chalk.bold(`\n${"═".repeat(64)}`));
  console.log(chalk.bold(`  ${label}`));
  console.log(chalk.bold(`${"═".repeat(64)}\n`));

  const runs: EvalRun[] = [];

  for (const task of tasks) {
    const agentId = task.agent_id;
    process.stdout.write(`  [${task.id}] ${agentId} zone=${task.overlap_zone} — `);

    const since = new Date().toISOString();
    const prompt = buildPrompt(task, repoId, coordinated);
    const { durationMs, exitCode, tokenUsage } = runAgent(prompt, mcpConfigPath);

    if (exitCode !== 0) {
      process.stdout.write(chalk.yellow(`exit=${exitCode} `));
    }

    // Query episode store to find what this agent recorded.
    let episodeId: string | null = null;
    let conflictClass: string | null = null;
    let intentMismatch = false;
    let skipped = false;

    try {
      const { result: episodes } = await client.queryEpisodes(repoId, undefined, 50, since);
      const ep = (Array.isArray(episodes) ? episodes : (episodes as any).episodes ?? [])
        .find((e: any) => e.agent_id === agentId);
      if (ep) {
        episodeId = ep.episode_id;
        conflictClass = ep.class ?? ep.conflict_class ?? null;
        intentMismatch = ep.intent_mismatch ?? false;
      } else {
        skipped = true; // agent called SKIPPED or failed to record
      }
    } catch {
      skipped = true;
    }

    const tokenStr = tokenUsage
      ? `${tokenUsage.totalTokens} tok`
      : "? tok";

    const statusLine = skipped
      ? chalk.yellow(`SKIPPED  0 tokens saved`)
      : chalk.green(`recorded class=${conflictClass ?? "?"} episode=${episodeId?.slice(0, 8)}…  ${tokenStr}`);

    console.log(`${(durationMs / 1000).toFixed(1)}s — ${statusLine}`);

    runs.push({
      task, agentId, skipped, conflictClass, episodeId, intentMismatch, durationMs, tokenUsage,
      skippedBlastRadius: skipped ? task.touched_nodes.length : 0,
    });
  }

  return runs;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function printComparison(
  tasks: DatasetTask[],
  baseline: EvalRun[],
  coordinated: EvalRun[],
  latency: PublishIntentLatency,
): void {
  const W = 70;
  const c1 = 32, c2 = 14, c3 = 14, c4 = 10;

  function box(title: string) {
    const pad = Math.max(0, W - 2 - title.length);
    const l = Math.floor(pad / 2), r = pad - l;
    console.log(chalk.bold(`\n╔${"═".repeat(W - 2)}╗`));
    console.log(chalk.bold(`║${" ".repeat(l)}${title}${" ".repeat(r)}║`));
    console.log(chalk.bold(`╚${"═".repeat(W - 2)}╝`));
  }

  function section(title: string) {
    console.log(chalk.bold.cyan(`\n  ── ${title} ${"─".repeat(Math.max(0, W - 7 - title.length))}`));
  }

  function hdr() {
    const h = ["Metric".padEnd(c1), "Baseline".padEnd(c2), "Coordinated".padEnd(c3), "Δ Saved".padEnd(c4)].join("");
    console.log(chalk.bold(`  ${h}`));
    console.log(chalk.dim("  " + "─".repeat(c1 + c2 + c3 + c4)));
  }

  function row(label: string, b: string | number, c: string | number, delta?: string, highlight = false) {
    const line = `  ${String(label).padEnd(c1)}${String(b).padEnd(c2)}${String(c).padEnd(c3)}`;
    const d = delta ? chalk.green(delta.padEnd(c4)) : "";
    highlight ? console.log(chalk.bold(line) + d) : console.log(line + d);
  }

  function pct(n: number, d: number) { return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—"; }
  function fmt(n: number) { return n.toLocaleString(); }
  function fmtMs(ms: number) { return `${(ms / 1000).toFixed(1)}s`; }

  // ── Derived numbers ──
  const bSkipped = baseline.filter(r => r.skipped).length;
  const cSkipped = coordinated.filter(r => r.skipped).length;
  const bRan = baseline.length - bSkipped, cRan = coordinated.length - cSkipped;

  const bTok = sumTokens(baseline), cTok = sumTokens(coordinated);
  const bMs  = sumMs(baseline),     cMs  = sumMs(coordinated);

  // Per-agent averages (running agents only, for scaling projection)
  const bRunningTok = sumTokens(baseline.filter(r => !r.skipped));
  const cSkippedRuns = coordinated.filter(r => r.skipped);
  const cSkippedTok  = sumTokens(cSkippedRuns);
  const avgRunTok  = bRan > 0 ? Math.round(bRunningTok.totalTokens / bRan) : 0;
  const avgSkipTok = cSkipped > 0 ? Math.round(cSkippedTok.totalTokens / cSkipped) : 0;
  const avgSavedPerSkip = avgRunTok - avgSkipTok;

  // Conflict accuracy
  const accuracyRuns = coordinated.filter(r => !r.skipped && r.conflictClass !== null);
  const correct = accuracyRuns.filter(r => r.conflictClass === r.task.expected_conflict_class).length;

  // Blast radius
  const blastNodes = coordinated.reduce((s, r) => s + r.skippedBlastRadius, 0);

  // Coordination overhead
  const numCoordCalls = coordinated.length; // every agent calls publish_intent
  const coordOverheadMs = numCoordCalls * latency.avgMs;
  const coordOverheadPct = cMs > 0 ? ((coordOverheadMs / cMs) * 100).toFixed(2) : "—";

  // ═══════════════════════════════════════════════════════════
  box("MemFleet Benchmark — Baseline vs Coordinated");
  console.log(chalk.dim(`  ${tasks.length} tasks · ${NUM_ZONES} overlap zones · 2 agents/zone · Model: ${MODEL}\n`));

  // ── 1. Agent throughput ──
  section("1. Agent Throughput");
  hdr();
  row("Agents spawned",   baseline.length, coordinated.length);
  row("Agents ran (work done)", bRan, cRan, `-${bRan - cRan}`);
  row("Agents skipped",  bSkipped, cSkipped, `+${cSkipped}`);
  row("Useful work ratio", pct(bRan, baseline.length), pct(cRan, coordinated.length), "", true);

  // ── 2. Time ──
  section("2. Wall-Clock Time");
  hdr();
  row("Total time",      fmtMs(bMs), fmtMs(cMs), `-${fmtMs(bMs - cMs)}`);
  row("Avg per agent",   fmtMs(bMs / baseline.length), fmtMs(cMs / coordinated.length));
  row("Time saved",      "—", "—", fmtMs(bMs - cMs), true);
  row("% time reduction","—", "—", pct(bMs - cMs, bMs));

  // ── 3. Tokens & cost ──
  section("3. Token Efficiency");
  hdr();
  const hasTokens = bTok.totalTokens > 0;
  if (hasTokens) {
    row("Input tokens",         fmt(bTok.inputTokens),  fmt(cTok.inputTokens));
    row("Output tokens",        fmt(bTok.outputTokens), fmt(cTok.outputTokens));
    if (bTok.cacheReadTokens > 0)
      row("Cache-read tokens",  fmt(bTok.cacheReadTokens), fmt(cTok.cacheReadTokens));
    row("Total tokens",         fmt(bTok.totalTokens), fmt(cTok.totalTokens), `-${fmt(bTok.totalTokens - cTok.totalTokens)}`, true);
    row("Tokens / episode",     fmt(Math.round(bTok.totalTokens / bRan)), fmt(Math.round(cTok.totalTokens / cRan)));
    const bCost = bTok.costUsd?.toFixed(4) ?? "—";
    const cCost = cTok.costUsd?.toFixed(4) ?? "—";
    const savedCost = bTok.costUsd != null && cTok.costUsd != null
      ? `-$${(bTok.costUsd - cTok.costUsd).toFixed(4)}` : undefined;
    row("Estimated cost ($)",   `$${bCost}`, `$${cCost}`, savedCost, true);
  } else {
    console.log(chalk.dim("  (token data unavailable)"));
  }

  // ── 4. Conflict detection ──
  section("4. Conflict Detection & Accuracy");
  hdr();
  const cClasses = coordinated.reduce((acc, r) => {
    if (r.conflictClass) acc[r.conflictClass] = (acc[r.conflictClass] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  row("Conflict class A detected", "—", cClasses["A"] ?? 0);
  row("Conflict class B detected", "—", cClasses["B"] ?? 0);
  row("Conflict class C detected", "—", cClasses["C"] ?? 0);
  row("Classification accuracy", "—",
    accuracyRuns.length > 0 ? `${correct}/${accuracyRuns.length} (${pct(correct, accuracyRuns.length)})` : "—",
    undefined, true);
  row("Intent mismatches",  "—", coordinated.filter(r => !r.skipped && r.intentMismatch).length);

  // ── 5. Blast radius ──
  section("5. Destructive Overwrite Prevention");
  hdr();
  row("Class C conflicts in baseline",  baseline.filter(r => r.conflictClass === "C").length, "—");
  row("Class C conflicts in coordinated", "—", coordinated.filter(r => r.conflictClass === "C").length);
  row("Nodes protected from overwrite",  "—", blastNodes, `+${blastNodes}`, true);
  const blastZones = coordinated.filter(r => r.skippedBlastRadius > 0);
  console.log(chalk.dim(`  (${blastZones.length} zones had nodes that would have been overwritten)`));

  // ── 6. Coordination overhead ──
  section("6. MemFleet Coordination Overhead");
  hdr();
  row("publish_intent avg latency", "—", `${latency.avgMs}ms`);
  row("publish_intent min/max",     "—", `${latency.minMs}/${latency.maxMs}ms`);
  row("Total coord. calls",         "—", numCoordCalls);
  row("Total coord. overhead",      "—", `${coordOverheadMs}ms`, undefined);
  row("Overhead as % of run time",  "—", `${coordOverheadPct}%`, undefined, true);
  console.log(chalk.dim(`  (${samples} latency samples at ${HTTP_BASE_URL})`));

  // ── 7. Fleet scaling projection ──
  section("7. Fleet Scaling Projection (per zone, varying N agents)");
  console.log(chalk.dim(`  Based on avg ${fmt(avgRunTok)} tok/running-agent, ${fmt(avgSkipTok)} tok/skipped-agent`));
  console.log(chalk.dim(`  Saved per skip: ~${fmt(avgSavedPerSkip)} tokens\n`));

  const scaleLine = ["N agents/zone".padEnd(18), "Baseline tok".padEnd(16), "Coordinated tok".padEnd(18), "Tokens saved".padEnd(16), "% saved"].join("");
  console.log(chalk.bold(`  ${scaleLine}`));
  console.log(chalk.dim("  " + "─".repeat(82)));
  for (const n of [2, 5, 10, 20, 50]) {
    const bTokN = n * avgRunTok;
    const cTokN = avgRunTok + (n - 1) * avgSkipTok;
    const saved = bTokN - cTokN;
    const savePct = bTokN > 0 ? ((saved / bTokN) * 100).toFixed(1) : "—";
    const line = `  ${String(n).padEnd(18)}${fmt(bTokN).padEnd(16)}${fmt(cTokN).padEnd(18)}${fmt(saved).padEnd(16)}${savePct}%`;
    console.log(n === NUM_ZONES * 2 ? chalk.bold(line) + chalk.dim(" ← this run") : line);
  }

  // ── Summary ──
  const redundantPct = pct(cSkipped, tasks.length);
  const timeSavedPct = pct(bMs - cMs, bMs);
  const tokSavedPct  = hasTokens ? pct(bTok.totalTokens - cTok.totalTokens, bTok.totalTokens) : "—";

  console.log(chalk.bold(`\n  ╔${"═".repeat(W - 2)}╗`));
  console.log(chalk.bold.green(`  ║  ${`${redundantPct} redundant agents eliminated`.padEnd(W - 4)}║`));
  console.log(chalk.bold.green(`  ║  ${`${timeSavedPct} wall-clock time saved (${fmtMs(bMs - cMs)})`.padEnd(W - 4)}║`));
  if (hasTokens) {
    console.log(chalk.bold.green(`  ║  ${`${tokSavedPct} tokens saved · $${(bTok.costUsd! - cTok.costUsd!).toFixed(4)} cost reduction`.padEnd(W - 4)}║`));
    console.log(chalk.bold.green(`  ║  ${`${blastNodes} nodes protected from destructive overwrites`.padEnd(W - 4)}║`));
    console.log(chalk.bold.green(`  ║  ${`Coordination overhead: ${coordOverheadPct}% of total run time`.padEnd(W - 4)}║`));
  }
  console.log(chalk.bold(`  ╚${"═".repeat(W - 2)}╝`));

  // Per-zone table
  console.log(chalk.bold(`\n  Per-zone breakdown:`));
  const zones = [...new Set(tasks.map(t => t.overlap_zone))].sort((a, b) => a - b);
  for (const zone of zones) {
    const zRuns  = coordinated.filter(r => r.task.overlap_zone === zone);
    const zSkip  = zRuns.filter(r => r.skipped).length;
    const zTok   = sumTokens(zRuns);
    const zBlast = zRuns.reduce((s, r) => s + r.skippedBlastRadius, 0);
    const zClass = zRuns.filter(r => r.conflictClass).map(r => r.conflictClass).join(",");
    console.log(
      chalk.dim(
        `    Zone ${zone}: ${zRuns.length} agents, ${zSkip} skipped` +
        (zClass ? `, class=[${zClass}]` : "") +
        (zTok.totalTokens > 0 ? `, ${fmt(zTok.totalTokens)} tok` : "") +
        (zBlast > 0 ? `, ${zBlast} nodes protected` : "")
      )
    );
  }
}

const samples = 8; // referenced in printComparison

function sumTokens(runs: EvalRun[]): TokenUsage {
  const zero: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: 0 };
  return runs.reduce((acc, r) => {
    if (!r.tokenUsage) return acc;
    return {
      inputTokens:       acc.inputTokens       + r.tokenUsage.inputTokens,
      outputTokens:      acc.outputTokens      + r.tokenUsage.outputTokens,
      cacheReadTokens:   acc.cacheReadTokens   + r.tokenUsage.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + r.tokenUsage.cacheCreationTokens,
      totalTokens:       acc.totalTokens       + r.tokenUsage.totalTokens,
      costUsd:           (acc.costUsd ?? 0)    + (r.tokenUsage.costUsd ?? 0),
    };
  }, zero);
}

function sumMs(runs: EvalRun[]): number {
  return runs.reduce((s, r) => s + r.durationMs, 0);
}

function writeResults(baseline: EvalRun[], coordinated: EvalRun[], latency: PublishIntentLatency): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  const dir = join(__dirname, "../results/v2");
  // Auto-create the results dir — fixes silent ENOENT when results/v2 missing.
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const path = join(dir, `${timestamp}-k${PER_ZONE}-dataset-v2.json`);
  writeFileSync(
    path,
    JSON.stringify({
      timestamp,
      model: MODEL,
      numZones: NUM_ZONES,
      perZone: PER_ZONE,
      datasetPath: DATASET_OVERRIDE ?? DEFAULT_DATASET_PATH,
      latency,
      baseline,
      coordinated,
    }, null, 2)
  );
  console.log(chalk.dim(`\nResults written to ${path}`));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(chalk.bold("MemFleet Dataset Eval v2 — Dynamic Agents with MCP Tool Calls"));
  console.log(chalk.dim(`Zones: ${NUM_ZONES}  Per-zone: ${PER_ZONE}  Model: ${MODEL}  Port: ${HTTP_PORT}`));
  console.log(chalk.dim(`Dataset: ${DATASET_OVERRIDE ?? DEFAULT_DATASET_PATH}\n`));

  // Load + select tasks
  const all = loadDataset();
  const tasks = selectTasks(all, NUM_ZONES, PER_ZONE);

  console.log(chalk.dim(`Selected ${tasks.length} tasks from ${NUM_ZONES} overlap zones, ${PER_ZONE} agents/zone:`));
  for (const t of tasks) {
    const intentKey = typeof t.intent === "string" ? t.intent : Object.keys(t.intent)[0];
    console.log(
      chalk.dim(`  ${t.id}  zone=${t.overlap_zone}  ${t.agent_id}  intent=${intentKey}  expect=${t.expected_conflict_class}`)
    );
  }

  // Connect to already-running memfleet instance
  console.log(chalk.dim(`\nConnecting to MemFleet at ${HTTP_BASE_URL}...`));
  await waitForServer(HTTP_BASE_URL, 3000);
  console.log(chalk.green("MemFleet ready.\n"));

  const client = new MemFleetHttpClient(HTTP_BASE_URL);
  await client.initialize();

  // Measure publish_intent round-trip latency before running agents
  process.stdout.write(chalk.dim(`Measuring publish_intent latency (${samples} samples)... `));
  const latency = await measurePublishIntentLatency(client, samples);
  console.log(chalk.dim(`avg=${latency.avgMs}ms  min=${latency.minMs}ms  max=${latency.maxMs}ms\n`));

  const mcpConfigPath = writeMcpConfig();

  // Pass 1: Baseline — agents never skip
  const baseline = await runPass(
    client, tasks, mcpConfigPath,
    "BASELINE — all agents run, no conflict skipping",
    `eval-v2-baseline-${RUN_ID}`,
    false
  );

  // Pass 2: Coordinated — agents self-skip on conflict
  const coordinated = await runPass(
    client, tasks, mcpConfigPath,
    "COORDINATED — agents skip when publish_intent returns conflicts",
    `eval-v2-coordinated-${RUN_ID}`,
    true
  );

  // Report
  printComparison(tasks, baseline, coordinated, latency);
  writeResults(baseline, coordinated, latency);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
