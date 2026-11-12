# Parity — Implementation Status per Surface

Honest status as of the latest commit. **No 100% parity claim is made.**
Every surface is marked implemented, partial, or gap. Gaps are explicit,
with a follow-up plan. "Verified" means exercised by the automated test
suite or the HTTP smoke walk on 2026-11-12 (see `VERIFICATION.md`).

Legend: ✅ implemented · ◐ partial · ❌ gap / not implemented.

## Pillar 1 — Universal MCP server (Apper-style)

| Surface | Status | Notes |
|---|---|---|
| Streamable HTTP transport (POST/GET/DELETE `/mcp`) | ✅ | Plain-JSON responses + SSE hold; sessions optional. Verified by tests + curl walk. |
| Legacy SSE transport (`/sse` + `/messages`) | ✅ | Verified by tests. |
| stdio bridge | ✅ | `packages/mcp-server/src/stdio-bridge.ts`; env token, never logged. |
| 18 deterministic tools | ✅ | `get_instructions`, `list_apps`, `create_app`, `provision_database`, `get_schema`, `configure_auth`, `apply_security_profile`, `setup_billing`, `list_files`, `read_file`, `write_file`, `run_build`, `get_preview`, `deploy_frontend`, `manage_secret`, `create_edge_function`, `list_functions`, `get_audit_log`. |
| Strict JSON-schema validation, deny-by-default | ✅ | Validation happens before handlers; audit on every call. |
| Per-tenant scoping | ✅ | Tools resolve the caller's org from the API key; cross-org access denied. |
| Audit log for MCP calls | ✅ | Every tool call audited. |
| Bearer API-key auth | ✅ | 401 before JSON-RPC dispatch. No anonymous mode. |
| OAuth 2.0 dynamic client registration | ❌ Gap | Not implemented. API-key auth is the supported path. Affects some ChatGPT flows. Follow-up: implement OAuth 2.1 + DCR behind a flag. |
| MCP prompts / resources / sampling | ❌ Gap | Capabilities advertise tools only. Follow-up: add read-only resources (schema, profiles) in a later release. |
| Live Claude / ChatGPT / Cursor client verification | ❌ Gap | Protocol verified over HTTP only; no live client was connected here. See `VERIFICATION.md`. |

## Pillar 2 — Self-hosted backend (Appwrite-style + Profile Lock)

| Surface | Status | Notes |
|---|---|---|
| Auth: email/password | ✅ | scrypt hashing, signed sessions, CSRF. |
| Auth: OAuth Google/GitHub | ◐ Partial | Real flow structure (auth URL, signed state, token + userinfo exchange, injectable fetch, tested with stub fetch). **Not verified against live providers.** |
| Databases: collections/attributes/indexes, CRUD | ✅ | Schema-validated CRUD; uniqueness via indexes. |
| Versioned REST `/api/v1/records` + scoped Bearer keys | ✅ | Alias route with `?app_id=`; scopes `*`, `records:read/write`, `files:read/write`. |
| Org/tenant isolation on every query | ✅ | Org predicate on every scoped query (Memory + Postgres); body can never choose org. Tested incl. cross-org reads. |
| Two-layer Profile Lock | ✅ | Tenant stamping + JSON profile whitelists, fail-closed, field-level + row conditions, system-field protection, 403/404 semantics. Tested. |
| Human-readable JSON profiles (Admin/Member/Guest + custom) | ✅ | Seeded defaults; Guest starts with no access; matrix UI in Studio. |
| Storage (buckets/files) | ✅ | JSON base64 upload/download/delete. No resumable uploads, no image transforms. |
| Functions (sandboxed runner) | ◐ Partial | `node:vm` sandbox with hardened context (null-prototype global, in-context invocation, blocked escapes — tested). **vm is a guardrail, not a proven boundary**; no network/fs/timers. Follow-up: worker threads with resource limits or isolated-vm. |
| Realtime | ◐ Partial | SSE hub implemented. **WebSocket is a gap** — follow-up: add a WS endpoint sharing the hub. |
| Stripe billing (plans, checkout, webhook, portal, metering) | ◐ Partial | Fetch client with injectable base URL; plans stored locally first; checkout refuses honestly without a key; webhook HMAC + idempotency tested with stubs. **Not verified against live Stripe.** |
| Outbound webhooks (3 PRD events) | ✅ | Signed envelopes, 5 retries with backoff, n8n/Zapier/Make-compatible payloads. In-process delivery only — a durable queue is a follow-up. |
| AES-256-GCM secrets vault | ✅ | scrypt-derived key, tested round-trip. Master key required in production (fail-closed). |
| Rate limiting + CSRF | ✅ | Fixed-window limiter + double-submit CSRF on cookie mutations. Tested. |
| Postgres adapter | ◐ Partial | Full adapter with parameterized SQL + org predicates; SQL builders unit-tested. **Live Postgres never run here** (no DB in this environment) — see `VERIFICATION.md`. |
| Messaging (email/SMS/push) | ❌ Gap | Appwrite has a Messaging service; the PRD does not require it. Outbound webhooks cover notifications. Follow-up only if requested. |
| Live Appwrite interop / Admin-SDK wrapper | ❌ Deliberate deviation | Not built. This is an original BaaS, not an Appwrite wrapper — single-compose deploy and clean-room constraints. Recorded, not hidden. |

## Pillar 3 — Browser Studio (Puter Builder-style)

| Surface | Status | Notes |
|---|---|---|
| Split-screen workspace (preview + inspector + matrix + keys) | ✅ | Studio, Data, Security, Ops views. |
| Live preview (sandboxed iframe) | ✅ | CSP `sandbox allow-scripts`, `connect-src 'none'`; inspector script injected. Serves latest deployment. |
| Click-to-select DOM inspection | ✅ | Hover highlight, element path/classes/text/rect, text edit applied live, serialized document save-back. `event.source` validation both ways. |
| Send-context-to-LLM | ✅ | Copies element context JSON to the clipboard for pasting into an AI assistant. No built-in chat — the MCP server is the AI interface. |
| Schema inspector | ✅ | Collections + attributes + record browser with typed forms. |
| Security-profile matrix | ✅ | Profiles × tables × operations with rule detail + JSON editor. |
| API-key manager | ✅ | Create (plaintext shown once), scopes, profiles, revoke. |
| Staging→production promotion | ✅ | Promote copies staging snapshot; old production is superseded. Production deploy refused without a profile with rules. |
| Custom domains + SSL via Caddy | ◐ Partial | Domain CRUD + generated Caddyfile; Caddy terminates TLS in compose. **Real DNS/SSL never verified here.** |
| GitHub 2-way sync | ✅ | Link, push, pull, conflict surfacing, status; safe `execFile` wrapper; token from vault, scrubbed from errors. Tested against local bare repos. |
| One-click Eject | ✅ | Standalone docker-compose bundle (Postgres + standalone API + frontend + data dump + README); TAR writer tested incl. `node --check` on generated server. **Bundle never built/run under Docker here.** |
| WebContainers (in-browser Node) | ❌ Deliberate deviation | Not implemented. Closest honest equivalent: sandboxed iframe preview + inspector bridge. Follow-up: evaluate WebContainers for in-browser builds. |
| AI chat panel in Studio | ❌ Gap | The PRD's AI surface is the MCP server (BYO-AI). A built-in chat would need a provider key in the Studio; not built. Follow-up if requested. |
| Version history UI | ◐ Partial | Deployments list shows snapshots; no per-file history UI. GitHub sync is the versioning path. |
| Preview apps calling the record API | ❌ Gap | Preview CSP blocks network calls by design. Follow-up: a preview proxy that injects a scoped, read-only key. |

## Cross-cutting

| Surface | Status | Notes |
|---|---|---|
| Single `docker-compose.yml` (2 vCPU / 4 GB) | ◐ Partial | Compose file + Caddyfile + Dockerfile + setup script written; YAML validated. **Never run under Docker here** (no daemon). |
| Design system (tokens, 3 themes × dark/light, showcase) | ✅ | Token file, Forge/Ember/Quench themes, persisted choice, showcase page, all states, reduced motion. |
| Original avatars (forge crew) | ✅ | Parametric SVG, 6 expressions, look editor, JSON packs (data only). |
| Tests | ✅ | 73 tests pass, 1 skipped (live Postgres). See `VERIFICATION.md` for exact counts. |
| Docs (inventory, parity, design, verification, security, MCP clients, eject, GitHub sync) | ✅ | In this repo. |

## Deliberate deviations (recorded, not hidden)

1. **No live Appwrite interop.** Original BaaS instead of an Appwrite wrapper.
2. **No WebContainers.** Sandboxed iframe + inspector bridge instead.
3. **No OAuth DCR on the MCP server.** API-key auth instead.
4. **No WebSocket realtime.** SSE instead.
5. **vm sandbox, not a proven boundary.** Documented limits + hardening follow-up.
