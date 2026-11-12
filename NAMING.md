# Naming — Collision Warning

> **The working title "OpenForge" is NOT cleared for use.** Do not
> present it as an available name. A rename is likely before any public
> release or push. The final name is Ashutosh's decision — no
> alternative is proposed here.

## Known collisions (checked 2026-11-12)

- **US trademark OPENFORGE, Reg. No. 5684232**, owned by Openforge LLC,
  Section 8 & 15 accepted 2025, covering software design/development
  services. This is the most serious collision: same field, live
  registration.
- **India's government OpenForge platform** — a national code-hosting /
  collaboration platform by the Government of India.
- **github.com/openforge** — taken.
- **openforge-oss** and other uses of the name in open source.

Get proper trademark clearance before any commercial filing or public
announcement under any name.

## How the name is contained

The product name lives in exactly **one file**: `branding.json` at the
repo root. Every source file reads it through the `BRANDING` object
(server/shared/MCP) or a JSON import (Studio). The check
`npm run lint:branding` fails the build if the literal name appears in
any source file outside the allowed docs list.

Places the name legitimately appears and must be updated on rename:

- `branding.json` (single source of truth)
- Docs: `README.md`, `NAMING.md`, `INVENTORY.md`, `PARITY.md`,
  `DESIGN.md`, `VERIFICATION.md`, `SECURITY.md`, `NOTICE`, `docs/*`
- `package.json` files (`name` fields) — allowed by the lint, but
  update for consistency
- `.env.example` comments, `docker-compose.yml` service/container names
- `Caddyfile` comments

## Rename checklist

1. Pick the new name; run a fresh trademark/domain/GitHub check.
2. Update `branding.json`: `name`, `slug`, `binaryName`, `configDir`,
   `desktopId`, `envPrefix`, `defaultHost`, `tagline` if it references
   the old name.
3. Decide the environment-variable prefix: existing deployments use
   `OPENFORGE_*`. Either keep the prefix for compatibility (document
   it) or rename and ship a migration note. The stdio bridge reads
   `OPENFORGE_MCP_URL` / `OPENFORGE_MCP_TOKEN` — update or alias.
4. Update package names (`@openforge/*` → new scope) and all import
   specifiers.
5. Update `docker-compose.yml`, `Dockerfile`, `Caddyfile`,
   `.env.example`, `scripts/setup.sh`.
6. Update docs (list above) and the `NOTICE` file.
7. Update the Studio favicon/title fallback and any user-facing copy
   that interpolates `BRANDING.name` (no code change needed — it flows
   from `branding.json`).
8. Run `npm run lint:branding`, `npm run build`, `npm test`.
9. Rename the git remote / repository when one is created. **No remote
   exists yet** — nothing has been pushed under this name.
