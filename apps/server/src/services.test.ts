import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generateCaddyfile, promoteToProduction, deploySnapshot, previewUrl } from "./deploy";
import { MemoryStore } from "./store";
import { RateLimiter, requiresCsrf, csrfTokensEqual, newCsrfToken } from "./security";
import type { ReqCtx } from "./http";
import {
  buildAuthorizationUrl,
  exchangeCodeForProfile,
  OAUTH_ENDPOINTS,
  signOAuthState,
  verifyOAuthState,
  type OAuthProviderConfig,
} from "./auth";

describe("deploy + Caddyfile", () => {
  test("promotion copies staging to production and supersedes the old live deploy", async () => {
    const store = new MemoryStore();
    await deploySnapshot(store, "org_1", "app_1", "production", [{ content: "old", path: "index.html" }]);
    await deploySnapshot(store, "org_1", "app_1", "staging", [{ content: "new", path: "index.html" }]);
    const promoted = await promoteToProduction(store, "org_1", "app_1");
    assert.equal(promoted.environment, "production");
    assert.equal(promoted.files[0].content, "new");
    assert.ok(promoted.promoted_from);
    const live = await store.getDeployment("org_1", "app_1", "production");
    assert.equal(live?.id, promoted.id);
    const all = await store.listDeployments("org_1", "app_1");
    assert.equal(all.filter((d) => d.environment === "production" && d.status === "superseded").length, 1);
    assert.equal(previewUrl("https://example.com/", "app_1", "staging"), "https://example.com/preview/app_1/staging/");
  });

  test("promotion with empty staging is refused", async () => {
    const store = new MemoryStore();
    await assert.rejects(() => promoteToProduction(store, "org_1", "app_1"), /Nothing in staging/);
  });

  test("Caddyfile generation: one block per domain, sorted, with hardening headers", () => {
    const text = generateCaddyfile(
      [
        { app_id: "app_1", created_at: "", environment: "production", hostname: "zeta.example.com", id: "d1", org_id: "org_1", status: "active" },
        { app_id: "app_1", created_at: "", environment: "staging", hostname: "alpha.example.com", id: "d2", org_id: "org_1", status: "active" },
      ],
      { production: "localhost:3000", staging: "localhost:3000" },
    );
    assert.ok(text.indexOf("alpha.example.com") < text.indexOf("zeta.example.com"), "sorted by hostname");
    assert.ok(text.includes("reverse_proxy localhost:3000"));
    assert.ok(text.includes("X-Content-Type-Options nosniff"));
    assert.ok(generateCaddyfile([], { production: "x", staging: "x" }).includes("No custom domains"));
  });
});

describe("rate limiter + CSRF", () => {
  test("fixed window allows max requests then blocks until reset", () => {
    const limiter = new RateLimiter(3, 1000);
    assert.equal(limiter.check("k", 0).allowed, true);
    assert.equal(limiter.check("k", 10).allowed, true);
    assert.equal(limiter.check("k", 20).allowed, true);
    const blocked = limiter.check("k", 30);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0);
    assert.equal(limiter.check("k", 1001).allowed, true, "new window allows again");
    assert.equal(limiter.check("other", 30).allowed, true, "different key unaffected");
    // "other" window (30..1030) expired at 2000; "k" window (1001..2001) not yet.
    assert.equal(limiter.prune(2000), 1);
    assert.equal(limiter.prune(2002), 1);
  });

  test("CSRF tokens compare in constant time and rotate safely", () => {
    const a = newCsrfToken();
    assert.equal(csrfTokensEqual(a, a), true);
    assert.equal(csrfTokensEqual(a, `${a}x`), false);
    assert.equal(csrfTokensEqual(a, newCsrfToken()), false);
  });

  function fakeCtx(method: string, path: string, headers: Record<string, string> = {}): ReqCtx {
    return {
      body: undefined,
      cookies: {},
      ip: "127.0.0.1",
      method,
      params: {},
      path,
      query: new URLSearchParams(),
      rawBody: Buffer.alloc(0),
      req: { headers } as never,
      res: {} as never,
    };
  }

  test("requiresCsrf matrix", () => {
    assert.equal(requiresCsrf(fakeCtx("GET", "/api/v1/apps")), false);
    assert.equal(requiresCsrf(fakeCtx("POST", "/api/v1/apps")), true);
    assert.equal(requiresCsrf(fakeCtx("POST", "/api/v1/apps", { authorization: "Bearer ofk_x" })), false);
    assert.equal(requiresCsrf(fakeCtx("POST", "/api/v1/webhooks/stripe/app_1")), false);
    assert.equal(requiresCsrf(fakeCtx("POST", "/mcp")), false);
    assert.equal(requiresCsrf(fakeCtx("DELETE", "/api/v1/apps/a")), true);
  });
});

describe("OAuth flow structure", () => {
  const cfg: OAuthProviderConfig = {
    ...OAUTH_ENDPOINTS.google,
    clientId: "cid",
    clientSecret: "csecret",
  };

  test("authorization URL carries client, redirect, scope, and state", () => {
    const url = new URL(buildAuthorizationUrl("google", cfg, "state123", "https://app.example.com/callback"));
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("client_id"), "cid");
    assert.equal(url.searchParams.get("redirect_uri"), "https://app.example.com/callback");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("scope"), "openid email profile");
    assert.equal(url.searchParams.get("state"), "state123");
  });

  test("state tokens round-trip, reject tampering and expiry", () => {
    const token = signOAuthState({ appId: "app_1", nonce: "n", provider: "github", returnTo: "/studio" }, "secret", 600);
    const parsed = verifyOAuthState(token, "secret");
    assert.equal(parsed?.provider, "github");
    assert.equal(parsed?.appId, "app_1");
    assert.equal(verifyOAuthState(`${token}x`, "secret"), null);
    assert.equal(verifyOAuthState(token, "other"), null);
    const expired = signOAuthState({ appId: "a", nonce: "n", provider: "google", returnTo: "/" }, "secret", -10);
    assert.equal(verifyOAuthState(expired, "secret"), null);
  });

  test("code exchange uses the token + userinfo endpoints (stub fetch)", async () => {
    const calls: string[] = [];
    const stubFetch = async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.includes("oauth2.googleapis.com/token")) {
        assert.equal(init?.method, "POST");
        return new Response(JSON.stringify({ access_token: "tok_1" }), { status: 200 });
      }
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer tok_1");
      return new Response(JSON.stringify({ email: "User@Example.com", name: "User", sub: "google_1" }), { status: 200 });
    };
    const profile = await exchangeCodeForProfile("google", cfg, "code_1", "https://app/cb", stubFetch as never);
    assert.deepEqual(profile, { email: "user@example.com", name: "User", sub: "google_1" });
    assert.equal(calls.length, 2);

    const failing = async () => new Response("nope", { status: 400 });
    await assert.rejects(
      () => exchangeCodeForProfile("google", cfg, "code_1", "https://app/cb", failing as never),
      /token exchange failed/,
    );
  });
});
