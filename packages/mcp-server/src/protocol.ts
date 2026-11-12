import { BRANDING, newId } from "@openforge/shared";
import { executeTool } from "./tools";
import type { McpContext, PlatformPort, ToolDefinition } from "./types";

/**
 * MCP JSON-RPC 2.0 core, transport-independent.
 *
 * Supported protocol versions: the server answers with its own version
 * (2025-06-18) and accepts any client version string. Capabilities:
 * tools only — no prompts, no resources, no sampling (documented in
 * PARITY.md; prompts/resources are a follow-up, not silently implied).
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
  id?: number | string | null;
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcResponse =
  | { error: { code: number; data?: unknown; message: string }; id: number | string | null; jsonrpc: "2.0" }
  | { id: number | string | null; jsonrpc: "2.0"; result: unknown };

export const RpcError = {
  INTERNAL: -32603,
  INVALID_PARAMS: -32602,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  PARSE_ERROR: -32700,
} as const;

export interface McpSession {
  createdAt: number;
  id: string;
  lastSeen: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, McpSession>();
  private readonly ttlMs: number;

  constructor(ttlMs = 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  create(): McpSession {
    const now = Date.now();
    const session: McpSession = { createdAt: now, id: newId("sess"), lastSeen: now };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): McpSession | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (Date.now() - s.lastSeen > this.ttlMs) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }

  touch(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.lastSeen = Date.now();
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > this.ttlMs) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.sessions.size;
  }
}

export interface ProtocolDeps {
  ctx: McpContext;
  port: PlatformPort;
  sessions: SessionStore;
  tools: ToolDefinition[];
}

function isNotification(msg: JsonRpcRequest): boolean {
  return msg.id === undefined;
}

function errorResponse(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { error: { code, data, message }, id, jsonrpc: "2.0" };
}

function okResponse(id: number | string | null, result: unknown): JsonRpcResponse {
  return { id, jsonrpc: "2.0", result };
}

/**
 * Handle one JSON-RPC message. Returns null for notifications (no reply).
 * `onInitialize` receives the new session so the transport can set the
 * Mcp-Session-Id header.
 */
export async function handleMessage(
  raw: unknown,
  deps: ProtocolDeps,
  onInitialize?: (session: McpSession) => void,
): Promise<JsonRpcResponse | null> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return errorResponse(null, RpcError.INVALID_REQUEST, "Request must be a JSON-RPC object");
  }
  const msg = raw as Partial<JsonRpcRequest>;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
    return errorResponse(id, RpcError.INVALID_REQUEST, "Invalid JSON-RPC request");
  }
  const id = msg.id === undefined ? null : (msg.id as number | string | null);
  const notification = isNotification(msg as JsonRpcRequest);

  // Notifications never get a response.
  if (msg.method.startsWith("notifications/")) {
    return null;
  }
  if (notification) {
    return null;
  }

  switch (msg.method) {
    case "initialize": {
      const session = deps.sessions.create();
      onInitialize?.(session);
      return okResponse(id, {
        capabilities: { tools: {} },
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: BRANDING.slug, version: BRANDING.version },
      });
    }
    case "ping":
      return okResponse(id, {});
    case "tools/list":
      return okResponse(id, {
        tools: deps.tools.map((t) => ({
          description: t.description,
          inputSchema: t.inputSchema,
          name: t.name,
        })),
      });
    case "tools/call": {
      const params = (msg.params ?? {}) as { arguments?: unknown; name?: unknown };
      if (typeof params.name !== "string") {
        return errorResponse(id, RpcError.INVALID_PARAMS, "tools/call requires a string 'name'");
      }
      const outcome = await executeTool(deps.tools, params.name, params.arguments, deps.ctx, deps.port);
      return okResponse(id, {
        content: [{ text: JSON.stringify(outcome.data), type: "text" }],
        isError: outcome.isError,
      });
    }
    default:
      return errorResponse(id, RpcError.METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}

/** Parse a request body that may hold one message or a batch array. */
export function parseBody(
  bodyText: string,
): { messages: unknown[]; parseError: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { messages: [], parseError: true };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { messages: [], parseError: true };
    return { messages: parsed, parseError: false };
  }
  return { messages: [parsed], parseError: false };
}
