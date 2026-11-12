# Inventory — Reference Products Studied

This repository is a **clean-room re-implementation**. The products below
were studied for structure and behaviour only. **No code, assets, logos,
mascots, or copy were copied from any of them.** All code in this repo is
original, written from the PRD and from public documentation. See `NOTICE`
for attribution and `PARITY.md` for what was implemented.

Checked 2026-11-12. Shallow (`--depth 1`, blobless sparse) clones live
outside this repo under `~/workspace/research/openforge-study/` and are
not part of this codebase.

## 1. Appwrite — `github.com/appwrite/appwrite`

| Fact | Value |
|---|---|
| HEAD studied | `7355b630f1a8b974dab5a5aca105e35e9649962f` |
| License | BSD-3-Clause (Copyright 2019 Appwrite, `LICENSE`) |
| Language / stack | PHP backend; Console web app; Docker Compose with Traefik |
| Default database | PostgreSQL for new installs (older installs used MariaDB) |

Surfaces observed (README + repo layout):

- **Auth** — email/password, OAuth providers, sessions, teams, JWT.
- **Databases** — collections, attributes, indexes, documents, queries,
  relationships, row-level permissions.
- **Storage** — buckets, files, previews, antivirus scanning hooks.
- **Functions** — runtimes, triggers (event/HTTP/schedule), executions,
  variables.
- **Messaging** — email/SMS/push providers, topics, targets.
- **Realtime** — WebSocket subscriptions to database/auth/storage events.
- **Hosting** — static site deployments, custom domains, frameworks.
- **Console** — the web admin UI: projects, API keys, usage, settings.
- **MCP / agent-first positioning** — the README presents Appwrite as
  usable from AI agents via MCP and SDKs.
- Workers: many background workers (`app/workers`), event system, audit
  logs, abuse/rate-limit controls.

What was taken from Appwrite: the *shape* of a self-hosted BaaS
(collections/attributes/indexes, buckets, functions, realtime, hosting,
console navigation) and the decision to default to PostgreSQL. Nothing
else. This repo does not wrap, embed, or interoperate with Appwrite.

## 2. Puter — `github.com/HeyPuter/puter`

| Fact | Value |
|---|---|
| HEAD studied | `33988ac84c5e92fe7578885d6d195c3ddded1303` |
| License | AGPL-3.0 core (`LICENSE.txt`); `src/puter-js/APACHE_LICENSE.txt` (SDK Apache-2.0) |
| Language / stack | Node.js backend, web desktop GUI, Caddy, Docker Compose (MariaDB, Valkey, DynamoDB-local, RustFS S3, Caddy) |
| Self-host status | **Alpha** (per project docs) |

Layout observed: `src/{backend,cli,dev-center,docs,gui,mcp-connector,
puter-js,worker-types,worker}`, `extensions/`.

Surfaces observed:

- **Internet OS desktop** — windowed GUI, apps, filesystem, terminal.
- **puter.js SDK** — browser SDK for auth, filesystem, key-value, AI.
- **Hosting / publishing** — deploy sites from the desktop/CLI.
- **MCP connector** — bridging MCP clients to Puter services.
- **Dev Center** — app management for developers.

What was taken from Puter: the *idea* of browser-native hosting plus an
SDK-style developer surface, and the Puter Builder workflow (below).
**No AGPL code was read for reuse and none was copied.** The AGPL
license is the reason this repo's backend is an original
implementation, not a fork or adaptation.

## 3. Puter Builder — `github.com/HeyPuter/builder`

| Fact | Value |
|---|---|
| HEAD studied | `ba262caa8e530973c1f622d581c802be8de0cbd5` |
| License | Apache-2.0 (`LICENSE`) |
| Language / stack | Vite + vanilla JS |

Layout observed: `src/{content,css,editor,js,mcp,templates,tools}`,
an extensive `scripts/test-*.mjs` suite.

Surfaces observed (behaviour reference only):

- AI chat that builds apps from prompts; live preview; click-to-edit.
- Version history; MCP connections panel; GitHub sync; publish flow;
  custom domains; PWA support; voice input.

What was taken from Builder: the *workflow shape* of the Studio —
prompt/chat-driven building, live preview, click-to-select editing,
version history, GitHub sync, publish/promote. The Studio in this repo
is original code with an original UI; no Builder code, styles, or
templates were copied.

## 4. Apper — proprietary backend, public MCP docs

| Fact | Value |
|---|---|
| MCP repo | `github.com/apperhq/apper-mcp` — **not publicly clonable**: `git ls-remote` fails with an auth prompt (verified 2026-11-12, re-verified the same day). No auth bypass was attempted. |
| Remote MCP | `https://mcp.apper.io/v1.1/connect` (Streamable HTTP + OAuth 2.0) |
| Registry | MCP Registry entry `io.github.apperhq/apper-mcp` |
| Docs | `apper.io/learn/docs/mcp/*` (public), Glama listing |

### Publicly verifiable (from public docs/listings)

- Remote MCP server with Streamable HTTP transport and OAuth 2.0.
- Tools covering apps, files, builds, previews, schema/RLS, edge
  functions, and secrets.
- Two-lock / two-level security model; profiles (e.g. Admin / Manager /
  User); tenant isolation; audit logs.
- Custom domains; edge functions; integrations with Zapier / Make / n8n
  / Integrately / Pabbly (outbound webhook style).
- BYO-AI: the user's own AI subscription drives building through MCP.

### Inferred from the PRD only (NOT independently verified)

- Exact tool names beyond the PRD's list (`provision_database`,
  `configure_auth`, `apply_security_profile`, `setup_billing`,
  `deploy_frontend`).
- Exact profile rule JSON shape, webhook event names, and the
  staging→production promotion flow details.
- Any backend implementation detail: Apper's backend is proprietary and
  was not available for study. All such behaviour in this repo is an
  original implementation of the PRD's description.

## What this repo is

An original TypeScript implementation of the PRD's three pillars:

1. A universal MCP server (Streamable HTTP + legacy SSE + stdio bridge)
   with deterministic, schema-validated tools.
2. A self-hosted backend (auth, databases, storage, functions, realtime
   over SSE, billing, webhooks, secrets vault) with a two-layer
   Profile Lock engine enforced server-side.
3. A browser Studio (split-screen preview + schema inspector + profile
   matrix + API-key manager, click-to-select editing, GitHub sync,
   one-click eject).

See `PARITY.md` for the honest per-surface implementation status.
