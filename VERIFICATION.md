# Verification

What was verified, how, and what remains outstanding. Nothing in the
"outstanding" section has been claimed as working anywhere in this repo.

## Verified here (2026-11-12)

Environment: Node v24.22.1, no Docker daemon, shared 1.5 CPU / ~6 GB
RAM. All commands run from the repo root.

### Automated tests

- `npm run build` — green: `tsc -b` for shared + MCP + server, web
  typecheck, esbuild bundle for Studio + CSS.
- `npm test` — **73 pass, 1 skipped, 0 fail** (74 total):
  - `packages/shared`: 27 (Profile Lock engine, vault crypto,
    validation, tenants).
  - `packages/mcp-server`: 8 (Streamable HTTP + legacy SSE, auth,
    validation, batch, parse errors).
  - `apps/server`: 38 pass + 1 skipped (API incl. profile denials and
    tenant isolation, billing, webhooks, functions incl. 12 sandbox
    escape payloads, GitHub sync against local bare repos, Postgres SQL
    builders, eject TAR round-trip + `node --check` on generated code,
    deploy/Caddyfile, rate limiter + CSRF, OAuth flow with stub fetch).
  - The 1 skipped test is the live-Postgres round-trip, which runs only
    when `DATABASE_URL` is set.
- `npm run lint:branding` — green: no hard-coded product name in source.
- `npm run verify:compose` — green: `docker-compose.yml` parses as
  valid YAML.

### HTTP smoke walk (running server, seeded demo data)

- Static serving: `/`, `/app.js`, `/styles.css` return 200; unknown
  paths fall back to the SPA shell.
- Auth: CSRF fetch → login → session cookie → `/api/v1/auth/me` →
  apps list, all over curl with a cookie jar.
- Schema, profiles, files endpoints return the seeded demo app data.
- Deploy to staging returns a deployment id; the preview URL serves the
  deployed HTML with `Content-Security-Policy: sandbox allow-scripts`
  and the injected inspector bridge.
- MCP over HTTP: unauthenticated request → 401; `initialize` handshake
  answers protocol `2025-06-18`; `tools/list` returns all 18 tools;
  `tools/call list_apps` returns the demo app; invalid tool arguments
  are rejected with schema errors before any handler runs.

### Security properties exercised by tests

- Profile Lock: forbidden field/row denied (403), single-row existence
  not leaked (404), system-field smuggling rejected, Member cannot read
  another member's rows under row conditions, cross-org reads miss.
- Tenant isolation: org A cannot read org B's apps, records, files, or
  profiles (store-level + API-level tests).
- Webhook signatures: Stripe HMAC verification (valid/tampered/expired),
  outbound signing verified by a capturing receiver.
- Sandbox escapes: 12 payloads (direct globals, `Function`, `eval`,
  prototype-chain escapes via `this`/`globalThis`/`__proto__`/`toString`)
  all blocked; infinite loops stopped by the vm timeout.
- Git: token never appears in error output; path escapes rejected.

## Outstanding — NOT verified here

Check each item in a real deployment before claiming it works:

- [ ] **Live Docker**: `docker compose up` on a 2 vCPU / 4 GB VPS;
  healthchecks; Caddy serving the Studio + previews; Postgres
  persistence across restarts; backups.
- [ ] **Live Postgres**: run the skipped test with `DATABASE_URL`;
  exercise the full API against Postgres (not just MemoryStore).
- [ ] **Live Stripe**: test-mode checkout session, webhook delivery
  from Stripe, portal session, plan sync. Current verification uses
  stubbed fetch only.
- [ ] **Live OAuth providers**: Google/GitHub sign-in end-to-end with
  real client credentials and redirect URIs.
- [ ] **Live MCP clients**: Claude Desktop, Claude Code, Cursor,
  ChatGPT MCP — connect with a real API key and run tools. Protocol
  verified over HTTP only.
- [ ] **Real SSL/DNS**: custom domain with DNS pointed at the server;
  Caddy automatic TLS issuance and renewal.
- [ ] **Live browser walk**: every Studio route in a real browser —
  console errors, overflow, focus order, contrast measurement,
  preview inspector interaction, reduced-motion behaviour. This
  environment has no live browser; the walk here was HTTP + built
  assets only.
- [ ] **Eject bundle under Docker**: extract the TAR, `docker compose
  up`, verify the standalone server + data import + frontend build.
- [ ] **GitHub sync against github.com**: link/push/pull with a real
  remote and token (local bare repos only here).
- [ ] **Load/latency**: MCP p95 < 500 ms and preview hot-reload
  < 1.5 s under the PRD's VPS sizing (no measurements taken here).

## How to re-verify

```sh
npm install
npm run build
npm test            # exact counts printed by node:test
npm run lint:branding
npm run verify:compose
QUINLO_MASTER_KEY=$(openssl rand -hex 32) \
QUINLO_SEED_DEMO=true npm start   # then walk http://localhost:3000
```
