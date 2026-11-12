import { randomBytes, timingSafeEqual } from "node:crypto";
import { ForgeError } from "@openforge/shared";
import type { ReqCtx } from "./http";

/* ------------------------------------------------------------------ */
/* Rate limiting: fixed-window counter per key (IP + route family).    */
/* In-memory; single-node semantics documented in SECURITY.md.         */
/* ------------------------------------------------------------------ */

export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (bucket.count >= this.max) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now };
    }
    bucket.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Drop expired buckets so the map cannot grow unboundedly. */
  prune(now = Date.now()): number {
    let removed = 0;
    for (const [key, b] of this.buckets) {
      if (now >= b.resetAt) {
        this.buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }
}

/* ------------------------------------------------------------------ */
/* CSRF: double-submit cookie + header, constant-time comparison.      */
/* Applies to cookie-authenticated state-changing requests. Bearer    */
/* API-key requests are exempt (no ambient credentials), as are       */
/* signature-verified webhooks and safe methods.                       */
/* ------------------------------------------------------------------ */

export const CSRF_COOKIE = "of_csrf";
export const CSRF_HEADER = "x-csrf-token";

export function newCsrfToken(): string {
  return randomBytes(24).toString("base64url");
}

export function csrfTokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requiresCsrf(ctx: ReqCtx): boolean {
  if (SAFE_METHODS.has(ctx.method)) return false;
  // Stripe webhook: verified by HMAC signature instead.
  if (ctx.path.startsWith("/api/v1/webhooks/stripe/")) return false;
  // MCP transports: Bearer-only, no cookies.
  if (ctx.path === "/mcp" || ctx.path === "/sse" || ctx.path === "/messages") return false;
  // Bearer API-key auth: no ambient credential to forge.
  const auth = ctx.req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return false;
  return true;
}

export function assertCsrf(ctx: ReqCtx): void {
  if (!requiresCsrf(ctx)) return;
  const cookie = ctx.cookies[CSRF_COOKIE];
  const header = ctx.req.headers[CSRF_HEADER];
  if (
    !cookie ||
    typeof header !== "string" ||
    header.length === 0 ||
    !csrfTokensEqual(cookie, header)
  ) {
    throw new ForgeError("forbidden", "CSRF token missing or invalid", 403);
  }
}
