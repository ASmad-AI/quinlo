# Security

Threat model, enforced controls, and known limits. This document
describes what the code actually does — not aspirations.

## Threat model

- **Untrusted AI-generated frontend code.** An AI assistant (or a
  malicious prompt) produces frontend code. It must never widen access:
  all authorization is enforced server-side, independent of frontend
  code. Profiles are data, never code — no expressions are evaluated.
- **Untrusted tenants.** Org A must never read or write org B's data,
  even with crafted requests, guessed ids, or a leaked API key scoped
  to another app.
- **Untrusted function code.** Edge functions are user-supplied
  JavaScript. They run sandboxed with no network, filesystem, timers,
  or host access (see limits below).
- **Untrusted preview content.** Deployed apps render in a sandboxed
  iframe that cannot reach the Studio's origin, cookies, DOM, or the
  network.
- **Credential theft.** API keys are stored only as hashes; the
  plaintext is shown once. Secrets are encrypted at rest. Session
  tokens are HMAC-signed; CSRF uses double-submit tokens.
- **Out of scope:** the host OS, the Postgres server, TLS termination
  (Caddy), and the operator's own credentials. Physical access to the
  VPS or the master key defeats the vault by design.

## Controls

### Profile Lock (two layers, every request)

1. **Tenant layer.** Every row carries `org_id`. The query layer stamps
   the caller's org on writes and constrains every read/update/delete
   to it. Request bodies can never choose an org. A single global app
   lookup exists only for the Stripe webhook entrypoint, gated by HMAC
   signature verification; a single email lookup exists only for
   login/signup.
2. **Profile layer.** Human-readable JSON whitelists per profile, per
   table: operations, fields, and row conditions (`eq`/`ne`/`in`/
   `not_in`/`exists`/`is_null` with `$user.id`, `$org.id`,
   `$user.email`). Fail-closed: no rule means deny. Unknown fields are
   stripped from responses and rejected on writes. System fields
   (`id`, `org_id`, `created_at`, `updated_at`, `created_by`) are never
   writable; smuggling them returns 403. Admin with empty rules expands
   to full access for known tables only; explicit Admin rules are not
   expanded. Row-condition failure on a single-row read/update/delete
   returns 404 (no existence leak); operation denial returns 403.

### Authentication & sessions

- Passwords: scrypt. Sessions: HMAC-SHA256 signed tokens in
  `HttpOnly`, `SameSite=Lax` cookies (`Secure` when the base URL is
  https). API keys: `ofk_…` prefix, SHA-256 hash stored, scopes
  enforced (`*`, `records:read/write`, `files:read/write`), revocable,
  last-used tracking.
- CSRF: double-submit token (`of_csrf` cookie + `x-csrf-token`
  header) on cookie-authenticated mutations. Bearer-key requests and
  the Stripe webhook (HMAC) are exempt by design.
- Rate limiting: fixed-window per IP/key on auth and API routes.
- OAuth: state tokens are signed with expiry; authorization codes are
  exchanged server-side; provider profiles are fetched with an
  injectable HTTP client. No tokens are stored in the browser.

### Secrets vault

AES-256-GCM with a scrypt-derived key from `OPENFORGE_MASTER_KEY`.
The server refuses to start in production mode without a master key
(fail-closed). Ciphertext format is versioned (`v1$…`). Secret values
are never returned by any API — only names.

### Webhooks

- Inbound (Stripe): HMAC-SHA256 signature verification with timestamp
  tolerance (300 s), raw-body verification, idempotency via a seen-set.
- Outbound: envelopes signed `sha256=<hmac>` with a per-endpoint
  secret; 5 retries with backoff (1s/5s/15s/60s/300s); only `http(s)`
  URLs; non-local URLs rejected in tests/dev to avoid SSRF during
  development (production allows public HTTPS receivers).

### GitHub sync

Git runs via `execFile` with an argv array — no shell. Project file
paths are scoped (no `..` escapes). The token is passed via
`http.extraHeader`, never on the command line, and is scrubbed from
error output. Trade-off, documented honestly: the token is visible in
the process's memory/environment to the same OS user while git runs,
and in the git process list only if the header mechanism is bypassed —
it is not written to disk or logs. Local (`file://`) remotes are
allowed only when `OPENFORGE_ALLOW_LOCAL_GIT_REMOTES=true`.

### Preview sandbox

Preview responses carry
`Content-Security-Policy: sandbox allow-scripts; connect-src 'none'`.
The inspector bridge only talks to its parent frame (verified via
`event.source`), only inside an iframe, and only after an explicit arm
message. The Studio validates `event.source` against the preview
iframe's `contentWindow` before trusting any message. Preview code
cannot call the record API, read cookies, or reach the Studio DOM.

### Edge-function sandbox

`node:vm` with code generation from strings disabled, a null-prototype
sandbox object (so no prototype chain reaches host intrinsics), input
JSON-round-tripped through the boundary, a closure-hidden log bridge,
strict-mode invocation inside the context (so the vm CPU timeout stops
infinite loops), and an outer race for async hangs. Twelve escape
payloads are tested and blocked.

## Known limits (do not overstate)

1. **`node:vm` is a guardrail, not a proven security boundary.**
   Determined code can in principle escape a vm context. Do not run
   untrusted functions on infrastructure where an escape would be
   catastrophic. Hardening follow-up: worker threads with resource
   limits, or isolated-vm.
2. **Microtask-starvation loops** (`while (true) { await
   Promise.resolve(); }`) can still starve the host event loop; the vm
   timeout covers synchronous execution and the outer race covers
   ordinary async hangs.
3. **Outbound webhook delivery is in-process.** A restart loses
   in-flight retries. A durable queue is a follow-up.
4. **No WebSocket realtime yet** — SSE only. The realtime hub enforces
   org scoping on every subscription.
5. **No OAuth DCR on the MCP server** — API-key auth only. Keys must be
   treated as secrets and rotated if exposed.
6. **The demo seed** (`OPENFORGE_SEED_DEMO=true`) creates a known
   demo account. Never enable it in production; the default demo
   password is documented in `.env.example` and is only suitable for
   local throwaway use.

## Reporting

This project has no public security contact yet. Until one is named,
report issues privately to the repository owner. Do not open public
issues with exploit details.
