# Quinlo

> **Naming:** Quinlo was chosen on 2026-11-12 after a trademark, domain,
> GitHub, and npm check found no exact software product or live
> trademark under this name in the US, EU, or India. See `NAMING.md`
> for the full findings and remaining cautions, and get proper
> trademark clearance before any commercial filing. The name lives in
> one file (`branding.json`).

A self-hostable **AI App Factory**: bring your own AI subscription,
build full-stack SaaS apps through MCP, lock them down with readable
security profiles, and own the code — with zero AI-credit markup.

Clean-room original code, inspired by Appwrite (self-hosted BaaS),
Puter Builder (browser AI builder), and Apper (universal MCP +
deterministic permissions). No code, assets, or copy was taken from
any of them. See `INVENTORY.md` and `NOTICE`.

## The three pillars

1. **Universal MCP server** — Streamable HTTP (`/mcp`) + legacy SSE
   (`/sse`) + stdio bridge. 18 deterministic, schema-validated tools:
   provision databases, configure auth, apply security profiles, set up
   billing, deploy frontends, manage files, secrets, and functions.
   Per-tenant scoped, deny-by-default, fully audited.
2. **Self-hosted backend** — Auth, databases, storage, sandboxed
   functions, realtime over SSE, Stripe billing, signed outbound
   webhooks, AES-256-GCM secrets vault. Every query is org-scoped, and
   the two-layer **Profile Lock** engine enforces human-readable JSON
   profiles (Admin/Member/Guest + custom) server-side on every request.
3. **Browser Studio** — Split-screen workspace: live sandboxed preview
   with click-to-select inspection, schema inspector, security-profile
   matrix, API-key manager, staging→production promotion, custom
   domains with Caddy, 2-way GitHub sync, and one-click **Eject** to a
   standalone docker-compose bundle you own outright.

## Quickstart

```sh
cp .env.example .env
# Edit .env: set QUINLO_MASTER_KEY (required) and a demo password if seeding.
./scripts/setup.sh        # installs deps, builds, validates compose YAML
docker compose up -d      # server + Postgres + Caddy (needs Docker; not verified in CI here)
```

Local development without Docker:

```sh
npm install
npm run build
QUINLO_MASTER_KEY=$(openssl rand -hex 32) QUINLO_SEED_DEMO=true npm start
# Studio: http://localhost:3000  ·  Demo: demo@quinlo.local / demo-password-123
# MCP:    http://localhost:3000/mcp (Bearer API key from any app's Security tab)
```

## Connect your AI assistant

Point any MCP client at `<your-base-url>/mcp` with
`Authorization: Bearer <API_KEY>`. Create keys in the Studio
(Security → API keys). Honest per-client notes — including which
clients need the stdio bridge and that OAuth dynamic client
registration is not implemented — are in `docs/mcp-clients.md`.

## Repository layout

```
apps/server/        Backend: REST API, Profile Lock, MCP dispatch, preview, eject
apps/web/           Studio frontend (vanilla TS + esbuild, token design system)
packages/shared/    Branding, ids, validation, crypto, profiles, tenants, audit
packages/mcp-server MCP protocol, 18 tools, transports, stdio bridge
scripts/            Build + branding lint + setup
docs/               MCP clients, eject, GitHub sync
branding.json       Single source of truth for product identity
```

## Status — read before relying on it

- **Tests:** 73 pass, 1 skipped (live Postgres), 0 fail. See
  `VERIFICATION.md` for exactly what was verified and what was not.
- **Not verified here:** live Docker, live Postgres, live Stripe, live
  OAuth providers, live Claude/ChatGPT/Cursor MCP clients, real
  SSL/DNS, live browser walk, eject bundle under Docker. Each is a
  checklist item in `VERIFICATION.md`.
- **Known gaps** (explicit, with follow-ups): no OAuth DCR, no
  WebSocket realtime, no WebContainers, vm sandbox limits, preview
  apps cannot call the record API. See `PARITY.md`.
- **License:** the PRD listed "Apache 2.0 / AGPL-3.0" ambiguously.
  Apache-2.0 was chosen for this original code because no AGPL code
  was copied (Appwrite is BSD-3-Clause, Builder is Apache-2.0, and
  both were inspirations only). **The final license choice still needs
  the product owner's confirmation.**

## Docs

- `INVENTORY.md` — what was studied, SHAs, licenses, Apper verifiable-vs-inferred split
- `PARITY.md` — per-surface implementation status with explicit gaps
- `DESIGN.md` — design brief, system, surface-by-surface comparison
- `VERIFICATION.md` — verified vs outstanding checklist
- `SECURITY.md` — threat model, controls, known limits
- `NAMING.md` — collision warning + rename checklist
- `docs/mcp-clients.md` — per-client MCP setup, honest support matrix
- `docs/eject.md` — eject bundle contents and how to run it standalone
- `docs/github-sync.md` — 2-way sync behaviour, conflicts, token handling
