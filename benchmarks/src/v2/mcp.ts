/**
 * MemFleetHttpClient — sends MCP tool calls over the Streamable HTTP transport.
 *
 * The rmcp Streamable HTTP transport:
 * - POST /mcp with JSON-RPC body + Accept: application/json, text/event-stream
 * - Response is SSE-framed: `data: <json>\nid: <n>\n\n`
 * - Session ID is returned in `Mcp-Session-Id` header and must be echoed back
 * - Tool results are in result.content[0].text (pretty-printed JSON string)
 */

export class MemFleetHttpClient {
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(private readonly baseUrl: string) {}

  /** Initialize MCP session with the server. Call once before tool calls. */
  async initialize(): Promise<void> {
    const id = this.nextId++;
    const body = {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "memfleet-benchmark", version: "2.0.0" },
      },
    };
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`MCP init failed HTTP ${res.status}: ${await res.text()}`);
    }
    // Capture session ID for subsequent requests.
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    // Drain SSE body.
    await res.text();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  /** Parse SSE-framed response and extract the first data: JSON object. */
  private async parseSseResponse(res: Response): Promise<unknown> {
    const text = await res.text();
    for (const line of text.split("\n")) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("data:")) {
        const json = trimmed.slice(5).trim();
        if (json) return JSON.parse(json);
      }
    }
    throw new Error(`No data event in SSE response: ${text}`);
  }

  private async call<T>(toolName: string, args: Record<string, unknown>): Promise<{ result: T; elapsedMs: number }> {
    const id = this.nextId++;
    const body = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    };

    const t0 = Date.now();
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from MemFleet: ${await res.text()}`);
    }

    const envelope = (await this.parseSseResponse(res)) as {
      jsonrpc: "2.0";
      id: number;
      result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
      error?: { code: number; message: string };
    };
    const elapsedMs = Date.now() - t0;

    if (envelope.error) {
      throw new Error(`MCP error ${envelope.error.code}: ${envelope.error.message}`);
    }

    // Tool results are serialized JSON inside result.content[0].text
    const textContent = envelope.result?.content?.find(c => c.type === "text")?.text;
    if (textContent === undefined) {
      throw new Error(`No text content in MCP response: ${JSON.stringify(envelope)}`);
    }

    const parsed = JSON.parse(textContent) as T;
    return { result: parsed, elapsedMs };
  }

  async fleetStatus(repoId: string) {
    return this.call<{ active_intents: number }>("fleet_status", { repo_id: repoId });
  }

  async publishIntent(params: {
    repoId: string;
    agentId: string;
    touched: string[];
    intent: unknown;
    ttlSeconds: number;
  }) {
    return this.call<{ intent_id: string; active_conflicts: unknown[] }>("publish_intent", {
      repo_id: params.repoId,
      agent_id: params.agentId,
      touched: params.touched,
      intent: params.intent,
      ttl_seconds: params.ttlSeconds,
    });
  }

  async recordEpisode(params: {
    repoId: string;
    agentId: string;
    touched: string[];
    intent: unknown;
    diff: string;
    overlayId?: string;
    parentEpisodeId?: string;
  }) {
    return this.call<{
      episode_id: string;
      conflict_class: string;
      propagated: string[];
      auto_merged: boolean;
      merge_rule: string | null;
      intent_mismatch: boolean;
      replan_hint: string;
    }>("record_episode", {
      repo_id: params.repoId,
      agent_id: params.agentId,
      touched: params.touched,
      intent: params.intent,
      diff: params.diff,
      ...(params.overlayId ? { overlay_id: params.overlayId } : {}),
      ...(params.parentEpisodeId ? { parent_episode_id: params.parentEpisodeId } : {}),
    });
  }

  async getNodeState(repoId: string, node: string) {
    return this.call<{
      node: string;
      active_intents: Array<{ intent_id: string; agent_id: string; intent: unknown; expires_at: string }>;
      pending_leases: Array<{ lease_id: string; agent_id: string; state: string; expires_at: string | null }>;
      conflict_density: number;
    }>("get_node_state", { repo_id: repoId, node });
  }

  async acquireLease(params: {
    repoId: string;
    scope: string[];
    priority: number;
    ttlSeconds?: number;
  }) {
    return this.call<{
      lease_id: string;
      state: string;
      expires_at: string | null;
      eta_seconds: number | null;
      preempts: string[];
    }>("acquire_lease", {
      repo_id: params.repoId,
      scope: params.scope,
      priority: params.priority,
      ...(params.ttlSeconds !== undefined ? { ttl_seconds: params.ttlSeconds } : {}),
    });
  }

  async releaseLease(leaseId: string) {
    return this.call<{ released: boolean }>("release_lease", { lease_id: leaseId });
  }

  async queryEpisodes(repoId: string, node?: string, limit = 100, since?: string) {
    return this.call<Array<{
      episode_id: string;
      agent_id: string;
      intent: unknown;
      reference_time: string;
      class: string;
    }>>("query_episodes", {
      repo_id: repoId,
      ...(node ? { node } : {}),
      limit,
      ...(since ? { since } : {}),
    });
  }
}
