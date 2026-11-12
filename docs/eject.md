# Eject — Own Your App Outright

Eject exports a running app as a **standalone bundle** that does not
depend on this platform. Download it from the Studio (Ops → Deploy &
GitHub → Eject) or `POST /api/v1/apps/:appId/eject` (admin only). The
response is a `.tar` archive.

## Bundle contents

```
docker-compose.yml     Postgres 16 + the standalone API server
Dockerfile             Node 20 image for the standalone server
.env.example           DATABASE_URL, PORT, session secret placeholders
server/
  package.json         No dependencies beyond `pg` (standalone server)
  server.mjs           Standalone API: auth + org-scoped records +
                       profile enforcement + static frontend serving
  import.mjs           One-shot data import (schema, profiles, records)
  schema.json          Collection schemas
  profiles.json        Security profiles (same JSON rule language)
  records.jsonl        One JSON record per line, per collection
  billing-plans.json   Billing plans (reference data)
frontend/              Your project files, or a minimal Vite + React
                       scaffold when the project has no files
README.md              How to run the ejected app
.gitignore
```

The standalone server is generated dependency-light on purpose: it
re-implements the record API surface (auth, org scoping, profile
enforcement) in a single file with no platform imports, so the bundle
keeps working even if this platform disappears.

## Running the ejected app

```sh
tar -xf my-app-eject.tar
cd my-app-eject
cp .env.example .env   # set DATABASE_URL + secrets
docker compose up -d   # starts Postgres + API server
node server/import.mjs # imports schema, profiles, and records once
```

Then open the printed URL. The frontend is served from `frontend/` by
the standalone server; rebuild it with `npm run build` inside
`frontend/` when using the React scaffold.

## What eject does NOT include

- The Studio, the MCP server, GitHub sync, or the functions runner.
  Eject exports the *app*, not the factory.
- Secrets: vault values are never exported. Re-enter provider keys in
  the ejected `.env`.
- Stripe state: plans are exported as data; Stripe objects (products,
  prices, subscriptions) live in your Stripe account and are referenced
  by id.
- Webhook endpoints and delivery history: re-create receivers against
  the ejected server's events if you need them.

## Verification status

The bundle contents, TAR round-trip, and `node --check` on the
generated server are covered by automated tests. The bundle has **not**
been run under Docker in this environment (no daemon) — see
`VERIFICATION.md`.
