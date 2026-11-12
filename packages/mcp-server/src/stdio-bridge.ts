/**
 * stdio ↔ Streamable HTTP bridge.
 *
 * Lets MCP clients that only speak stdio (Claude Desktop local configs,
 * many agent harnesses, Ollama-based tool loops) talk to this platform's
 * MCP server over HTTP. Reads newline-delimited JSON-RPC from
 * stdin, POSTs each message to the HTTP endpoint, writes the response(s)
 * to stdout.
 *
 * Configuration (environment):
 *   QUINLO_MCP_URL    e.g. https://mcp.example.com/mcp (required)
 *   QUINLO_MCP_TOKEN  Bearer API key (required)
 *
 * The bridge keeps no state beyond the MCP session id returned by
 * `initialize`, which it forwards on later requests. It never logs the
 * token. Run: `node packages/mcp-server/dist/stdio-bridge.js`
 */

import * as readline from "node:readline";

const MCP_URL = process.env.QUINLO_MCP_URL ?? "";
const MCP_TOKEN = process.env.QUINLO_MCP_TOKEN ?? "";

if (!MCP_URL || !MCP_TOKEN) {
  process.stderr.write(
    "stdio-bridge: QUINLO_MCP_URL and QUINLO_MCP_TOKEN must both be set.\n",
  );
  process.exit(2);
}

let sessionId: string | undefined;

async function forward(line: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // Ignore malformed input lines; never crash the bridge.
  }
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${MCP_TOKEN}`,
    "content-type": "application/json",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  let res: Response;
  try {
    res = await fetch(MCP_URL, { body: JSON.stringify(parsed), headers, method: "POST" });
  } catch (err) {
    process.stderr.write(`stdio-bridge: request failed: ${(err as Error).message}\n`);
    return;
  }
  const returned = res.headers.get("mcp-session-id");
  if (returned) sessionId = returned;
  if (res.status === 202 || res.status === 204) return; // Notification: no reply.
  const text = await res.text();
  if (!text) return;
  // The server answers with one JSON-RPC message or a batch array. Emit
  // each message on its own stdout line.
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  const messages = Array.isArray(payload) ? payload : [payload];
  for (const m of messages) {
    process.stdout.write(`${JSON.stringify(m)}\n`);
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ crlfDelay: Infinity, input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Sequential processing preserves request/response ordering.
    await forward(trimmed);
  }
}

void main();
