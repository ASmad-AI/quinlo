/**
 * Typed client for the backend REST API. All requests are same-origin
 * with cookie auth; mutations carry the double-submit CSRF token.
 */
import { BRANDING } from "./branding";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface PublicUser {
  created_at: string;
  email: string;
  id: string;
  name: string;
  org_id: string;
  profile_name: string;
}

export interface AppSummary {
  auth_config: { oauth: string[]; orgIsolation: boolean; providers: string[] };
  created_at: string;
  description: string;
  id: string;
  name: string;
  slug: string;
  updated_at: string;
}

export interface AttributeDef {
  default?: unknown;
  name: string;
  required: boolean;
  type: "string" | "number" | "boolean" | "datetime" | "json";
}

export interface CollectionSchema {
  attributes: AttributeDef[];
  created_at: string;
  id: string;
  indexes: Array<{ fields: string[]; unique?: boolean }>;
  name: string;
}

export interface RecordRow {
  app_id: string;
  collection: string;
  created_at: string;
  created_by: string;
  id: string;
  org_id: string;
  updated_at: string;
  [key: string]: unknown;
}

export type RowConditionOp = "eq" | "ne" | "in" | "not_in" | "exists" | "is_null";
export interface RowCondition {
  field: string;
  op: RowConditionOp;
  value?: unknown;
}
export interface FieldRule {
  denyFields?: string[];
  fields: string[] | "*";
  row?: RowCondition[];
}
export interface TableRule {
  create?: FieldRule | false;
  delete?: boolean | RowCondition[];
  read?: FieldRule | false;
  update?: FieldRule | false;
}
export interface SecurityProfile {
  appId: string;
  createdAt: string;
  description?: string;
  id: string;
  isDefault?: boolean;
  name: string;
  rules: Record<string, TableRule>;
  updatedAt: string;
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

export interface FileEntry {
  path: string;
  size: number;
  updated_at: string;
}

export interface FunctionSummary {
  name: string;
  updated_at: string;
}

export interface Deployment {
  created_at: string;
  environment: "staging" | "production";
  /** Number of files in the snapshot (the list endpoint returns a count). */
  files: number;
  id: string;
  promoted_from: string | null;
  status: "live" | "superseded";
}

export interface Domain {
  created_at: string;
  environment: "staging" | "production";
  hostname: string;
  id: string;
  status: string;
}

export interface BillingPlan {
  currency: string;
  id: string;
  interval: "month" | "year";
  mode: "test" | "live";
  name: string;
  price_cents: number;
  stripe_price_id: string | null;
  stripe_product_id: string | null;
}

export interface WebhookEndpoint {
  created_at: string;
  events: string[];
  id: string;
  secret: string;
  url: string;
}

export interface WebhookDelivery {
  attempts: number;
  created_at: string;
  endpoint_id: string;
  event: string;
  id: string;
  last_error: string | null;
  status: "pending" | "delivered" | "failed";
}

export interface AuditEntry {
  action: string;
  actorId: string;
  actorType: string;
  appId?: string;
  detail?: Record<string, unknown>;
  id: string;
  orgId: string;
  timestamp: string;
}

export interface GithubLink {
  branch: string;
  id: string;
  remote_url: string;
}

export interface GithubStatus {
  ahead: number;
  behind: number;
  clean: boolean;
  conflicted: string[];
  modified: string[];
  sha: string | null;
}

let csrfToken: string | null = null;

function readCsrfCookie(): string | null {
  const match = document.cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("of_csrf="));
  return match ? decodeURIComponent(match.slice("of_csrf=".length)) : null;
}

export async function ensureCsrf(): Promise<string> {
  const fromCookie = readCsrfCookie();
  if (fromCookie) {
    csrfToken = fromCookie;
    return fromCookie;
  }
  if (csrfToken) return csrfToken;
  const res = await fetch("/api/v1/auth/csrf", { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, "Could not obtain a CSRF token");
  const data = (await res.json()) as { csrfToken: string };
  csrfToken = data.csrfToken;
  return csrfToken;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") {
    headers["x-csrf-token"] = await ensureCsrf();
  }
  const res = await fetch(path, { ...init, credentials: "same-origin", headers });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message =
      (data as { error?: { message?: string } } | null)?.error?.message ??
      (data as { message?: string } | null)?.message ??
      `Request failed (${res.status})`;
    // A stale CSRF token after rotation: refresh once and retry.
    if (res.status === 403 && /csrf/i.test(message) && method !== "GET") {
      csrfToken = null;
      document.cookie = "of_csrf=; Max-Age=0; path=/";
      headers["x-csrf-token"] = await ensureCsrf();
      const retry = await fetch(path, { ...init, credentials: "same-origin", headers });
      if (retry.status === 204) return undefined as T;
      const retryText = await retry.text();
      if (!retry.ok) {
        throw new ApiError(retry.status, message);
      }
      return (retryText ? JSON.parse(retryText) : null) as T;
    }
    throw new ApiError(res.status, message);
  }
  return data as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { body: body === undefined ? undefined : JSON.stringify(body), method: "POST" });
const put = <T>(path: string, body: unknown) => request<T>(path, { body: JSON.stringify(body), method: "PUT" });
const patch = <T>(path: string, body: unknown) => request<T>(path, { body: JSON.stringify(body), method: "PATCH" });
const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

/** Fetch a plain-text endpoint (the generated Caddyfile). */
async function requestText(path: string): Promise<string> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, `Request failed (${res.status})`);
  return res.text();
}

export const api = {
  // Auth
  login: (email: string, password: string) => post<{ user: PublicUser }>("/api/v1/auth/login", { email, password }),
  logout: () => post("/api/v1/auth/logout"),
  me: () => get<{ user: PublicUser }>("/api/v1/auth/me"),
  signup: (name: string, email: string, password: string, orgName: string) =>
    post<{ user: PublicUser }>("/api/v1/auth/signup", { email, name, orgName, password }),

  // Apps
  createApp: (name: string, description: string) => post<{ app: AppSummary }>("/api/v1/apps", { description, name }),
  deleteApp: (appId: string) => del(`/api/v1/apps/${appId}`),
  getApp: (appId: string) => get<{ app: AppSummary }>(`/api/v1/apps/${appId}`),
  listApps: (q = "") => get<{ apps: AppSummary[] }>(`/api/v1/apps${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  updateApp: (appId: string, body: { description?: string; name?: string }) =>
    patch<{ app: AppSummary }>(`/api/v1/apps/${appId}`, body),

  // Schema + records (record bodies are the field values directly).
  createCollection: (appId: string, body: { attributes: AttributeDef[]; indexes?: CollectionSchema["indexes"]; name: string }) =>
    post<{ collection: CollectionSchema }>(`/api/v1/apps/${appId}/collections`, body),
  createRecord: (appId: string, collection: string, fields: Record<string, unknown>) =>
    post<{ record: RecordRow }>(`/api/v1/apps/${appId}/records/${collection}`, fields),
  deleteCollection: (appId: string, name: string) => del(`/api/v1/apps/${appId}/collections/${name}`),
  deleteRecord: (appId: string, collection: string, id: string) => del(`/api/v1/apps/${appId}/records/${collection}/${id}`),
  getSchema: (appId: string) => get<{ collections: CollectionSchema[] }>(`/api/v1/apps/${appId}/schema`),
  listRecords: (appId: string, collection: string) =>
    get<{ records: RecordRow[]; total: number }>(`/api/v1/apps/${appId}/records/${collection}`),
  updateRecord: (appId: string, collection: string, id: string, fields: Record<string, unknown>) =>
    patch<{ record: RecordRow }>(`/api/v1/apps/${appId}/records/${collection}/${id}`, fields),

  // Profiles, keys, secrets
  assignProfile: (appId: string, profileId: string, userId: string) =>
    post(`/api/v1/apps/${appId}/profiles/${profileId}/assign`, { userId }),
  createApiKey: (appId: string, body: { name: string; profileName: string; scopes: string[] }) =>
    post<{ apiKey: ApiKeyPublic; plaintext: string }>(`/api/v1/apps/${appId}/api-keys`, body),
  createProfile: (appId: string, body: { description?: string; name: string; rules: Record<string, TableRule> }) =>
    post<{ profile: SecurityProfile }>(`/api/v1/apps/${appId}/profiles`, body),
  deleteProfile: (appId: string, profileId: string) => del(`/api/v1/apps/${appId}/profiles/${profileId}`),
  deleteSecret: (appId: string, key: string) => del(`/api/v1/apps/${appId}/secrets/${encodeURIComponent(key)}`),
  listApiKeys: (appId: string) => get<{ apiKeys: ApiKeyPublic[] }>(`/api/v1/apps/${appId}/api-keys`),
  listProfiles: (appId: string) => get<{ profiles: SecurityProfile[] }>(`/api/v1/apps/${appId}/profiles`),
  listSecrets: (appId: string) => get<{ secrets: string[] }>(`/api/v1/apps/${appId}/secrets`),
  revokeApiKey: (appId: string, keyId: string) => post(`/api/v1/apps/${appId}/api-keys/${keyId}/revoke`),
  setSecret: (appId: string, key: string, value: string) => post(`/api/v1/apps/${appId}/secrets`, { key, value }),
  updateProfile: (appId: string, profileId: string, body: { description?: string; name: string; rules: Record<string, TableRule> }) =>
    put<{ profile: SecurityProfile }>(`/api/v1/apps/${appId}/profiles/${profileId}`, body),

  // Files
  deleteFile: (appId: string, path: string) => del(`/api/v1/apps/${appId}/file?path=${encodeURIComponent(path)}`),
  listFiles: (appId: string) => get<{ files: FileEntry[] }>(`/api/v1/apps/${appId}/files`),
  readFile: (appId: string, path: string) => get<{ content: string; path: string }>(`/api/v1/apps/${appId}/file?path=${encodeURIComponent(path)}`),
  writeFile: (appId: string, path: string, content: string) =>
    put(`/api/v1/apps/${appId}/file`, { content, path }),

  // Functions (the list endpoint returns names only; code is write-only).
  createFunction: (appId: string, body: { code: string; name: string }) =>
    post<{ function: { name: string } }>(`/api/v1/apps/${appId}/functions`, body),
  deleteFunction: (appId: string, name: string) => del(`/api/v1/apps/${appId}/functions/${encodeURIComponent(name)}`),
  invokeFunction: (appId: string, name: string, input: unknown) =>
    post<{ logs: string[]; output: unknown }>(`/api/v1/apps/${appId}/functions/${encodeURIComponent(name)}/invoke`, { input }),
  listFunctions: (appId: string) => get<{ functions: FunctionSummary[] }>(`/api/v1/apps/${appId}/functions`),

  // Deploy + domains + GitHub + eject
  deploy: (appId: string, environment: "staging" | "production") =>
    post<{ deployment: { id: string }; url: string }>(`/api/v1/apps/${appId}/deploy`, { environment }),
  getCaddyfile: (appId: string) => requestText(`/api/v1/apps/${appId}/caddyfile`),
  getGithubLink: (appId: string) => get<{ link: GithubLink | null }>(`/api/v1/apps/${appId}/github`),
  getPreviewUrl: (appId: string, environment: "staging" | "production") =>
    get<{ url: string }>(`/api/v1/apps/${appId}/preview-url?environment=${environment}`),
  linkGithub: (appId: string, remoteUrl: string, branch: string) =>
    post<{ link: GithubLink }>(`/api/v1/apps/${appId}/github`, { branch, remoteUrl }),
  listDeployments: (appId: string) => get<{ deployments: Deployment[] }>(`/api/v1/apps/${appId}/deployments`),
  listDomains: (appId: string) => get<{ domains: Domain[] }>(`/api/v1/apps/${appId}/domains`),
  addDomain: (appId: string, hostname: string, environment: "staging" | "production") =>
    post<{ domain: Domain }>(`/api/v1/apps/${appId}/domains`, { environment, hostname }),
  deleteDomain: (appId: string, id: string) => del(`/api/v1/apps/${appId}/domains/${id}`),
  githubPull: (appId: string) => post<{ conflicted: string[]; imported: string[]; pulled: boolean }>(`/api/v1/apps/${appId}/github/pull`),
  githubPush: (appId: string, message: string) =>
    post<{ pushed: boolean; sha: string | null }>(`/api/v1/apps/${appId}/github/push`, { message }),
  githubStatus: (appId: string) => get<GithubStatus>(`/api/v1/apps/${appId}/github/status`),
  promote: (appId: string) => post<{ deployment: { id: string }; url: string }>(`/api/v1/apps/${appId}/promote`),

  // Billing (plans are set as a batch; usage returns computed totals).
  createPlans: (appId: string, plans: Array<{ currency?: string; interval: "month" | "year"; name: string; price_cents: number }>) =>
    post<{ plans: BillingPlan[] }>(`/api/v1/apps/${appId}/billing/plans`, { plans }),
  listPlans: (appId: string) => get<{ plans: BillingPlan[] }>(`/api/v1/apps/${appId}/billing/plans`),
  listSubscriptions: (appId: string) => get<{ subscriptions: Array<Record<string, unknown>> }>(`/api/v1/apps/${appId}/billing/subscriptions`),
  recordUsage: (appId: string, body: { quantity: number; subscriptionId: string }) =>
    post(`/api/v1/apps/${appId}/billing/usage`, body),
  usageSummary: (appId: string) => get<{ totals: unknown }>(`/api/v1/apps/${appId}/billing/usage`),

  // Webhooks (secrets are masked in list responses).
  createWebhook: (appId: string, body: { events: string[]; url: string }) =>
    post<{ webhook: WebhookEndpoint }>(`/api/v1/apps/${appId}/webhooks`, body),
  deleteWebhook: (appId: string, id: string) => del(`/api/v1/apps/${appId}/webhooks/${id}`),
  listDeliveries: (appId: string, id: string) => get<{ deliveries: WebhookDelivery[] }>(`/api/v1/apps/${appId}/webhooks/${id}/deliveries`),
  listWebhooks: (appId: string) => get<{ webhooks: WebhookEndpoint[] }>(`/api/v1/apps/${appId}/webhooks`),
  testWebhook: (appId: string, id: string, event: string) =>
    post<Record<string, unknown>>(`/api/v1/apps/${appId}/webhooks/${id}/test`, { event }),

  // Audit
  listAudit: (appId: string) => get<{ events: AuditEntry[] }>(`/api/v1/apps/${appId}/audit`),

  // Eject: POST returns a TAR download; handled with raw fetch in the view.
  ejectUrl: (appId: string) => `/api/v1/apps/${appId}/eject`,
  ejectCsrf: () => ensureCsrf(),
};

export const MCP_CONNECT_URL = `${window.location.origin}${BRANDING.mcpPath}`;
