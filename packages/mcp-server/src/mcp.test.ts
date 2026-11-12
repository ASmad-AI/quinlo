import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";
import { createMcpHttpHandler } from "./transports";
import type { McpContext, PlatformPort } from "./types";

const GOOD_TOKEN = "tok_good";

function fakePort(): { auditCalls: Array<Record<string, unknown>>; port: PlatformPort } {
  const auditCalls: Array<Record<string, unknown>> = [];
  const echo = async (_ctx: McpContext, args: unknown) => ({ echoed: args });
  const port: PlatformPort = {
    authenticate: async (token: string) =>
      token === GOOD_TOKEN
        ? { actorType: "mcp", orgId: "org_1", profileName: "Admin", userId: "user_1" }
        : null,
    applySecurityProfile: echo,
    audit: async (_ctx, action, detail) => {
      auditCalls.push({ action, ...detail });
    },
    configureAuth: echo,
    createApp: echo,
    createEdgeFunction: echo,
    deployFrontend: echo,
    getAuditLog: echo,
    getPreview: echo,
    getSchema: echo,
    listApps: echo,
    listFiles: echo,
    listFunctions: echo,
    manageSecret: echo,
    provisionDatabase: echo,
    readFile: echo,
    runBuild: echo,
    setupBilling: echo,
    writeFile: echo,
  };
  return { auditCalls, port };
}

describe("MCP Streamable HTTP", () => {
  let baseUrl = "";
  let server: Server;
  let auditCalls: Array<Record<string, unknown>>;

  before(async () => {
    const fake = fakePort();
    auditCalls = fake.auditCalls;
    const handler = createMcpHttpHandler({ port: fake.port });
    server = createServer((req, res) => {
      void handler.handle(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function rpc(body: unknown, token: string | null = GOOD_TOKEN, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/mcp`, {
      body: JSON.stringify(body),
      headers: {
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        ...headers,
      },
      method: "POST",
    });
  }

  test("unauthenticated requests get 401 before any JSON-RPC processing", async () => {
    const res = await rpc({ id: 1, jsonrpc: "2.0", method: "ping" }, null);
    assert.equal(res.status, 401);
    const bad = await rpc({ id: 1, jsonrpc: "2.0", method: "ping" }, "tok_bad");
    assert.equal(bad.status, 401);
  });

  test("initialize returns protocol version, server info, and a session id", async () => {
    const res = await rpc({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { capabilities: {}, clientInfo: { name: "test", version: "0" }, protocolVersion: "2025-06-18" },
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("mcp-session-id"), "session id header present");
    const payload = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    assert.equal(payload.result.protocolVersion, "2025-06-18");
    assert.equal(payload.result.serverInfo.name, "quinlo");
  });

  test("ping, tools/list, and notifications behave per spec", async () => {
    const ping = await rpc({ id: 2, jsonrpc: "2.0", method: "ping" });
    assert.deepEqual((await ping.json()) as unknown, { id: 2, jsonrpc: "2.0", result: {} });

    const list = await rpc({ id: 3, jsonrpc: "2.0", method: "tools/list" });
    const listed = (await list.json()) as { result: { tools: Array<{ name: string }> } };
    const names = listed.result.tools.map((t) => t.name);
    assert.equal(names.length, 18);
    for (const required of ["provision_database", "configure_auth", "apply_security_profile", "setup_billing", "deploy_frontend", "get_instructions"]) {
      assert.ok(names.includes(required), `missing tool ${required}`);
    }

    const notif = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(notif.status, 202);
    assert.equal(await notif.text(), "");
  });

  test("tools/call executes, validates, and audits", async () => {
    const before = auditCalls.length;
    const call = await rpc({
      id: 4,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          appId: "app_1",
          schema: { collections: [{ attributes: [{ name: "title", type: "string" }], name: "tasks" }] },
        },
        name: "provision_database",
      },
    });
    const payload = (await call.json()) as { result: { content: Array<{ text: string }>; isError: boolean } };
    assert.equal(payload.result.isError, false);
    assert.ok(payload.result.content[0].text.includes("app_1"));
    assert.equal(auditCalls.length, before + 1);
    assert.equal(auditCalls[auditCalls.length - 1].tool, "provision_database");
    assert.equal(auditCalls[auditCalls.length - 1].success, true);

    // Invalid args: missing required schema -> isError, not a crash.
    const invalid = await rpc({
      id: 5,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { appId: "app_1" }, name: "provision_database" },
    });
    const badPayload = (await invalid.json()) as { result: { content: Array<{ text: string }>; isError: boolean } };
    assert.equal(badPayload.result.isError, true);
    assert.ok(badPayload.result.content[0].text.includes("schema"));

    // Unknown tool -> isError.
    const unknown = await rpc({
      id: 6,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "nope" },
    });
    const unknownPayload = (await unknown.json()) as { result: { isError: boolean } };
    assert.equal(unknownPayload.result.isError, true);
  });

  test("unknown method returns JSON-RPC -32601; batch returns an array", async () => {
    const res = await rpc({ id: 7, jsonrpc: "2.0", method: "resources/list" });
    const payload = (await res.json()) as { error: { code: number } };
    assert.equal(payload.error.code, -32601);

    const batch = await rpc([
      { id: 8, jsonrpc: "2.0", method: "ping" },
      { id: 9, jsonrpc: "2.0", method: "ping" },
    ]);
    const arr = (await batch.json()) as Array<{ id: number }>;
    assert.equal(arr.length, 2);
    assert.deepEqual(arr.map((r) => r.id), [8, 9]);
  });

  test("malformed JSON returns a parse error, not a 500", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      body: "{not json",
      headers: { authorization: `Bearer ${GOOD_TOKEN}`, "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { error: { code: number } };
    assert.equal(payload.error.code, -32700);
  });

  test("unknown Mcp-Session-Id is rejected", async () => {
    const res = await rpc({ id: 10, jsonrpc: "2.0", method: "ping" }, GOOD_TOKEN, {
      "mcp-session-id": "sess_does_not_exist",
    });
    assert.equal(res.status, 404);
  });
});

describe("MCP legacy SSE transport", () => {
  test("GET /sse emits endpoint; POST /messages delivers the response over SSE", async () => {
    const { port } = fakePort();
    const handler = createMcpHttpHandler({ port });
    const server = createServer((req, res) => {
      void handler.handle(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const ssePort = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${ssePort}`;

    try {
      // Open the SSE stream with a raw fetch reader and buffer everything.
      const sseRes = await fetch(`${base}/sse`, {
        headers: { authorization: `Bearer ${GOOD_TOKEN}` },
      });
      assert.equal(sseRes.status, 200);
      const reader = sseRes.body?.getReader();
      assert.ok(reader);
      let buf = "";
      const pump = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buf += new TextDecoder().decode(value);
        }
      })();
      void pump;

      const waitFor = async (pred: (b: string) => boolean, label: string): Promise<void> => {
        const deadline = Date.now() + 5000;
        while (!pred(buf)) {
          if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}; got: ${buf}`);
          await new Promise((r) => setTimeout(r, 10));
        }
      };

      await waitFor((b) => b.includes("event: endpoint"), "endpoint event");
      const m = buf.match(/event: endpoint\ndata: ([^\n]+)/);
      assert.ok(m, `endpoint event parseable in: ${buf}`);
      const endpoint = m[1];
      assert.ok(endpoint.startsWith("/messages?session_id="), endpoint);

      const post = await fetch(`${base}${endpoint}`, {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "ping" }),
        headers: { authorization: `Bearer ${GOOD_TOKEN}`, "content-type": "application/json" },
        method: "POST",
      });
      assert.equal(post.status, 202);

      await waitFor((b) => b.includes("event: message"), "message event");
      assert.ok(buf.includes('"id":1'), `ping response visible on SSE stream: ${buf}`);
      await reader.cancel();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
