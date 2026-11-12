import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { createMcpHttpHandler, type McpHttpHandler } from "@openforge/mcp-server";
import {
  auditEvent,
  BRANDING,
  defaultProfiles,
  ForgeError,
  isValidCollectionName,
  newId,
  slugify,
  validateProfile,
  type AuditAction,
} from "@openforge/shared";
import {
  AuthService,
  buildAuthorizationUrl,
  createApiKeyRecord,
  exchangeCodeForProfile,
  hashToken,
  OAUTH_ENDPOINTS,
  oauthRedirectUri,
  scopeAllows,
  SESSION_COOKIE,
  signOAuthState,
  toPublicApiKey,
  toPublicUser,
  verifyOAuthState,
  type FetchFn as OAuthFetch,
  type OAuthProvider,
  type OAuthProviderConfig,
} from "./auth";
import { BillingService, type FetchFn as BillingFetch } from "./billing";
import type { ServerConfig } from "./config";
import { deploySnapshot, generateCaddyfile, promoteToProduction, previewUrl } from "./deploy";
import { buildEjectBundle, writeTar } from "./eject";
import { runFunctionCode } from "./functions";
import { GithubSyncService, scopePath } from "./github";
import {
  clientIp,
  created,
  noContent,
  ok,
  parseCookies,
  parseJsonBody,
  raw,
  readBody,
  redirect,
  Router,
  sendError,
  sendResult,
  serializeCookie,
  type HandlerResult,
  type Principal,
  type ReqCtx,
} from "./http";
import { injectInspector, PREVIEW_CSP } from "./preview";
import { RealtimeHub } from "./realtime";
import { RecordService, type EventSink } from "./records";
import { assertCsrf, CSRF_COOKIE, CSRF_HEADER, newCsrfToken, RateLimiter } from "./security";
import { seedDemo } from "./seed";
import { ServerPlatformPort } from "./platformPort";
import { MemoryStore, type App, type Store, type StoredRecord } from "./store";
import { VaultService } from "./vault";
import { WebhookService, type FetchFn as WebhookFetch } from "./webhooks";

export interface ServiceOverrides {
  billingFetch?: BillingFetch;
  oauthFetch?: OAuthFetch;
  store?: Store;
  webhookFetch?: WebhookFetch;
  webhookRetryDelay?: (ms: number) => Promise<void>;
}

export interface Services {
  auth: AuthService;
  billing: BillingService;
  config: ServerConfig;
  github: GithubSyncService;
  mcp: McpHttpHandler;
  rateLimiter: RateLimiter;
  realtime: RealtimeHub;
  records: RecordService;
  router: Router;
  store: Store;
  vault: VaultService;
  webhooks: WebhookService;
}

async function audit(
  store: Store,
  event: {
    action: AuditAction;
    actorId: string;
    actorType: "api_key" | "mcp" | "system" | "user";
    appId?: string;
    detail?: Record<string, unknown>;
    orgId: string;
  },
): Promise<void> {
  await store.appendAudit(auditEvent(event));
}

export function createServices(config: ServerConfig, overrides: ServiceOverrides = {}): Services {
  const store = overrides.store ?? new MemoryStore();
  const auth = new AuthService(store, config);
  const vault = new VaultService(store, config.masterKey);
  const realtime = new RealtimeHub();
  const webhooks = new WebhookService(store, overrides.webhookFetch, overrides.webhookRetryDelay);

  const eventSink: EventSink = {
    audit: (e) => audit(store, { ...e, action: e.action as AuditAction }),
    publish: (orgId, appId, event) => {
      realtime.publish(orgId, appId, event);
    },
    webhook: (event, app, payload) => webhooks.dispatch(event, app, payload),
  };
  const records = new RecordService(store, auth, eventSink);
  const billing = new BillingService(store, vault, config, {
    audit: (e) => audit(store, { ...e, action: e.action as AuditAction }),
    webhook: (event, app, payload) => webhooks.dispatch(event, app, payload),
  }, overrides.billingFetch);
  const github = new GithubSyncService(
    store,
    vault,
    config.dataDir,
    process.env.OPENFORGE_ALLOW_LOCAL_GIT_REMOTES === "true",
  );
  const platformPort = new ServerPlatformPort({ billing, config, store, vault, webhooks });
  const mcp = createMcpHttpHandler({
    port: platformPort,
    ssePath: BRANDING.mcpLegacySsePath,
    streamablePath: BRANDING.mcpPath,
  });
  const rateLimiter = new RateLimiter(config.rateLimitMax, config.rateLimitWindowMs);

  const services: Services = {
    auth,
    billing,
    config,
    github,
    mcp,
    rateLimiter,
    realtime,
    records,
    router: new Router(),
    store,
    vault,
    webhooks,
  };
  registerRoutes(services, overrides);
  return services;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function bodyObject(ctx: ReqCtx): Record<string, unknown> {
  if (typeof ctx.body !== "object" || ctx.body === null || Array.isArray(ctx.body)) {
    throw new ForgeError("validation", "Request body must be a JSON object", 400);
  }
  return ctx.body as Record<string, unknown>;
}

/** Like bodyObject, but an absent body is treated as `{}` (optional payloads). */
function bodyObjectOrEmpty(ctx: ReqCtx): Record<string, unknown> {
  if (ctx.body === undefined) return {};
  return bodyObject(ctx);
}

function reqString(body: Record<string, unknown>, field: string, opts: { max?: number; min?: number } = {}): string {
  const value = body[field];
  if (typeof value !== "string" || value.length < (opts.min ?? 1)) {
    throw new ForgeError("validation", `Field "${field}" must be a non-empty string`, 400);
  }
  if (opts.max !== undefined && value.length > opts.max) {
    throw new ForgeError("validation", `Field "${field}" must be at most ${opts.max} characters`, 400);
  }
  return value;
}

function optString(body: Record<string, unknown>, field: string, fallback = ""): string {
  const value = body[field];
  return typeof value === "string" ? value : fallback;
}

async function needPrincipal(ctx: ReqCtx, s: Services): Promise<Principal> {
  if (ctx.principal) return ctx.principal;
  const principal = await s.auth.resolvePrincipal(ctx);
  if (!principal) throw new ForgeError("unauthorized", "Authentication required", 401);
  ctx.principal = principal;
  return principal;
}

function requireAdmin(principal: Principal): void {
  if (principal.profileName !== "Admin") {
    throw new ForgeError("forbidden", "This action requires the Admin profile", 403);
  }
}

/** Enforce an API key's scopes (user sessions are not scope-limited). */
async function requireScope(ctx: ReqCtx, s: Services, principal: Principal, scope: string): Promise<void> {
  if (principal.type !== "api_key") return;
  const auth = ctx.req.headers.authorization ?? "";
  const key = await s.store.getApiKeyByHash(hashToken(auth.slice("Bearer ".length)));
  if (!key || !scopeAllows(key.scopes, scope)) {
    throw new ForgeError("forbidden", `API key lacks the ${scope} scope`, 403);
  }
}

function sessionCookies(sessionToken: string, csrfToken: string, maxAgeSeconds: number, secure: boolean): string[] {
  return [
    serializeCookie(SESSION_COOKIE, sessionToken, { httpOnly: true, maxAge: maxAgeSeconds, sameSite: "Lax", secure }),
    serializeCookie(CSRF_COOKIE, csrfToken, { httpOnly: false, maxAge: maxAgeSeconds, sameSite: "Lax", secure }),
  ];
}

function clearCookies(): string[] {
  return [
    serializeCookie(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0, sameSite: "Lax" }),
    serializeCookie(CSRF_COOKIE, "", { httpOnly: false, maxAge: 0, sameSite: "Lax" }),
  ];
}

async function seedDefaultProfiles(store: Store, app: App): Promise<void> {
  const now = new Date().toISOString();
  for (const p of defaultProfiles(app.id, now)) {
    await store.upsertProfile({ ...p, id: newId("profile") });
  }
}

function publicApp(app: App): App {
  return app;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function registerRoutes(s: Services, overrides: ServiceOverrides): void {
  const r = s.router;

  r.get("/healthz", async () => ok({ ok: true, service: BRANDING.slug, version: BRANDING.version }));
  r.get("/api/v1/health", async () => ok({ ok: true, service: BRANDING.slug, version: BRANDING.version }));

  /* ---- Auth ---- */

  r.get("/api/v1/auth/csrf", async (ctx) => {
    const token = ctx.cookies[CSRF_COOKIE] || newCsrfToken();
    return {
      cookies: [serializeCookie(CSRF_COOKIE, token, { httpOnly: false, maxAge: 86400, sameSite: "Lax" })],
      json: { csrfToken: token },
      status: 200,
    };
  });

  r.post("/api/v1/auth/signup", async (ctx) => {
    const body = bodyObject(ctx);
    const result = await s.auth.signup({
      email: reqString(body, "email", { max: 254 }),
      name: reqString(body, "name", { max: 120 }),
      orgName: optString(body, "orgName") || undefined,
      password: reqString(body, "password", { max: 256, min: 8 }),
    });
    await audit(s.store, {
      action: "auth.signup",
      actorId: result.user.id,
      actorType: "user",
      detail: { email: result.user.email },
      orgId: result.user.org_id,
    });
    return {
      cookies: sessionCookies(result.sessionToken, result.csrfToken, Math.floor(s.config.sessionTtlMs / 1000), s.config.baseUrl.startsWith("https://")),
      json: { csrfToken: result.csrfToken, user: result.user },
      status: 201,
    };
  });

  r.post("/api/v1/auth/login", async (ctx) => {
    const body = bodyObject(ctx);
    const result = await s.auth.login(reqString(body, "email"), reqString(body, "password"));
    await audit(s.store, {
      action: "auth.login",
      actorId: result.user.id,
      actorType: "user",
      orgId: result.user.org_id,
    });
    return {
      cookies: sessionCookies(result.sessionToken, result.csrfToken, Math.floor(s.config.sessionTtlMs / 1000), s.config.baseUrl.startsWith("https://")),
      json: { csrfToken: result.csrfToken, user: result.user },
      status: 200,
    };
  });

  r.post("/api/v1/auth/logout", async (ctx) => {
    await s.auth.logout(ctx.cookies[SESSION_COOKIE]);
    return { cookies: clearCookies(), json: { ok: true }, status: 200 };
  });

  r.get("/api/v1/auth/me", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    if (principal.type !== "user") {
      return ok({ orgId: principal.orgId, profileName: principal.profileName, type: "api_key" });
    }
    const user = await s.store.getUserById(principal.userId);
    if (!user) throw new ForgeError("unauthorized", "Session user no longer exists", 401);
    return ok({ user: toPublicUser(user) });
  });

  r.get("/api/v1/auth/oauth/:provider/start", async (ctx) => {
    const provider = ctx.params.provider as OAuthProvider;
    if (provider !== "google" && provider !== "github") {
      throw new ForgeError("not_found", "Unknown OAuth provider", 404);
    }
    const appId = ctx.query.get("appId") ?? "";
    const returnTo = ctx.query.get("returnTo") ?? "/studio";
    if (!returnTo.startsWith("/") || returnTo.startsWith("//")) {
      throw new ForgeError("validation", "returnTo must be a relative path", 400);
    }
    const clientId = process.env[`OPENFORGE_OAUTH_${provider.toUpperCase()}_CLIENT_ID`] ?? "";
    if (!clientId) {
      throw new ForgeError("bad_request", `OAuth provider ${provider} is not configured (missing client id)`, 400);
    }
    const state = signOAuthState(
      { appId, nonce: newId("n"), provider, returnTo },
      s.config.masterKey,
    );
    const cfg: OAuthProviderConfig = {
      ...OAUTH_ENDPOINTS[provider],
      clientId,
      clientSecret: "",
    };
    const url = buildAuthorizationUrl(provider, cfg, state, oauthRedirectUri(s.config.baseUrl, provider));
    return redirect(url);
  });

  r.get("/api/v1/auth/oauth/:provider/callback", async (ctx) => {
    const provider = ctx.params.provider as OAuthProvider;
    const code = ctx.query.get("code");
    const stateRaw = ctx.query.get("state");
    if (!code || !stateRaw) throw new ForgeError("validation", "Missing OAuth code or state", 400);
    const state = verifyOAuthState(stateRaw, s.config.masterKey);
    if (!state || state.provider !== provider) {
      throw new ForgeError("unauthorized", "Invalid or expired OAuth state", 401);
    }
    const clientId = process.env[`OPENFORGE_OAUTH_${provider.toUpperCase()}_CLIENT_ID`] ?? "";
    const clientSecret = process.env[`OPENFORGE_OAUTH_${provider.toUpperCase()}_CLIENT_SECRET`] ?? "";
    if (!clientId || !clientSecret) {
      throw new ForgeError("bad_request", `OAuth provider ${provider} is not configured`, 400);
    }
    const cfg: OAuthProviderConfig = { ...OAUTH_ENDPOINTS[provider], clientId, clientSecret };
    const profile = await exchangeCodeForProfile(
      provider,
      cfg,
      code,
      oauthRedirectUri(s.config.baseUrl, provider),
      overrides.oauthFetch,
    );
    // Resolve the org: from the app when present, else from an existing
    // account with this email, else a brand-new org.
    let orgId: string | null = null;
    if (state.appId) {
      const app = await s.store.getAppById(state.appId);
      if (app) orgId = app.org_id;
    }
    let user = await s.store.findUserByEmail(profile.email);
    if (user) orgId = user.org_id;
    if (!orgId) {
      const now = new Date().toISOString();
      const org = await s.store.createOrg({
        created_at: now,
        id: newId("org"),
        name: `${profile.name}'s Organization`,
        slug: slugify(profile.name),
      });
      orgId = org.id;
    }
    const now = new Date().toISOString();
    if (!user) {
      user = await s.store.createUser({
        created_at: now,
        email: profile.email,
        id: newId("user"),
        name: profile.name,
        ...(provider === "google" ? { oauth_google_sub: profile.sub } : { oauth_github_sub: profile.sub }),
        org_id: orgId,
        password_hash: null,
        profile_name: "Member",
      });
    } else {
      const patch: Partial<typeof user> =
        provider === "google" ? { oauth_google_sub: profile.sub } : { oauth_github_sub: profile.sub };
      user = await s.store.updateUser({ ...user, ...patch });
    }
    const token = randomBytes(32).toString("hex");
    await s.store.createSession({
      created_at: now,
      csrf_token: newCsrfToken(),
      expires_at: new Date(Date.now() + s.config.sessionTtlMs).toISOString(),
      id: newId("sess"),
      org_id: orgId,
      token_hash: hashToken(token),
      user_id: user.id,
    });
    const session = await s.store.getSessionByTokenHash(hashToken(token));
    await audit(s.store, { action: "auth.oauth", actorId: user.id, actorType: "user", detail: { provider }, orgId });
    return {
      cookies: sessionCookies(token, session?.csrf_token ?? "", Math.floor(s.config.sessionTtlMs / 1000), s.config.baseUrl.startsWith("https://")),
      headers: { location: state.returnTo },
      status: 302,
    };
  });

  /* ---- Apps ---- */

  r.get("/api/v1/apps", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const apps = await s.store.listApps(principal.orgId);
    const q = (ctx.query.get("q") ?? "").toLowerCase();
    const filtered = q ? apps.filter((a) => a.name.toLowerCase().includes(q)) : apps;
    return ok({ apps: filtered.map(publicApp) });
  });

  r.post("/api/v1/apps", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const body = bodyObject(ctx);
    const name = reqString(body, "name", { max: 80 });
    const description = optString(body, "description").slice(0, 500);
    let slug = slugify(name);
    if (await s.store.getAppBySlug(principal.orgId, slug)) slug = `${slug}-${newId("x").slice(4, 10)}`;
    const now = new Date().toISOString();
    const app = await s.store.createApp({
      auth_config: { oauth: [], orgIsolation: true, providers: ["email"] },
      created_at: now,
      created_by: principal.userId,
      description,
      id: newId("app"),
      name,
      org_id: principal.orgId,
      slug,
      updated_at: now,
    });
    await seedDefaultProfiles(s.store, app);
    await audit(s.store, { action: "app.created", actorId: principal.userId, actorType: principal.type, appId: app.id, orgId: principal.orgId });
    return created({ app: publicApp(app) });
  });

  r.get("/api/v1/apps/:appId", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    return ok({ app: publicApp(app) });
  });

  r.patch("/api/v1/apps/:appId", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const body = bodyObject(ctx);
    const updated = await s.store.updateApp({
      ...app,
      description: typeof body.description === "string" ? body.description.slice(0, 500) : app.description,
      name: typeof body.name === "string" && body.name.trim() ? body.name.slice(0, 80) : app.name,
      updated_at: new Date().toISOString(),
    });
    return ok({ app: publicApp(updated) });
  });

  r.delete("/api/v1/apps/:appId", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    await s.store.deleteApp(principal.orgId, app.id);
    await audit(s.store, { action: "app.deleted", actorId: principal.userId, actorType: principal.type, appId: app.id, orgId: principal.orgId });
    return noContent();
  });

  /* ---- Schema / collections ---- */

  r.get("/api/v1/apps/:appId/schema", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    const collections = await s.store.listCollections(principal.orgId, ctx.params.appId);
    return ok({ collections });
  });

  r.post("/api/v1/apps/:appId/collections", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const body = bodyObject(ctx);
    const name = reqString(body, "name", { max: 64 });
    if (!isValidCollectionName(name)) throw new ForgeError("validation", `Invalid collection name: ${name}`, 400);
    const attributes = body.attributes;
    if (!Array.isArray(attributes) || attributes.length === 0) {
      throw new ForgeError("validation", "attributes must be a non-empty array", 400);
    }
    const indexes = Array.isArray(body.indexes) ? body.indexes : [];
    const existing = await s.store.getCollection(principal.orgId, app.id, name);
    const now = new Date().toISOString();
    const collection = await s.store.upsertCollection({
      app_id: app.id,
      attributes: attributes as never,
      created_at: existing?.created_at ?? now,
      id: existing?.id ?? newId("col"),
      indexes: indexes as never,
      name,
      org_id: principal.orgId,
    });
    await audit(s.store, { action: "collection.created", actorId: principal.userId, actorType: principal.type, appId: app.id, detail: { collection: name }, orgId: principal.orgId });
    return created({ collection });
  });

  r.delete("/api/v1/apps/:appId/collections/:name", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    await s.store.deleteCollection(principal.orgId, ctx.params.appId, ctx.params.name);
    return noContent();
  });

  /* ---- Records (nested + /api/v1/records alias) ---- */

  async function listRecords(ctx: ReqCtx, appId: string, collection: string): Promise<HandlerResult> {
    const principal = await needPrincipal(ctx, s);
    await requireScope(ctx, s, principal, "records:read");
    const limit = Number(ctx.query.get("limit") ?? 50);
    const offset = Number(ctx.query.get("offset") ?? 0);
    return ok(await s.records.list(principal, appId, collection, { limit, offset }));
  }

  async function createRecord(ctx: ReqCtx, appId: string, collection: string): Promise<HandlerResult> {
    const principal = await needPrincipal(ctx, s);
    await requireScope(ctx, s, principal, "records:write");
    const record = await s.records.create(principal, appId, collection, bodyObject(ctx));
    return created({ record });
  }

  r.get("/api/v1/apps/:appId/records/:collection", async (ctx) => listRecords(ctx, ctx.params.appId, ctx.params.collection));
  r.post("/api/v1/apps/:appId/records/:collection", async (ctx) => createRecord(ctx, ctx.params.appId, ctx.params.collection));
  r.get("/api/v1/records/:collection", async (ctx) => {
    const appId = ctx.query.get("app_id");
    if (!appId) throw new ForgeError("validation", "app_id query parameter is required", 400);
    return listRecords(ctx, appId, ctx.params.collection);
  });
  r.post("/api/v1/records/:collection", async (ctx) => {
    const appId = ctx.query.get("app_id");
    if (!appId) throw new ForgeError("validation", "app_id query parameter is required", 400);
    return createRecord(ctx, appId, ctx.params.collection);
  });

  r.get("/api/v1/apps/:appId/records/:collection/:id", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await requireScope(ctx, s, principal, "records:read");
    return ok({ record: await s.records.get(principal, ctx.params.appId, ctx.params.collection, ctx.params.id) });
  });

  r.patch("/api/v1/apps/:appId/records/:collection/:id", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await requireScope(ctx, s, principal, "records:write");
    const record = await s.records.update(principal, ctx.params.appId, ctx.params.collection, ctx.params.id, bodyObject(ctx));
    return ok({ record });
  });

  r.delete("/api/v1/apps/:appId/records/:collection/:id", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await requireScope(ctx, s, principal, "records:write");
    await s.records.delete(principal, ctx.params.appId, ctx.params.collection, ctx.params.id);
    return noContent();
  });

  /* ---- Profiles ---- */

  r.get("/api/v1/apps/:appId/profiles", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    const profiles = await s.store.listProfiles(principal.orgId, ctx.params.appId);
    return ok({ profiles });
  });

  r.post("/api/v1/apps/:appId/profiles", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const body = bodyObject(ctx);
    const errors = validateProfile({ description: body.description, name: body.name, rules: body.rules });
    if (errors.length > 0) throw new ForgeError("validation", `Invalid profile: ${errors.join("; ")}`, 400, errors);
    const now = new Date().toISOString();
    const existing = await s.store.getProfile(principal.orgId, app.id, String(body.name));
    const profile = await s.store.upsertProfile({
      appId: app.id,
      createdAt: existing?.createdAt ?? now,
      description: typeof body.description === "string" ? body.description : existing?.description,
      id: existing?.id ?? newId("profile"),
      isDefault: existing?.isDefault ?? false,
      name: String(body.name),
      rules: body.rules as never,
      updatedAt: now,
    });
    await audit(s.store, { action: "profile.applied", actorId: principal.userId, actorType: principal.type, appId: app.id, detail: { profile: profile.name }, orgId: principal.orgId });
    return created({ profile });
  });

  r.put("/api/v1/apps/:appId/profiles/:profileId", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const existing = await s.store.getProfile(principal.orgId, app.id, ctx.params.profileId);
    if (!existing) throw new ForgeError("not_found", "Profile not found", 404);
    const body = bodyObject(ctx);
    const candidate = { description: body.description ?? existing.description, name: body.name ?? existing.name, rules: body.rules ?? existing.rules };
    const errors = validateProfile(candidate);
    if (errors.length > 0) throw new ForgeError("validation", `Invalid profile: ${errors.join("; ")}`, 400, errors);
    const profile = await s.store.upsertProfile({
      ...existing,
      description: candidate.description as string | undefined,
      name: candidate.name as string,
      rules: candidate.rules as never,
      updatedAt: new Date().toISOString(),
    });
    await audit(s.store, { action: "profile.applied", actorId: principal.userId, actorType: principal.type, appId: app.id, detail: { profile: profile.name }, orgId: principal.orgId });
    return ok({ profile });
  });

  r.delete("/api/v1/apps/:appId/profiles/:profileId", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    await s.store.deleteProfile(principal.orgId, app.id, ctx.params.profileId);
    return noContent();
  });

  r.post("/api/v1/apps/:appId/profiles/:profileId/assign", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const profile = await s.store.getProfile(principal.orgId, app.id, ctx.params.profileId);
    if (!profile) throw new ForgeError("not_found", "Profile not found", 404);
    const body = bodyObject(ctx);
    const user = await s.store.getUserById(reqString(body, "userId"));
    if (!user || user.org_id !== principal.orgId) throw new ForgeError("not_found", "User not found", 404);
    await s.store.updateUser({ ...user, profile_name: profile.name });
    return ok({ user: toPublicUser({ ...user, profile_name: profile.name }) });
  });

  /* ---- API keys ---- */

  r.get("/api/v1/apps/:appId/api-keys", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const keys = await s.store.listApiKeys(principal.orgId, ctx.params.appId);
    return ok({ apiKeys: keys.map(toPublicApiKey) });
  });

  r.post("/api/v1/apps/:appId/api-keys", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const body = bodyObject(ctx);
    const scopes = Array.isArray(body.scopes) ? (body.scopes as string[]) : ["*"];
    const result = await createApiKeyRecord(s.store, principal.orgId, {
      appId: app.id,
      name: reqString(body, "name", { max: 80 }),
      profileName: optString(body, "profileName", "Admin") || "Admin",
      scopes,
    });
    await audit(s.store, { action: "api_key.created", actorId: principal.userId, actorType: principal.type, appId: app.id, detail: { keyId: result.key.id }, orgId: principal.orgId });
    // The plaintext key is returned ONCE, here. It is never stored.
    return created({ apiKey: result.key, plaintext: result.plaintext });
  });

  r.post("/api/v1/apps/:appId/api-keys/:keyId/revoke", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const keys = await s.store.listApiKeys(principal.orgId, ctx.params.appId);
    const key = keys.find((k) => k.id === ctx.params.keyId);
    if (!key) throw new ForgeError("not_found", "API key not found", 404);
    await s.store.updateApiKey({ ...key, revoked_at: new Date().toISOString() });
    await audit(s.store, { action: "api_key.revoked", actorId: principal.userId, actorType: principal.type, appId: ctx.params.appId, detail: { keyId: key.id }, orgId: principal.orgId });
    return ok({ ok: true });
  });

  /* ---- Project files ---- */

  r.get("/api/v1/apps/:appId/files", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    const files = await s.store.listFiles(principal.orgId, ctx.params.appId);
    const prefix = ctx.query.get("prefix") ?? "";
    return ok({ files: files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path, size: f.size, updated_at: f.updated_at })) });
  });

  r.get("/api/v1/apps/:appId/file", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await requireScope(ctx, s, principal, "files:read");
    await s.auth.requireApp(principal, ctx.params.appId);
    const file = await s.store.getFile(principal.orgId, ctx.params.appId, scopePath(ctx.query.get("path") ?? ""));
    if (!file) throw new ForgeError("not_found", "File not found", 404);
    return ok({ content: file.content, path: file.path });
  });

  r.put("/api/v1/apps/:appId/file", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await requireScope(ctx, s, principal, "files:write");
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    const body = bodyObject(ctx);
    const safe = scopePath(reqString(body, "path", { max: 500 }));
    const content = reqString(body, "content", { max: 500000, min: 0 });
    const existing = await s.store.getFile(principal.orgId, app.id, safe);
    const file = await s.store.upsertFile({
      app_id: app.id,
      content,
      id: existing?.id ?? newId("file"),
      org_id: principal.orgId,
      path: safe,
      size: Buffer.byteLength(content),
      updated_at: new Date().toISOString(),
    });
    return ok({ file: { path: file.path, size: file.size, updated_at: file.updated_at } });
  });

  r.delete("/api/v1/apps/:appId/file", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    await s.store.deleteFile(principal.orgId, ctx.params.appId, scopePath(ctx.query.get("path") ?? ""));
    return noContent();
  });

  /* ---- Storage (JSON base64 uploads) ---- */

  r.post("/api/v1/apps/:appId/storage", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    const body = bodyObject(ctx);
    const bucket = reqString(body, "bucket", { max: 64 });
    const name = reqString(body, "name", { max: 200 });
    const dataBase64 = reqString(body, "dataBase64", { max: 20 * 1024 * 1024 });
    const data = Buffer.from(dataBase64, "base64");
    if (data.length > s.config.maxUploadBytes) {
      throw new ForgeError("bad_request", `Upload exceeds ${s.config.maxUploadBytes} bytes`, 413);
    }
    const file = await s.store.createStorageFile({
      app_id: app.id,
      bucket,
      content_type: optString(body, "contentType", "application/octet-stream"),
      created_at: new Date().toISOString(),
      data_base64: data.toString("base64"),
      id: newId("obj"),
      name,
      org_id: principal.orgId,
      size: data.length,
    });
    return created({ file: { bucket: file.bucket, content_type: file.content_type, id: file.id, name: file.name, size: file.size } });
  });

  r.get("/api/v1/apps/:appId/storage/:bucket", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    const files = await s.store.listStorageFiles(principal.orgId, ctx.params.appId, ctx.params.bucket);
    return ok({ files: files.map((f) => ({ bucket: f.bucket, content_type: f.content_type, id: f.id, name: f.name, size: f.size })) });
  });

  r.get("/api/v1/apps/:appId/storage/:bucket/:id", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    const file = await s.store.getStorageFile(principal.orgId, ctx.params.appId, ctx.params.id);
    if (!file || file.bucket !== ctx.params.bucket) throw new ForgeError("not_found", "Object not found", 404);
    return raw(Buffer.from(file.data_base64, "base64"), file.content_type, 200, {
      "content-disposition": `inline; filename="${file.name.replace(/"/g, "")}"`,
    });
  });

  r.delete("/api/v1/apps/:appId/storage/:bucket/:id", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    await s.store.deleteStorageFile(principal.orgId, ctx.params.appId, ctx.params.id);
    return noContent();
  });

  /* ---- Edge functions ---- */

  r.get("/api/v1/apps/:appId/functions", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    const fns = await s.store.listFunctions(principal.orgId, ctx.params.appId);
    return ok({ functions: fns.map((f) => ({ name: f.name, updated_at: f.updated_at })) });
  });

  r.post("/api/v1/apps/:appId/functions", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const body = bodyObject(ctx);
    const name = reqString(body, "name", { max: 80 });
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name)) throw new ForgeError("validation", "Invalid function name", 400);
    const code = reqString(body, "code", { max: 100000 });
    const now = new Date().toISOString();
    const existing = await s.store.getFunction(principal.orgId, app.id, name);
    await s.store.upsertFunction({
      app_id: app.id,
      code,
      created_at: existing?.created_at ?? now,
      id: existing?.id ?? newId("fn"),
      name,
      org_id: principal.orgId,
      updated_at: now,
    });
    return created({ function: { name } });
  });

  r.post("/api/v1/apps/:appId/functions/:name/invoke", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    const fn = await s.store.getFunction(principal.orgId, app.id, ctx.params.name);
    if (!fn) throw new ForgeError("not_found", "Function not found", 404);
    const body = bodyObjectOrEmpty(ctx);
    const result = await runFunctionCode(fn.code, body.input ?? {}, { timeoutMs: s.config.functionTimeoutMs }).catch((err: Error) => {
      throw new ForgeError("bad_request", err.message, 400);
    });
    await audit(s.store, { action: "function.executed", actorId: principal.userId, actorType: principal.type, appId: app.id, detail: { function: fn.name }, orgId: principal.orgId });
    return ok(result);
  });

  r.delete("/api/v1/apps/:appId/functions/:name", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    await s.store.deleteFunction(principal.orgId, ctx.params.appId, ctx.params.name);
    return noContent();
  });

  /* ---- Deployments / domains ---- */

  r.get("/api/v1/apps/:appId/deployments", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    const deployments = await s.store.listDeployments(principal.orgId, ctx.params.appId);
    return ok({ deployments: deployments.map((d) => ({ created_at: d.created_at, environment: d.environment, files: d.files.length, id: d.id, promoted_from: d.promoted_from, status: d.status })) });
  });

  r.post("/api/v1/apps/:appId/deploy", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    const body = bodyObject(ctx);
    const environment = body.environment === "production" ? "production" : "staging";
    if (environment === "production") {
      const profiles = await s.store.listProfiles(principal.orgId, app.id);
      if (!profiles.some((p) => Object.keys(p.rules).length > 0)) {
        throw new ForgeError("forbidden", "Production deploy refused: apply a security profile with rules first", 403);
      }
    }
    let files: Array<{ content: string; path: string }>;
    if (Array.isArray(body.files)) {
      files = (body.files as Array<{ content: string; path: string }>).map((f) => ({ content: String(f.content), path: scopePath(String(f.path)) }));
    } else {
      const projectFiles = await s.store.listFiles(principal.orgId, app.id);
      files = projectFiles.map((f) => ({ content: f.content, path: f.path }));
    }
    if (files.length === 0) throw new ForgeError("validation", "Nothing to deploy: no project files", 400);
    const deployment = await deploySnapshot(s.store, principal.orgId, app.id, environment, files);
    await audit(s.store, { action: "deploy.published", actorId: principal.userId, actorType: principal.type, appId: app.id, detail: { deploymentId: deployment.id, environment }, orgId: principal.orgId });
    return created({ deployment: { id: deployment.id }, url: previewUrl(s.config.baseUrl, app.id, environment) });
  });

  r.post("/api/v1/apps/:appId/promote", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const deployment = await promoteToProduction(s.store, principal.orgId, app.id);
    await audit(s.store, { action: "deploy.promoted", actorId: principal.userId, actorType: principal.type, appId: app.id, detail: { deploymentId: deployment.id }, orgId: principal.orgId });
    return ok({ deployment: { id: deployment.id }, url: previewUrl(s.config.baseUrl, app.id, "production") });
  });

  r.get("/api/v1/apps/:appId/preview-url", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    const environment = ctx.query.get("environment") === "production" ? "production" : "staging";
    return ok({ url: previewUrl(s.config.baseUrl, app.id, environment) });
  });

  r.get("/api/v1/apps/:appId/domains", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    return ok({ domains: await s.store.listDomains(principal.orgId, ctx.params.appId) });
  });

  r.post("/api/v1/apps/:appId/domains", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const body = bodyObject(ctx);
    const hostname = reqString(body, "hostname", { max: 253 }).toLowerCase();
    if (!/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(hostname)) {
      throw new ForgeError("validation", "Invalid hostname", 400);
    }
    const environment = body.environment === "staging" ? "staging" : "production";
    const domain = await s.store.createDomain({
      app_id: app.id,
      created_at: new Date().toISOString(),
      environment,
      hostname,
      id: newId("dom"),
      org_id: principal.orgId,
      status: "pending",
    });
    return created({ domain });
  });

  r.delete("/api/v1/apps/:appId/domains/:id", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    await s.store.deleteDomain(principal.orgId, ctx.params.appId, ctx.params.id);
    return noContent();
  });

  r.get("/api/v1/apps/:appId/caddyfile", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    const domains = await s.store.listDomains(principal.orgId, ctx.params.appId);
    const text = generateCaddyfile(domains, {
      production: `localhost:${s.config.port}`,
      staging: `localhost:${s.config.port}`,
    });
    return raw(text, "text/plain; charset=utf-8");
  });

  /* ---- Billing ---- */

  r.get("/api/v1/apps/:appId/billing/plans", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    return ok({ plans: await s.store.listPlans(principal.orgId, ctx.params.appId) });
  });

  r.post("/api/v1/apps/:appId/billing/plans", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const body = bodyObject(ctx);
    if (!Array.isArray(body.plans) || body.plans.length === 0) {
      throw new ForgeError("validation", "plans must be a non-empty array", 400);
    }
    const plans = await s.billing.setupPlans(app, body.plans as never, principal.userId);
    return created({ plans });
  });

  r.post("/api/v1/apps/:appId/billing/checkout", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    const body = bodyObject(ctx);
    const result = await s.billing.createCheckout(app, reqString(body, "planId"), {
      cancelUrl: reqString(body, "cancelUrl"),
      customerEmail: optString(body, "customerEmail") || undefined,
      successUrl: reqString(body, "successUrl"),
    });
    return ok(result);
  });

  r.post("/api/v1/apps/:appId/billing/portal", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    const body = bodyObject(ctx);
    return ok(await s.billing.createPortal(app, reqString(body, "customerEmail"), reqString(body, "returnUrl")));
  });

  r.get("/api/v1/apps/:appId/billing/subscriptions", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    return ok({ subscriptions: await s.store.listSubscriptions(principal.orgId, ctx.params.appId) });
  });

  r.post("/api/v1/apps/:appId/billing/usage", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    const body = bodyObject(ctx);
    await s.billing.recordUsage(app, reqString(body, "metric"), Number(body.quantity));
    return ok({ ok: true });
  });

  r.get("/api/v1/apps/:appId/billing/usage", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    return ok({ totals: await s.billing.usageTotals(app) });
  });

  r.post("/api/v1/webhooks/stripe/:appId", async (ctx) => {
    // No principal: the Stripe HMAC signature IS the authentication.
    const app = await s.store.getAppById(ctx.params.appId);
    if (!app) throw new ForgeError("not_found", "App not found", 404);
    const signature = ctx.req.headers["stripe-signature"];
    const result = await s.billing.handleStripeWebhook(
      app,
      ctx.rawBody,
      typeof signature === "string" ? signature : undefined,
    );
    return ok({ received: true, ...result });
  });

  /* ---- Outbound webhooks ---- */

  r.get("/api/v1/apps/:appId/webhooks", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    const endpoints = await s.store.listWebhooks(principal.orgId, ctx.params.appId);
    return ok({ webhooks: endpoints.map((w) => ({ ...w, secret: `${w.secret.slice(0, 10)}…` })) });
  });

  r.post("/api/v1/apps/:appId/webhooks", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const body = bodyObject(ctx);
    const endpoint = await s.webhooks.createEndpoint(principal.orgId, app.id, {
      events: Array.isArray(body.events) ? (body.events as string[]) : [],
      url: reqString(body, "url", { max: 2000 }),
    });
    return created({ webhook: { ...endpoint, secret: `${endpoint.secret.slice(0, 10)}…` } });
  });

  r.delete("/api/v1/apps/:appId/webhooks/:id", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    await s.store.deleteWebhook(principal.orgId, ctx.params.appId, ctx.params.id);
    return noContent();
  });

  r.get("/api/v1/apps/:appId/webhooks/:id/deliveries", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    const endpoint = await s.store.getWebhook(principal.orgId, ctx.params.appId, ctx.params.id);
    if (!endpoint) throw new ForgeError("not_found", "Webhook not found", 404);
    return ok({ deliveries: await s.store.listDeliveries(endpoint.id) });
  });

  r.post("/api/v1/apps/:appId/webhooks/:id/test", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    const endpoint = await s.store.getWebhook(principal.orgId, ctx.params.appId, ctx.params.id);
    if (!endpoint) throw new ForgeError("not_found", "Webhook not found", 404);
    return ok(await s.webhooks.sendTest(endpoint, app));
  });

  /* ---- Secrets ---- */

  r.get("/api/v1/apps/:appId/secrets", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    return ok({ secrets: await s.vault.listNames(principal.orgId, ctx.params.appId) });
  });

  r.post("/api/v1/apps/:appId/secrets", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const body = bodyObject(ctx);
    const result = await s.vault.set(principal.orgId, app.id, reqString(body, "key", { max: 120 }), reqString(body, "value", { max: 8000 }));
    await audit(s.store, { action: "secret.stored", actorId: principal.userId, actorType: principal.type, appId: app.id, detail: { key: result.key }, orgId: principal.orgId });
    return created(result);
  });

  r.delete("/api/v1/apps/:appId/secrets/:key", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const removed = await s.vault.remove(principal.orgId, ctx.params.appId, ctx.params.key);
    if (!removed) throw new ForgeError("not_found", "Secret not found", 404);
    return noContent();
  });

  /* ---- Audit ---- */

  r.get("/api/v1/apps/:appId/audit", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    const events = await s.store.listAudit(
      principal.orgId,
      ctx.params.appId,
      ctx.query.get("action") ?? undefined,
      Math.min(Number(ctx.query.get("limit") ?? 50), 200),
    );
    return ok({ events });
  });

  /* ---- GitHub sync ---- */

  r.get("/api/v1/apps/:appId/github", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    const link = await s.store.getGithubLink(principal.orgId, ctx.params.appId);
    return ok({ link });
  });

  r.post("/api/v1/apps/:appId/github", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const body = bodyObject(ctx);
    const result = await s.github.link(
      principal.orgId,
      app.id,
      reqString(body, "repoUrl", { max: 500 }),
      optString(body, "branch", "main") || "main",
      typeof body.token === "string" ? body.token : undefined,
    );
    return ok(result);
  });

  r.get("/api/v1/apps/:appId/github/status", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    await s.auth.requireApp(principal, ctx.params.appId);
    return ok(await s.github.status(principal.orgId, ctx.params.appId));
  });

  r.post("/api/v1/apps/:appId/github/push", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const body = bodyObjectOrEmpty(ctx);
    const result = await s.github.push(principal.orgId, app.id, optString(body, "message", "Studio sync") || "Studio sync");
    await audit(s.store, { action: "github.pushed", actorId: principal.userId, actorType: principal.type, appId: app.id, detail: { sha: result.sha }, orgId: principal.orgId });
    return ok(result);
  });

  r.post("/api/v1/apps/:appId/github/pull", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const result = await s.github.pull(principal.orgId, app.id);
    await audit(s.store, { action: "github.pulled", actorId: principal.userId, actorType: principal.type, appId: app.id, detail: { imported: result.imported.length }, orgId: principal.orgId });
    return ok(result);
  });

  r.post("/api/v1/apps/:appId/github/sync", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const body = bodyObjectOrEmpty(ctx);
    const result = await s.github.sync(principal.orgId, app.id, optString(body, "message", "Studio sync") || "Studio sync");
    return ok(result);
  });

  /* ---- Eject ---- */

  r.post("/api/v1/apps/:appId/eject", async (ctx) => {
    const principal = await needPrincipal(ctx, s);
    const app = await s.auth.requireApp(principal, ctx.params.appId);
    requireAdmin(principal);
    const schemas = await s.store.listCollections(principal.orgId, app.id);
    const profiles = await s.store.listProfiles(principal.orgId, app.id);
    const files = await s.store.listFiles(principal.orgId, app.id);
    const plans = await s.store.listPlans(principal.orgId, app.id);
    const records: StoredRecord[] = [];
    for (const schema of schemas) {
      const rows = await s.store.listRecords(principal.orgId, app.id, schema.name);
      for (const row of rows) records.push(row);
    }
    const bundle = buildEjectBundle({ app, files, plans, profiles, records, schemas });
    const tar = writeTar(bundle);
    await audit(s.store, { action: "eject.exported", actorId: principal.userId, actorType: principal.type, appId: app.id, detail: { files: bundle.length }, orgId: principal.orgId });
    return raw(tar, "application/x-tar", 200, {
      "content-disposition": `attachment; filename="${app.slug}-eject.tar"`,
    });
  });

  /* ---- Realtime (SSE) ---- */

  r.get("/api/v1/realtime", async (ctx) => {
    const appId = ctx.query.get("appId");
    const token = ctx.query.get("token");
    if (!appId || !token) throw new ForgeError("validation", "appId and token query parameters are required", 400);
    // EventSource cannot set headers, so the token travels in the query
    // string. It may be a session token or an API key; both are hashed
    // before lookup, and the stream is scoped to the resolved org + app.
    let principal: Principal | null = null;
    const key = await s.store.getApiKeyByHash(hashToken(token));
    if (key && !key.revoked_at) {
      principal = { apiKeyId: key.id, orgId: key.org_id, profileName: key.profile_name, type: "api_key", userId: `apikey:${key.id}` };
    } else {
      const session = await s.store.getSessionByTokenHash(hashToken(token));
      if (session && new Date(session.expires_at).getTime() >= Date.now()) {
        const user = await s.store.getUserById(session.user_id);
        if (user) {
          principal = { email: user.email, orgId: user.org_id, profileName: user.profile_name, type: "user", userId: user.id };
        }
      }
    }
    if (!principal) throw new ForgeError("unauthorized", "Invalid realtime token", 401);
    const app = await s.store.getApp(principal.orgId, appId);
    if (!app) throw new ForgeError("not_found", "App not found", 404);
    const { res } = ctx;
    res.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    res.write(": connected\n\n");
    const unsubscribe = s.realtime.subscribe(principal.orgId, app.id, res);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 30000);
    heartbeat.unref?.();
    ctx.req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return { handled: true };
  });
}

/* ------------------------------------------------------------------ */
/* Dispatcher: MCP -> preview -> API router -> static files            */
/* ------------------------------------------------------------------ */

const STATIC_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

async function serveStatic(s: Services, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const publicDir = s.config.publicDir;
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const candidate = path.normalize(path.join(publicDir, rel));
  if (!candidate.startsWith(publicDir)) return false;
  const file = await fs.readFile(candidate).catch(() => null);
  if (file) {
    const ext = path.extname(candidate).toLowerCase();
    res.writeHead(200, {
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=86400",
      "content-length": file.length,
      "content-type": STATIC_TYPES[ext] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    res.end(file);
    return true;
  }
  // SPA fallback for extensionless routes.
  if (!path.extname(pathname)) {
    const index = await fs.readFile(path.join(publicDir, "index.html")).catch(() => null);
    if (index) {
      res.writeHead(200, { "cache-control": "no-store", "content-length": index.length, "content-type": "text/html; charset=utf-8" });
      res.end(index);
      return true;
    }
    // Web build missing: honest placeholder instead of a blank page.
    const placeholder = `<!doctype html><html><head><meta charset="utf-8"><title>${BRANDING.name} Studio</title></head><body style="font-family:system-ui;margin:3rem auto;max-width:560px"><h1>${BRANDING.name} Studio</h1><p>The Studio frontend has not been built yet. Run <code>npm run build:web</code> and reload.</p></body></html>`;
    res.writeHead(200, { "content-length": Buffer.byteLength(placeholder), "content-type": "text/html; charset=utf-8" });
    res.end(placeholder);
    return true;
  }
  return false;
}

async function servePreview(s: Services, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const m = pathname.match(/^\/preview\/([^/]+)\/(staging|production)(\/.*)?$/);
  if (!m) return false;
  const [, appId, environment, rest] = m;
  const relPath = (rest ?? "/").replace(/^\//, "") || "index.html";
  // Staging previews require org membership; production previews are public
  // (published == live). See preview.ts for the sandboxing model.
  if (environment === "staging") {
    const cookies = parseCookies(req.headers.cookie);
    const fakeCtx: ReqCtx = {
      body: undefined,
      cookies,
      ip: clientIp(req),
      method: req.method ?? "GET",
      params: {},
      path: pathname,
      query: new URLSearchParams(),
      rawBody: Buffer.alloc(0),
      req,
      res,
    };
    const principal = await s.auth.resolvePrincipal(fakeCtx);
    if (!principal) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("Sign in to view staging previews.");
      return true;
    }
    const app = await s.store.getApp(principal.orgId, appId);
    if (!app) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("App not found.");
      return true;
    }
  }
  const app = await s.store.getAppById(appId);
  if (!app) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("App not found.");
    return true;
  }
  const deployment = await s.store.getDeployment(app.org_id, appId, environment);
  if (!deployment) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`Nothing deployed to ${environment} yet.`);
    return true;
  }
  let file = deployment.files.find((f) => f.path === relPath);
  if (!file && (relPath.endsWith("/") || !path.extname(relPath))) {
    file = deployment.files.find((f) => f.path === `${relPath.replace(/\/$/, "")}/index.html`) ?? deployment.files.find((f) => f.path === "index.html");
  }
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("File not found in this deployment.");
    return true;
  }
  const ext = path.extname(file.path).toLowerCase();
  const contentType = STATIC_TYPES[ext] ?? "application/octet-stream";
  let body = file.content;
  if (ext === ".html" || ext === ".htm") {
    body = injectInspector(body);
  }
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy": PREVIEW_CSP,
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  });
  res.end(body);
  return true;
}

export function createHttpHandler(s: Services): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const pathname = url.pathname;
        const method = req.method ?? "GET";

        // Rate limiting (all paths except health).
        if (pathname !== "/healthz") {
          const family = pathname.split("/").slice(0, 3).join("/");
          const check = s.rateLimiter.check(`${clientIp(req)}:${family}`);
          if (!check.allowed) {
            res.writeHead(429, {
              "content-type": "application/json",
              "retry-after": String(Math.ceil(check.retryAfterMs / 1000)),
            });
            res.end(JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } }));
            return;
          }
        }

        // MCP transports (Streamable HTTP + legacy SSE).
        if (pathname === BRANDING.mcpPath || pathname === BRANDING.mcpLegacySsePath || pathname === "/messages") {
          const handled = await s.mcp.handle(req, res);
          if (handled) return;
        }

        // Preview hosting.
        if (method === "GET" && pathname.startsWith("/preview/")) {
          if (await servePreview(s, req, res, pathname)) return;
        }

        // API router.
        const match = s.router.match(method, pathname);
        if (match) {
          const rawBody = ["GET", "HEAD", "OPTIONS"].includes(method) ? Buffer.alloc(0) : await readBody(req);
          const isStripeWebhook = pathname.startsWith("/api/v1/webhooks/stripe/");
          const body = rawBody.length > 0 && !isStripeWebhook ? parseJsonBody(rawBody) : undefined;
          const ctx: ReqCtx = {
            body,
            cookies: parseCookies(req.headers.cookie),
            ip: clientIp(req),
            method,
            params: match.params,
            path: pathname,
            query: url.searchParams,
            rawBody,
            req,
            res,
          };
          assertCsrf(ctx);
          const result = await match.handler(ctx);
          sendResult(res, result);
          return;
        }
        if (s.router.allows(pathname).length > 0) {
          res.writeHead(405, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "bad_request", message: "Method not allowed" } }));
          return;
        }

        // Static Studio files + SPA fallback.
        if (method === "GET") {
          if (await serveStatic(s, req, res, pathname)) return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
      } catch (err) {
        if (!res.writableEnded) sendError(res, err);
      }
    })();
  };
}

export async function maybeSeed(s: Services): Promise<void> {
  if (!s.config.seedDemo) return;
  const demoPassword = process.env.OPENFORGE_DEMO_PASSWORD ?? "demo-password-123";
  const seeded = await seedDemo(s.store, demoPassword);
  if (seeded) {
    console.log(`[seed] Demo account: ${seeded.email} (password from OPENFORGE_DEMO_PASSWORD)`);
  }
}
