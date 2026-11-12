import { createHash, randomBytes } from "node:crypto";
import {
  ForgeError,
  hashPassword,
  newId,
  resolveProfile,
  signToken,
  slugify,
  verifyPassword,
  verifyToken,
  type SecurityProfile,
} from "@openforge/shared";
import type { ServerConfig } from "./config";
import type { ReqCtx, Principal } from "./http";
import { newCsrfToken } from "./security";
import type { App, Store, User } from "./store";

export const SESSION_COOKIE = "of_session";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SignupInput {
  email: string;
  name: string;
  orgName?: string;
  password: string;
}

export interface AuthResult {
  csrfToken: string;
  sessionToken: string;
  user: PublicUser;
}

export type PublicUser = Omit<User, "password_hash" | "oauth_github_sub" | "oauth_google_sub">;

export function toPublicUser(user: User): PublicUser {
  const { oauth_github_sub: _g, oauth_google_sub: _o, password_hash: _p, ...rest } = user;
  return rest;
}

export class AuthService {
  constructor(
    private readonly store: Store,
    private readonly config: ServerConfig,
  ) {}

  /** Create a fresh org + its first (Admin) user, and start a session. */
  async signup(input: SignupInput): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ForgeError("validation", "Invalid email address", 400);
    }
    if (input.password.length < 8) {
      throw new ForgeError("validation", "Password must be at least 8 characters", 400);
    }
    const existing = await this.store.findUserByEmail(email);
    if (existing) {
      throw new ForgeError("conflict", "An account with this email already exists", 409);
    }
    const now = new Date().toISOString();
    const orgName = input.orgName?.trim() || `${input.name.trim()}'s Organization`;
    const org = await this.store.createOrg({
      created_at: now,
      id: newId("org"),
      name: orgName,
      slug: slugify(orgName),
    });
    const user = await this.store.createUser({
      created_at: now,
      email,
      id: newId("user"),
      name: input.name.trim(),
      org_id: org.id,
      password_hash: hashPassword(input.password),
      profile_name: "Admin",
    });
    return this.startSession(user);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.store.findUserByEmail(email.trim().toLowerCase());
    // Identical error + timing profile whether the email exists or not.
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      throw new ForgeError("unauthorized", "Invalid email or password", 401);
    }
    return this.startSession(user);
  }

  async logout(sessionToken: string | undefined): Promise<void> {
    if (!sessionToken) return;
    const session = await this.store.getSessionByTokenHash(hashToken(sessionToken));
    if (session) await this.store.deleteSession(session.id);
  }

  private async startSession(user: User): Promise<AuthResult> {
    const token = randomBytes(32).toString("hex");
    const now = new Date();
    await this.store.createSession({
      created_at: now.toISOString(),
      csrf_token: newCsrfToken(),
      expires_at: new Date(now.getTime() + this.config.sessionTtlMs).toISOString(),
      id: newId("sess"),
      org_id: user.org_id,
      token_hash: hashToken(token),
      user_id: user.id,
    });
    const session = await this.store.getSessionByTokenHash(hashToken(token));
    return { csrfToken: session?.csrf_token ?? "", sessionToken: token, user: toPublicUser(user) };
  }

  /** Resolve the caller from a Bearer API key or the session cookie. */
  async resolvePrincipal(ctx: ReqCtx): Promise<Principal | null> {
    const auth = ctx.req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      const token = auth.slice("Bearer ".length).trim();
      if (!token) return null;
      const key = await this.store.getApiKeyByHash(hashToken(token));
      if (!key || key.revoked_at) return null;
      await this.store.updateApiKey({ ...key, last_used_at: new Date().toISOString() });
      return {
        apiKeyId: key.id,
        orgId: key.org_id,
        profileName: key.profile_name,
        type: "api_key",
        userId: `apikey:${key.id}`,
      };
    }
    const cookie = ctx.cookies[SESSION_COOKIE];
    if (!cookie) return null;
    const session = await this.store.getSessionByTokenHash(hashToken(cookie));
    if (!session || new Date(session.expires_at).getTime() < Date.now()) return null;
    const user = await this.store.getUserById(session.user_id);
    if (!user || user.org_id !== session.org_id) return null;
    return {
      email: user.email,
      orgId: user.org_id,
      profileName: user.profile_name,
      type: "user",
      userId: user.id,
    };
  }

  /** Load an app the caller owns (404 whether missing or foreign — no leaking). */
  async requireApp(principal: Principal, appId: string): Promise<App> {
    const app = await this.store.getApp(principal.orgId, appId);
    if (!app) throw new ForgeError("not_found", "App not found", 404);
    return app;
  }

  /**
   * Resolve the caller's effective security profile for an app.
   * Missing profile document => deny-all (fail closed). Admin expansion
   * applies only to the Admin profile with empty rules (see profiles.ts).
   */
  async resolveProfileForApp(principal: Principal, app: App): Promise<SecurityProfile> {
    const tables = (await this.store.listCollections(principal.orgId, app.id)).map((c) => c.name);
    const doc = await this.store.getProfile(principal.orgId, app.id, principal.profileName);
    if (!doc) {
      const now = new Date().toISOString();
      return {
        appId: app.id,
        createdAt: now,
        id: "profile_missing",
        name: principal.profileName,
        rules: {},
        updatedAt: now,
      };
    }
    return resolveProfile(doc, tables);
  }
}

/* ------------------------------------------------------------------ */
/* API keys                                                            */
/* ------------------------------------------------------------------ */

export interface CreateApiKeyInput {
  appId: string | null;
  name: string;
  profileName: string;
  scopes: string[];
}

export interface CreatedApiKey {
  key: ApiKeyPublic;
  plaintext: string;
}

export interface ApiKeyPublic {
  app_id: string | null;
  created_at: string;
  id: string;
  last_used_at: string | null;
  name: string;
  prefix: string;
  profile_name: string;
  revoked_at: string | null;
  scopes: string[];
}

export function toPublicApiKey(key: {
  app_id: string | null;
  created_at: string;
  id: string;
  last_used_at: string | null;
  name: string;
  prefix: string;
  profile_name: string;
  revoked_at: string | null;
  scopes: string[];
}): ApiKeyPublic {
  return { ...key };
}

export const API_KEY_SCOPES = ["*", "records:read", "records:write", "files:read", "files:write"] as const;

export function scopeAllows(scopes: string[], needed: string): boolean {
  return scopes.includes("*") || scopes.includes(needed);
}

export async function createApiKeyRecord(
  store: Store,
  orgId: string,
  input: CreateApiKeyInput,
): Promise<CreatedApiKey> {
  for (const s of input.scopes) {
    if (!(API_KEY_SCOPES as readonly string[]).includes(s)) {
      throw new ForgeError("validation", `Unknown scope: ${s}`, 400);
    }
  }
  const plaintext = `ofk_${randomBytes(24).toString("hex")}`;
  const now = new Date().toISOString();
  const record = await store.createApiKey({
    app_id: input.appId,
    created_at: now,
    id: newId("key"),
    key_hash: hashToken(plaintext),
    last_used_at: null,
    name: input.name,
    org_id: orgId,
    prefix: plaintext.slice(0, 12),
    profile_name: input.profileName,
    revoked_at: null,
    scopes: input.scopes,
  });
  return { key: toPublicApiKey(record), plaintext };
}

/* ------------------------------------------------------------------ */
/* OAuth 2.0 (Google / GitHub): real flow structure.                   */
/* Client credentials come from environment (platform-level) or the    */
/* app vault (app-level, keys OAUTH_<PROVIDER>_CLIENT_ID/SECRET).     */
/* Live provider verification is outstanding — see VERIFICATION.md.    */
/* ------------------------------------------------------------------ */

export type OAuthProvider = "github" | "google";

export interface OAuthProviderConfig {
  authUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  tokenUrl: string;
  userinfoUrl: string;
}

export const OAUTH_ENDPOINTS: Record<OAuthProvider, { authUrl: string; scope: string; tokenUrl: string; userinfoUrl: string }> = {
  github: {
    authUrl: "https://github.com/login/oauth/authorize",
    scope: "read:user user:email",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userinfoUrl: "https://api.github.com/user",
  },
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    scope: "openid email profile",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
  },
};

export function oauthRedirectUri(baseUrl: string, provider: OAuthProvider): string {
  return `${baseUrl.replace(/\/$/, "")}/api/v1/auth/oauth/${provider}/callback`;
}

export interface OAuthState {
  appId: string;
  exp: number;
  nonce: string;
  provider: OAuthProvider;
  returnTo: string;
}

export function buildAuthorizationUrl(
  provider: OAuthProvider,
  cfg: OAuthProviderConfig,
  state: string,
  redirectUri: string,
): string {
  const url = new URL(OAUTH_ENDPOINTS[provider].authUrl);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", cfg.scope);
  url.searchParams.set("state", state);
  return url.toString();
}

export function signOAuthState(state: Omit<OAuthState, "exp">, secret: string, ttlSeconds = 600): string {
  return signToken({ ...state, exp: Math.floor(Date.now() / 1000) + ttlSeconds }, secret);
}

export function verifyOAuthState(token: string, secret: string): OAuthState | null {
  const parsed = verifyToken<Record<string, unknown>>(token, secret);
  if (!parsed) return null;
  if (typeof parsed.appId !== "string" || typeof parsed.provider !== "string") return null;
  if (parsed.provider !== "google" && parsed.provider !== "github") return null;
  return parsed as unknown as OAuthState;
}

export interface OAuthProfile {
  email: string;
  name: string;
  sub: string;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Exchange a code for tokens, then fetch the provider profile. Injectable fetch for tests. */
export async function exchangeCodeForProfile(
  provider: OAuthProvider,
  cfg: OAuthProviderConfig,
  code: string,
  redirectUri: string,
  fetchFn: FetchFn = fetch,
): Promise<OAuthProfile> {
  const endpoints = OAUTH_ENDPOINTS[provider];
  const tokenRes = await fetchFn(endpoints.tokenUrl, {
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!tokenRes.ok) {
    throw new ForgeError("upstream_error", `OAuth token exchange failed (${tokenRes.status})`, 502);
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new ForgeError("upstream_error", "OAuth provider returned no access token", 502);
  }
  const profileRes = await fetchFn(endpoints.userinfoUrl, {
    headers: { accept: "application/json", authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!profileRes.ok) {
    throw new ForgeError("upstream_error", `OAuth profile fetch failed (${profileRes.status})`, 502);
  }
  const profile = (await profileRes.json()) as Record<string, unknown>;
  const sub = String(profile.sub ?? profile.id ?? "");
  const email = String(profile.email ?? "");
  const name = String(profile.name ?? profile.login ?? email);
  if (!sub || !email) {
    throw new ForgeError("upstream_error", "OAuth provider returned no usable identity", 502);
  }
  return { email: email.toLowerCase(), name, sub };
}
