# Naming — Quinlo

> **Quinlo is the chosen name** (picked by Ashutosh, 2026-11-12). It
> replaces the working title "OpenForge", which was never cleared.
> No exact software product and no exact live trademark under "Quinlo"
> surfaced in the checks below. Get proper trademark clearance before
> any commercial trademark filing or public announcement.

## Deep check (2026-11-12, web search — not a legal clearance)

- **Trademarks:** no exact QUINLO mark surfaced in US (USPTO), EU
  (EUIPO), or India (IP India) searches. Nearest US marks are QUIN
  (registered, Classes 9/42 — Quin B.V. and Menthor Q LLC) and QUILO
  (published for opposition): same QUIN prefix, different word. Treat
  as the main residual caution.
- **Domains:** no live site at quinlo.com surfaced, but the domain
  looks registered/parked (Afternic nameservers) — a qualified domain
  will likely be needed. .ai/.app/.dev status was not verified; check
  at a registrar before buying.
- **GitHub:** no user, organization, or repository named `quinlo`
  surfaced. The repo will live under ASmad-AI as `quinlo`; availability
  is confirmed at creation time.
- **npm:** no `quinlo` package surfaced. Packages here are private;
  availability is confirmed at publish time, if ever published.
- **Other uses (unrelated fields):** "Quin.lo", a general-goods store
  on Shopee Philippines; a personal `quinlo` handle on CodePen;
  Quinlogic LLC (quinlogic.com, software consultancy, different name);
  Quilgo (online assessments, different name/field).

## Former working title: OpenForge (retired 2026-11-12)

"OpenForge" was NOT cleared for use and must not be presented as an
available name. Known collisions (checked 2026-11-12):

- **US trademark OPENFORGE, Reg. No. 5684232**, owned by Openforge LLC,
  Section 8 & 15 accepted 2025, covering software design/development
  services. Same field, live registration — the most serious collision.
- **India's government OpenForge platform** — a national code-hosting /
  collaboration platform by the Government of India.
- **github.com/openforge** — taken.
- **openforge-oss** and other uses of the name in open source.

Nothing was ever pushed or published under "OpenForge": no remote
existed at rename time, so no migration was needed.

## How the name is contained

The product name lives in exactly **one file**: `branding.json` at the
repo root. Every source file reads it through the `BRANDING` object
(server/shared/MCP) or a JSON import (Studio). The check
`npm run lint:branding` fails the build if the literal name appears in
any source file outside the allowed docs list.

## Rename record (completed 2026-11-12)

- `branding.json`: name Quinlo, slug `quinlo`, binary `quinlo`,
  config dir `.quinlo`, desktop id `com.quinlo.studio`, env prefix
  `QUINLO_`, default host `quinlo.local`, tagline "Build full-stack
  apps with the AI you already pay for.", `workingTitle: false`.
- Environment variables renamed `OPENFORGE_*` → `QUINLO_*` with no
  compatibility aliases: nothing was ever deployed or published, so
  no existing deployment can break. The stdio bridge reads
  `QUINLO_MCP_URL` / `QUINLO_MCP_TOKEN`.
- Package scope `@openforge/*` → `@quinlo/*`; API key prefix
  `ofk_` → `qlo_` (no keys were ever issued).
- Compose project, container, image, and volume names, `.env.example`,
  `Caddyfile`, and `scripts/setup.sh` updated.
- Local directory renamed `~/workspace/openforge/` →
  `~/workspace/quinlo/`. The reference-study clones remain under
  `~/workspace/research/openforge-study/` (historical artifact; see
  INVENTORY.md).

## Deliberately kept: the word "forge" inside the code

The generic English word "forge" still appears in internal identifiers
(`ForgeError`, the `forge_entities` table, the Forge/Ember/Quench
Studio themes, and the forge-crew avatars). These are a craft motif,
not the product brand, and were kept on purpose. Rename them only if
the product owner wants the word gone entirely.

## Rename checklist (for any future rename)

1. Pick the new name; run a fresh trademark/domain/GitHub check.
2. Update `branding.json`: `name`, `slug`, `binaryName`, `configDir`,
   `desktopId`, `envPrefix`, `defaultHost`, `tagline` if it references
   the old name.
3. Decide the environment-variable prefix: existing deployments use
   `QUINLO_*`. Either keep the prefix for compatibility (document
   it) or rename and ship a migration note. The stdio bridge reads
   `QUINLO_MCP_URL` / `QUINLO_MCP_TOKEN` — update or alias.
4. Update package names (`@quinlo/*` → new scope) and all import
   specifiers.
5. Update `docker-compose.yml`, `Dockerfile`, `Caddyfile`,
   `.env.example`, `scripts/setup.sh`.
6. Update docs (README.md, NAMING.md, INVENTORY.md, PARITY.md,
   DESIGN.md, VERIFICATION.md, SECURITY.md, NOTICE, `docs/*`).
7. Update the Studio favicon/title fallback and any user-facing copy
   that interpolates `BRANDING.name` (no code change needed — it flows
   from `branding.json`).
8. Run `npm run lint:branding`, `npm run build`, `npm test`.
9. Rename the git remote / repository when one is created. **No remote
   exists yet** — nothing has been pushed under this name.
