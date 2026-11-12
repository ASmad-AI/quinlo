import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMessage, parseBody, RpcError, SessionStore, type JsonRpcResponse } from "./protocol";
import { buildTools } from "./tools";
import type { McpContext, PlatformPort, ToolDefinition } from "./types";

/**
 * HTTP transports for the MCP server (dependency-free, node:http only):
 *
 *  - Streamable HTTP (current, MCP 2025-03-26+): POST /mcp with
 *    `Accept: application/json, text/event-stream`. The server answers with
 *    plain JSON (allowed by the spec). GET /mcp opens an SSE stream for
 *    server-initiated messages. DELETE /mcp terminates a session.
 *    Sessions are optional: when a client sends Mcp-Session-Id it is
 *    validated; when it does not, requests run statelessly. This keeps
 *    simple clients and curl working while full clients get sessions.
 *
 *  - Legacy SSE (MCP 2024-11-05): GET /sse returns an `endpoint` event,
 *    POST /messages?session_id=... carries JSON-RPC, responses flow back
 *    over the SSE stream.
 *
 * Authentication: `Authorization: Bearer <api key or session token>` on
 * every request. Missing/invalid credentials get HTTP 401 before any
 * JSON-RPC processing (fail closed). There is intentionally no anonymous
 * mode. Full OAuth 2.0 dynamic client registration is NOT implemented —
 * see docs/mcp-clients.md for which clients that affects.
 */

export interface McpHttpOptions {
  /** Maximum JSON body size in bytes (default 5 MiB). */
  maxBodyBytes?: number;
  messagesPath?: string;
  port: PlatformPort;
  ssePath?: string;
  streamablePath?: string;
  tools?: ToolDefinition[];
}

const MAX_BODY_DEFAULT = 5 * 1024 * 1024;

export interface McpHttpHandler {
  /** Returns true when the request path belonged to MCP (handled). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  sessions: SessionStore;
}

export function createMcpHttpHandler(options: McpHttpOptions): McpHttpHandler {
  const tools = options.tools ?? buildTools();
  const sessions = new SessionStore();
  const streamablePath = options.streamablePath ?? "/mcp";
  const ssePath = options.ssePath ?? "/sse";
  const messagesPath = options.messagesPath ?? "/messages";
  const maxBody = options.maxBodyBytes ?? MAX_BODY_DEFAULT;

  // Legacy SSE streams: sessionId -> response object.
  const sseStreams = new Map<string, ServerResponse>();

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBody) throw new Error("Request body too large");
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function authenticate(req: IncomingMessage): Promise<McpContext | null> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    if (!token) return null;
    return options.port.authenticate(token);
  }

  function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
    const body = JSON.stringify(value);
    res.writeHead(status, { "content-length": Buffer.byteLength(body), "content-type": "application/json", ...headers });
    res.end(body);
  }

  function sendRpcError(res: ServerResponse, id: number | string | null, code: number, message: string): void {
    sendJson(res, 200, { error: { code, message }, id, jsonrpc: "2.0" });
  }

  async function handleStreamablePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx = await authenticate(req);
    if (!ctx) {
      sendJson(res, 401, { error: "Missing or invalid Bearer token" });
      return;
    }
    const sessionHeader = req.headers["mcp-session-id"];
    if (typeof sessionHeader === "string" && !sessions.get(sessionHeader)) {
      sendJson(res, 404, { error: "Unknown MCP session" });
      return;
    }
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch {
      sendJson(res, 413, { error: "Request body too large" });
      return;
    }
    const { messages, parseError } = parseBody(bodyText);
    if (parseError) {
      sendRpcError(res, null, RpcError.PARSE_ERROR, "Parse error");
      return;
    }
    const responses: JsonRpcResponse[] = [];
    let newSessionId: string | undefined;
    for (const raw of messages) {
      const response = await handleMessage(
        raw,
        { ctx, port: options.port, sessions, tools },
        (s) => {
          newSessionId = s.id;
        },
      );
      if (response) responses.push(response);
    }
    const headers: Record<string, string> = {};
    if (newSessionId) headers["mcp-session-id"] = newSessionId;
    if (sessionHeader && typeof sessionHeader === "string") sessions.touch(sessionHeader);
    if (responses.length === 0) {
      res.writeHead(202, headers);
      res.end();
      return;
    }
    const wasBatch = messages.length > 1;
    sendJson(res, 200, wasBatch ? responses : responses[0], headers);
  }

  function handleStreamableGet(req: IncomingMessage, res: ServerResponse): void {
    const accept = req.headers.accept ?? "";
    if (!accept.includes("text/event-stream")) {
      sendJson(res, 405, { error: "GET on the MCP endpoint requires Accept: text/event-stream" });
      return;
    }
    // Authenticate asynchronously, then hold the stream open.
    void authenticate(req).then((ctx) => {
      if (!ctx) {
        sendJson(res, 401, { error: "Missing or invalid Bearer token" });
        return;
      }
      res.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      res.write(": connected\n\n");
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(": ping\n\n");
      }, 30000);
      heartbeat.unref?.();
      req.on("close", () => clearInterval(heartbeat));
    });
  }

  function handleStreamableDelete(req: IncomingMessage, res: ServerResponse): void {
    const sessionHeader = req.headers["mcp-session-id"];
    if (typeof sessionHeader === "string") sessions.remove(sessionHeader);
    res.writeHead(204);
    res.end();
  }

  async function handleLegacySse(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx = await authenticate(req);
    if (!ctx) {
      sendJson(res, 401, { error: "Missing or invalid Bearer token" });
      return;
    }
    const session = sessions.create();
    res.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    res.write(`event: endpoint\ndata: ${messagesPath}?session_id=${session.id}\n\n`);
    sseStreams.set(session.id, res);
    req.on("close", () => {
      sseStreams.delete(session.id);
      sessions.remove(session.id);
    });
  }

  async function handleLegacyMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx = await authenticate(req);
    if (!ctx) {
      sendJson(res, 401, { error: "Missing or invalid Bearer token" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("session_id");
    if (!sessionId || !sessions.get(sessionId)) {
      sendJson(res, 404, { error: "Unknown MCP session" });
      return;
    }
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch {
      sendJson(res, 413, { error: "Request body too large" });
      return;
    }
    const { messages, parseError } = parseBody(bodyText);
    if (parseError) {
      sendRpcError(res, null, RpcError.PARSE_ERROR, "Parse error");
      return;
    }
    sessions.touch(sessionId);
    const stream = sseStreams.get(sessionId);
    const responses: JsonRpcResponse[] = [];
    for (const raw of messages) {
      const response = await handleMessage(raw, { ctx, port: options.port, sessions, tools });
      if (response) responses.push(response);
    }
    if (stream && !stream.writableEnded) {
      for (const r of responses) {
        stream.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`);
      }
      res.writeHead(202);
      res.end();
    } else if (responses.length > 0) {
      // Stream gone (e.g. test clients): answer inline instead of dropping.
      sendJson(res, 200, responses.length === 1 ? responses[0] : responses);
    } else {
      res.writeHead(202);
      res.end();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path === streamablePath) {
      if (req.method === "POST") await handleStreamablePost(req, res);
      else if (req.method === "GET") handleStreamableGet(req, res);
      else if (req.method === "DELETE") handleStreamableDelete(req, res);
      else sendJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (path === ssePath && req.method === "GET") {
      await handleLegacySse(req, res);
      return true;
    }
    if (path === messagesPath && req.method === "POST") {
      await handleLegacyMessages(req, res);
      return true;
    }
    return false;
  }

  return { handle, sessions };
}
