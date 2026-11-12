# MCP Clients — Setup & Honest Support Matrix

The MCP server speaks **Streamable HTTP** (primary) at `/mcp` and
**legacy SSE** at `/sse`, plus a **stdio bridge** for clients that only
speak stdio. Authentication is a **Bearer API key** created in the
Studio (Security → API keys). There is no anonymous mode and no OAuth
dynamic client registration — see the matrix below.

Base URL in the examples: `https://forge.example.com`. Replace it with
your deployment's base URL. The MCP path comes from `branding.json`
(`mcpPath: /mcp`).

## Support matrix (honest)

| Client | Remote HTTP MCP | Auth that works here | Notes |
|---|---|---|---|
| Claude Code | Yes | Bearer API key in headers | Recommended path. Configure as below. |
| Cursor | Yes | Bearer API key in headers | Remote MCP supported; config shape varies by version — use the `http` server type with headers. |
| Claude Desktop | Varies | stdio bridge (recommended) | Desktop historically prefers local stdio servers; remote HTTP support depends on version. The stdio bridge is the reliable path. |
| ChatGPT (MCP) | Varies by plan/client | Bearer key or bridge | ChatGPT's MCP support varies by plan and client, and some flows expect OAuth DCR, which this server does not implement. If remote HTTP fails, use the stdio bridge with a local harness. Not verified live here. |
| Ollama-based agents | No native MCP | Harness + stdio bridge | Ollama has **no native MCP support**. Use an agent harness (e.g. a tool loop that speaks MCP over stdio) with the bridge below. |
| Any MCP SDK client | Yes | Bearer API key | Plain JSON responses are accepted by the Streamable HTTP spec; SSE streaming is also served on GET. |

Protocol details: `initialize` answers protocol version `2025-06-18`;
capabilities advertise `tools` only (no prompts/resources/sampling —
see `PARITY.md`). Sessions are optional: a session id header is
validated when present; stateless requests are accepted.

## Remote HTTP config (Claude Code / Cursor)

```json
{
  "mcpServers": {
    "openforge": {
      "type": "http",
      "url": "https://forge.example.com/mcp",
      "headers": { "Authorization": "Bearer ofk_your_key_here" }
    }
  }
}
```

Claude Code CLI equivalent:

```sh
claude mcp add --transport http openforge https://forge.example.com/mcp \
  --header "Authorization: Bearer ofk_your_key_here"
```

## stdio bridge (Claude Desktop, harnesses, Ollama loops)

The bridge reads newline-delimited JSON-RPC on stdin, POSTs each
message to the HTTP endpoint, and writes responses to stdout. It keeps
no state beyond the MCP session id and never logs the token.

```sh
# Build once (from the repo root):
npm run build

# Run with env config:
OPENFORGE_MCP_URL=https://forge.example.com/mcp \
OPENFORGE_MCP_TOKEN=ofk_your_key_here \
node packages/mcp-server/dist/stdio-bridge.js
```

Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "openforge": {
      "command": "node",
      "args": ["/path/to/openforge/packages/mcp-server/dist/stdio-bridge.js"],
      "env": {
        "OPENFORGE_MCP_URL": "https://forge.example.com/mcp",
        "OPENFORGE_MCP_TOKEN": "ofk_your_key_here"
      }
    }
  }
}
```

## Legacy SSE

Older clients can use `GET /sse` (event stream) + `POST /messages`
(JSON-RPC). Same Bearer auth. Prefer Streamable HTTP for new setups.

## First tools to try

After connecting, ask your assistant to:

1. `get_instructions` — read the server's workflow guidance.
2. `list_apps` — see existing apps (scoped to the key's org).
3. `create_app` + `provision_database` + `apply_security_profile` —
   scaffold an app with a locked-down schema.
4. `write_file` + `deploy_frontend` — ship a frontend to staging.

Every tool call is validated against a JSON schema before it runs and
is written to the audit log. Denials (wrong org, forbidden field, bad
arguments) fail closed with an explanatory error — never silently.
