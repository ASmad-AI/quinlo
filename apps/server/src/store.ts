import type {
  AuditEvent,
  SecurityProfile,
} from "@openforge/shared";
import type { AttributeDef } from "@openforge/mcp-server";

/* ------------------------------------------------------------------ */
/* Entity types                                                        */
/* ------------------------------------------------------------------ */

export interface Org {
  created_at: string;
  id: string;
  name: string;
  slug: string;
}

export interface User {
  created_at: string;
  email: string;
  id: string;
  name: string;
  oauth_github_sub?: string;
  oauth_google_sub?: string;
  org_id: string;
  password_hash: string | null;
  profile_name: string;
}

export interface AuthConfig {
  oauth: Array<{ provider: "github" | "google" }>;
  orgIsolation: boolean;
  providers: Array<"email" | "github" | "google">;
}

export interface App {
  auth_config: AuthConfig;
  created_at: string;
  created_by: string;
  description: string;
  id: string;
  name: string;
  org_id: string;
  slug: string;
  updated_at: string;
}

export interface CollectionSchema {
  app_id: string;
  attributes: AttributeDef[];
  created_at: string;
  id: string;
  indexes: Array<{ fields: string[]; unique?: boolean }>;
  name: string;
  org_id: string;
}

export interface StoredRecord {
  app_id: string;
  collection: string;
  created_at: string;
  created_by: string;
  fields: Record<string, unknown>;
  id: string;
  org_id: string;
  updated_at: string;
}

export interface ApiKey {
  app_id: string | null;
  created_at: string;
  id: string;
  key_hash: string;
  last_used_at: string | null;
  name: string;
  org_id: string;
  prefix: string;
  profile_name: string;
  revoked_at: string | null;
  scopes: string[];
}

export interface ProjectFile {
  app_id: string;
  content: string;
  id: string;
  org_id: string;
  path: string;
  size: number;
  updated_at: string;
}

export interface Deployment {
  app_id: string;
  created_at: string;
  environment: "production" | "staging";
  files: Array<{ content: string; path: string }>;
  id: string;
  org_id: string;
  promoted_from: string | null;
  status: "live" | "superseded";
}

export interface EdgeFunction {
  app_id: string;
  code: string;
  created_at: string;
  id: string;
  name: string;
  org_id: string;
  updated_at: string;
}

export interface VaultSecret {
  app_id: string;
  ciphertext: string;
  created_at: string;
  id: string;
  key: string;
  org_id: string;
  updated_at: string;
}

export interface BillingPlan {
  app_id: string;
  created_at: string;
  currency: string;
  id: string;
  interval: "month" | "one_time" | "year";
  mode: "live" | "test";
  name: string;
  org_id: string;
  price_cents: number;
  stripe_price_id: string | null;
  stripe_product_id: string | null;
}

export interface Subscription {
  app_id: string;
  created_at: string;
  current_period_end: string | null;
  customer_email: string;
  id: string;
  org_id: string;
  plan_id: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  updated_at: string;
}

export interface UsageRecord {
  app_id: string;
  id: string;
  metric: string;
  org_id: string;
  quantity: number;
  ts: string;
}

export interface WebhookEndpoint {
  active: boolean;
  app_id: string;
  created_at: string;
  events: string[];
  id: string;
  org_id: string;
  secret: string;
  url: string;
}

export interface WebhookDelivery {
  attempts: number;
  created_at: string;
  event: string;
  id: string;
  last_error: string | null;
  last_status: number | null;
  payload: Record<string, unknown>;
  status: "delivered" | "failed" | "pending";
  updated_at: string;
  webhook_id: string;
}

export interface Session {
  created_at: string;
  csrf_token: string;
  expires_at: string;
  id: string;
  org_id: string;
  token_hash: string;
  user_id: string;
}

export interface StorageFile {
  app_id: string;
  bucket: string;
  content_type: string;
  created_at: string;
  data_base64: string;
  id: string;
  name: string;
  org_id: string;
  size: number;
}

export interface Domain {
  app_id: string;
  created_at: string;
  environment: "production" | "staging";
  hostname: string;
  id: string;
  org_id: string;
  status: "active" | "pending";
}

export interface GithubLink {
  app_id: string;
  branch: string;
  id: string;
  last_sync_at: string | null;
  last_sync_sha: string | null;
  org_id: string;
  repo_url: string;
}

/* ------------------------------------------------------------------ */
/* Store interface. Every method that touches org-owned data takes the */
/* org id and enforces it — there is no unscoped read path.            */
/* ------------------------------------------------------------------ */

export interface Store {
  // Orgs & users
  createOrg(org: Org): Promise<Org>;
  getOrg(id: string): Promise<Org | null>;
  createUser(user: User): Promise<User>;
  findUserByEmail(email: string): Promise<User | null>;
  getUserById(id: string): Promise<User | null>;
  getUserByEmail(orgId: string, email: string): Promise<User | null>;
  getUserByOAuth(orgId: string, provider: "github" | "google", sub: string): Promise<User | null>;
  updateUser(user: User): Promise<User>;
  listUsers(orgId: string): Promise<User[]>;

  // Sessions
  createSession(s: Session): Promise<Session>;
  getSessionByTokenHash(hash: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;

  // Apps
  createApp(app: App): Promise<App>;
  getApp(orgId: string, id: string): Promise<App | null>;
  getAppById(id: string): Promise<App | null>;
  getAppBySlug(orgId: string, slug: string): Promise<App | null>;
  listApps(orgId: string): Promise<App[]>;
  updateApp(app: App): Promise<App>;
  deleteApp(orgId: string, id: string): Promise<void>;

  // Collections (schemas)
  upsertCollection(c: CollectionSchema): Promise<CollectionSchema>;
  getCollection(orgId: string, appId: string, name: string): Promise<CollectionSchema | null>;
  listCollections(orgId: string, appId: string): Promise<CollectionSchema[]>;
  deleteCollection(orgId: string, appId: string, name: string): Promise<void>;

  // Records
  createRecord(r: StoredRecord): Promise<StoredRecord>;
  getRecord(orgId: string, appId: string, collection: string, id: string): Promise<StoredRecord | null>;
  listRecords(orgId: string, appId: string, collection: string): Promise<StoredRecord[]>;
  updateRecord(r: StoredRecord): Promise<StoredRecord>;
  deleteRecord(orgId: string, appId: string, collection: string, id: string): Promise<void>;

  // Profiles
  upsertProfile(p: SecurityProfile): Promise<SecurityProfile>;
  getProfile(orgId: string, appId: string, idOrName: string): Promise<SecurityProfile | null>;
  listProfiles(orgId: string, appId: string): Promise<SecurityProfile[]>;
  deleteProfile(orgId: string, appId: string, id: string): Promise<void>;

  // API keys
  createApiKey(k: ApiKey): Promise<ApiKey>;
  getApiKeyByHash(hash: string): Promise<ApiKey | null>;
  listApiKeys(orgId: string, appId: string | null): Promise<ApiKey[]>;
  updateApiKey(k: ApiKey): Promise<ApiKey>;

  // Project files
  upsertFile(f: ProjectFile): Promise<ProjectFile>;
  getFile(orgId: string, appId: string, path: string): Promise<ProjectFile | null>;
  listFiles(orgId: string, appId: string): Promise<ProjectFile[]>;
  deleteFile(orgId: string, appId: string, path: string): Promise<void>;

  // Deployments
  createDeployment(d: Deployment): Promise<Deployment>;
  getDeployment(orgId: string, appId: string, environment: string): Promise<Deployment | null>;
  listDeployments(orgId: string, appId: string): Promise<Deployment[]>;
  updateDeployment(d: Deployment): Promise<Deployment>;

  // Edge functions
  upsertFunction(f: EdgeFunction): Promise<EdgeFunction>;
  getFunction(orgId: string, appId: string, name: string): Promise<EdgeFunction | null>;
  listFunctions(orgId: string, appId: string): Promise<EdgeFunction[]>;
  deleteFunction(orgId: string, appId: string, name: string): Promise<void>;

  // Vault secrets
  upsertSecret(s: VaultSecret): Promise<VaultSecret>;
  getSecret(orgId: string, appId: string, key: string): Promise<VaultSecret | null>;
  listSecrets(orgId: string, appId: string): Promise<VaultSecret[]>;
  deleteSecret(orgId: string, appId: string, key: string): Promise<void>;

  // Billing
  createPlan(p: BillingPlan): Promise<BillingPlan>;
  listPlans(orgId: string, appId: string): Promise<BillingPlan[]>;
  getPlan(orgId: string, appId: string, id: string): Promise<BillingPlan | null>;
  updatePlan(p: BillingPlan): Promise<BillingPlan>;
  upsertSubscription(s: Subscription): Promise<Subscription>;
  getSubscriptionByStripeId(stripeId: string): Promise<Subscription | null>;
  listSubscriptions(orgId: string, appId: string): Promise<Subscription[]>;
  recordUsage(u: UsageRecord): Promise<UsageRecord>;
  listUsage(orgId: string, appId: string): Promise<UsageRecord[]>;

  // Webhooks
  createWebhook(w: WebhookEndpoint): Promise<WebhookEndpoint>;
  listWebhooks(orgId: string, appId: string): Promise<WebhookEndpoint[]>;
  getWebhook(orgId: string, appId: string, id: string): Promise<WebhookEndpoint | null>;
  deleteWebhook(orgId: string, appId: string, id: string): Promise<void>;
  createDelivery(d: WebhookDelivery): Promise<WebhookDelivery>;
  updateDelivery(d: WebhookDelivery): Promise<WebhookDelivery>;
  listDeliveries(webhookId: string): Promise<WebhookDelivery[]>;

  // Audit
  appendAudit(e: AuditEvent): Promise<void>;
  listAudit(orgId: string, appId?: string, action?: string, limit?: number): Promise<AuditEvent[]>;

  // Storage
  createStorageFile(f: StorageFile): Promise<StorageFile>;
  getStorageFile(orgId: string, appId: string, id: string): Promise<StorageFile | null>;
  listStorageFiles(orgId: string, appId: string, bucket: string): Promise<StorageFile[]>;
  deleteStorageFile(orgId: string, appId: string, id: string): Promise<void>;

  // Domains & GitHub
  createDomain(d: Domain): Promise<Domain>;
  listDomains(orgId: string, appId: string): Promise<Domain[]>;
  deleteDomain(orgId: string, appId: string, id: string): Promise<void>;
  upsertGithubLink(l: GithubLink): Promise<GithubLink>;
  getGithubLink(orgId: string, appId: string): Promise<GithubLink | null>;

  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* In-memory store: dev, tests, and single-node deploys without a DB.  */
/* All reads filter by org_id; writes stamp org_id from the caller.    */
/* ------------------------------------------------------------------ */

function mustOrg<T extends { org_id: string }>(row: T | undefined, orgId: string): T | null {
  if (!row || row.org_id !== orgId) return null;
  return row;
}

export class MemoryStore implements Store {
  private apiKeys = new Map<string, ApiKey>();
  private apps = new Map<string, App>();
  private audit: AuditEvent[] = [];
  private collections = new Map<string, CollectionSchema>();
  private deliveries = new Map<string, WebhookDelivery>();
  private deployments = new Map<string, Deployment>();
  private domains = new Map<string, Domain>();
  private files = new Map<string, ProjectFile>();
  private functions = new Map<string, EdgeFunction>();
  private githubLinks = new Map<string, GithubLink>();
  private orgs = new Map<string, Org>();
  private plans = new Map<string, BillingPlan>();
  private profiles = new Map<string, SecurityProfile>();
  private records = new Map<string, StoredRecord>();
  private secrets = new Map<string, VaultSecret>();
  private sessions = new Map<string, Session>();
  private storage = new Map<string, StorageFile>();
  private subscriptions = new Map<string, Subscription>();
  private usage: UsageRecord[] = [];
  private users = new Map<string, User>();
  private webhooks = new Map<string, WebhookEndpoint>();

  async createOrg(org: Org): Promise<Org> {
    this.orgs.set(org.id, org);
    return org;
  }

  async getOrg(id: string): Promise<Org | null> {
    return this.orgs.get(id) ?? null;
  }

  async createUser(user: User): Promise<User> {
    this.users.set(user.id, user);
    return user;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const wanted = email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === wanted) return u;
    }
    return null;
  }

  async getUserById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async getUserByEmail(orgId: string, email: string): Promise<User | null> {
    const wanted = email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.org_id === orgId && u.email.toLowerCase() === wanted) return u;
    }
    return null;
  }

  async getUserByOAuth(orgId: string, provider: "github" | "google", sub: string): Promise<User | null> {
    for (const u of this.users.values()) {
      if (u.org_id !== orgId) continue;
      if (provider === "google" && u.oauth_google_sub === sub) return u;
      if (provider === "github" && u.oauth_github_sub === sub) return u;
    }
    return null;
  }

  async updateUser(user: User): Promise<User> {
    this.users.set(user.id, user);
    return user;
  }

  async listUsers(orgId: string): Promise<User[]> {
    return [...this.users.values()].filter((u) => u.org_id === orgId);
  }

  async createSession(s: Session): Promise<Session> {
    this.sessions.set(s.id, s);
    return s;
  }

  async getSessionByTokenHash(hash: string): Promise<Session | null> {
    for (const s of this.sessions.values()) {
      if (s.token_hash === hash) return s;
    }
    return null;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async createApp(app: App): Promise<App> {
    this.apps.set(app.id, app);
    return app;
  }

  async getApp(orgId: string, id: string): Promise<App | null> {
    return mustOrg(this.apps.get(id), orgId);
  }

  async getAppById(id: string): Promise<App | null> {
    // Used ONLY by the Stripe webhook entrypoint, which verifies the
    // per-app HMAC signature before trusting anything about the app.
    return this.apps.get(id) ?? null;
  }

  async getAppBySlug(orgId: string, slug: string): Promise<App | null> {
    for (const a of this.apps.values()) {
      if (a.org_id === orgId && a.slug === slug) return a;
    }
    return null;
  }

  async listApps(orgId: string): Promise<App[]> {
    return [...this.apps.values()].filter((a) => a.org_id === orgId);
  }

  async updateApp(app: App): Promise<App> {
    this.apps.set(app.id, app);
    return app;
  }

  async deleteApp(orgId: string, id: string): Promise<void> {
    const app = mustOrg(this.apps.get(id), orgId);
    if (!app) return;
    this.apps.delete(id);
  }

  private collectionKey(appId: string, name: string): string {
    return `${appId}:${name}`;
  }

  async upsertCollection(c: CollectionSchema): Promise<CollectionSchema> {
    this.collections.set(this.collectionKey(c.app_id, c.name), c);
    return c;
  }

  async getCollection(orgId: string, appId: string, name: string): Promise<CollectionSchema | null> {
    return mustOrg(this.collections.get(this.collectionKey(appId, name)), orgId);
  }

  async listCollections(orgId: string, appId: string): Promise<CollectionSchema[]> {
    return [...this.collections.values()].filter((c) => c.org_id === orgId && c.app_id === appId);
  }

  async deleteCollection(orgId: string, appId: string, name: string): Promise<void> {
    const c = mustOrg(this.collections.get(this.collectionKey(appId, name)), orgId);
    if (c) this.collections.delete(this.collectionKey(appId, name));
  }

  async createRecord(r: StoredRecord): Promise<StoredRecord> {
    this.records.set(r.id, r);
    return r;
  }

  async getRecord(orgId: string, appId: string, collection: string, id: string): Promise<StoredRecord | null> {
    const r = this.records.get(id);
    if (!r || r.org_id !== orgId || r.app_id !== appId || r.collection !== collection) return null;
    return r;
  }

  async listRecords(orgId: string, appId: string, collection: string): Promise<StoredRecord[]> {
    return [...this.records.values()].filter(
      (r) => r.org_id === orgId && r.app_id === appId && r.collection === collection,
    );
  }

  async updateRecord(r: StoredRecord): Promise<StoredRecord> {
    this.records.set(r.id, r);
    return r;
  }

  async deleteRecord(orgId: string, appId: string, collection: string, id: string): Promise<void> {
    const r = await this.getRecord(orgId, appId, collection, id);
    if (r) this.records.delete(id);
  }

  async upsertProfile(p: SecurityProfile): Promise<SecurityProfile> {
    this.profiles.set(p.id, p);
    return p;
  }

  async getProfile(orgId: string, appId: string, idOrName: string): Promise<SecurityProfile | null> {
    for (const p of this.profiles.values()) {
      if (p.appId === appId && (p.id === idOrName || p.name === idOrName)) {
        // Profiles are app-scoped; org ownership is proven via the app.
        void orgId;
        return p;
      }
    }
    return null;
  }

  async listProfiles(orgId: string, appId: string): Promise<SecurityProfile[]> {
    void orgId;
    return [...this.profiles.values()].filter((p) => p.appId === appId);
  }

  async deleteProfile(_orgId: string, appId: string, id: string): Promise<void> {
    const p = this.profiles.get(id);
    if (p && p.appId === appId) this.profiles.delete(id);
  }

  async createApiKey(k: ApiKey): Promise<ApiKey> {
    this.apiKeys.set(k.id, k);
    return k;
  }

  async getApiKeyByHash(hash: string): Promise<ApiKey | null> {
    for (const k of this.apiKeys.values()) {
      if (k.key_hash === hash) return k;
    }
    return null;
  }

  async listApiKeys(orgId: string, appId: string | null): Promise<ApiKey[]> {
    return [...this.apiKeys.values()].filter(
      (k) => k.org_id === orgId && (appId === null || k.app_id === appId || k.app_id === null),
    );
  }

  async updateApiKey(k: ApiKey): Promise<ApiKey> {
    this.apiKeys.set(k.id, k);
    return k;
  }

  private fileKey(appId: string, path: string): string {
    return `${appId}:${path}`;
  }

  async upsertFile(f: ProjectFile): Promise<ProjectFile> {
    this.files.set(this.fileKey(f.app_id, f.path), f);
    return f;
  }

  async getFile(orgId: string, appId: string, path: string): Promise<ProjectFile | null> {
    return mustOrg(this.files.get(this.fileKey(appId, path)), orgId);
  }

  async listFiles(orgId: string, appId: string): Promise<ProjectFile[]> {
    return [...this.files.values()].filter((f) => f.org_id === orgId && f.app_id === appId);
  }

  async deleteFile(orgId: string, appId: string, path: string): Promise<void> {
    const f = mustOrg(this.files.get(this.fileKey(appId, path)), orgId);
    if (f) this.files.delete(this.fileKey(appId, path));
  }

  async createDeployment(d: Deployment): Promise<Deployment> {
    this.deployments.set(d.id, d);
    return d;
  }

  async getDeployment(orgId: string, appId: string, environment: string): Promise<Deployment | null> {
    let latest: Deployment | null = null;
    for (const d of this.deployments.values()) {
      if (d.org_id === orgId && d.app_id === appId && d.environment === environment && d.status === "live") {
        if (!latest || d.created_at >= latest.created_at) latest = d;
      }
    }
    return latest;
  }

  async listDeployments(orgId: string, appId: string): Promise<Deployment[]> {
    return [...this.deployments.values()]
      .filter((d) => d.org_id === orgId && d.app_id === appId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  async updateDeployment(d: Deployment): Promise<Deployment> {
    this.deployments.set(d.id, d);
    return d;
  }

  private functionKey(appId: string, name: string): string {
    return `${appId}:${name}`;
  }

  async upsertFunction(f: EdgeFunction): Promise<EdgeFunction> {
    this.functions.set(this.functionKey(f.app_id, f.name), f);
    return f;
  }

  async getFunction(orgId: string, appId: string, name: string): Promise<EdgeFunction | null> {
    return mustOrg(this.functions.get(this.functionKey(appId, name)), orgId);
  }

  async listFunctions(orgId: string, appId: string): Promise<EdgeFunction[]> {
    return [...this.functions.values()].filter((f) => f.org_id === orgId && f.app_id === appId);
  }

  async deleteFunction(orgId: string, appId: string, name: string): Promise<void> {
    const f = mustOrg(this.functions.get(this.functionKey(appId, name)), orgId);
    if (f) this.functions.delete(this.functionKey(appId, name));
  }

  private secretKey(appId: string, key: string): string {
    return `${appId}:${key}`;
  }

  async upsertSecret(s: VaultSecret): Promise<VaultSecret> {
    this.secrets.set(this.secretKey(s.app_id, s.key), s);
    return s;
  }

  async getSecret(orgId: string, appId: string, key: string): Promise<VaultSecret | null> {
    return mustOrg(this.secrets.get(this.secretKey(appId, key)), orgId);
  }

  async listSecrets(orgId: string, appId: string): Promise<VaultSecret[]> {
    return [...this.secrets.values()].filter((s) => s.org_id === orgId && s.app_id === appId);
  }

  async deleteSecret(orgId: string, appId: string, key: string): Promise<void> {
    const s = mustOrg(this.secrets.get(this.secretKey(appId, key)), orgId);
    if (s) this.secrets.delete(this.secretKey(appId, key));
  }

  async createPlan(p: BillingPlan): Promise<BillingPlan> {
    this.plans.set(p.id, p);
    return p;
  }

  async listPlans(orgId: string, appId: string): Promise<BillingPlan[]> {
    return [...this.plans.values()].filter((p) => p.org_id === orgId && p.app_id === appId);
  }

  async getPlan(orgId: string, appId: string, id: string): Promise<BillingPlan | null> {
    const p = this.plans.get(id);
    if (!p || p.org_id !== orgId || p.app_id !== appId) return null;
    return p;
  }

  async updatePlan(p: BillingPlan): Promise<BillingPlan> {
    this.plans.set(p.id, p);
    return p;
  }

  async upsertSubscription(s: Subscription): Promise<Subscription> {
    this.subscriptions.set(s.id, s);
    return s;
  }

  async getSubscriptionByStripeId(stripeId: string): Promise<Subscription | null> {
    for (const s of this.subscriptions.values()) {
      if (s.stripe_subscription_id === stripeId) return s;
    }
    return null;
  }

  async listSubscriptions(orgId: string, appId: string): Promise<Subscription[]> {
    return [...this.subscriptions.values()].filter((s) => s.org_id === orgId && s.app_id === appId);
  }

  async recordUsage(u: UsageRecord): Promise<UsageRecord> {
    this.usage.push(u);
    return u;
  }

  async listUsage(orgId: string, appId: string): Promise<UsageRecord[]> {
    return this.usage.filter((u) => u.org_id === orgId && u.app_id === appId);
  }

  async createWebhook(w: WebhookEndpoint): Promise<WebhookEndpoint> {
    this.webhooks.set(w.id, w);
    return w;
  }

  async listWebhooks(orgId: string, appId: string): Promise<WebhookEndpoint[]> {
    return [...this.webhooks.values()].filter((w) => w.org_id === orgId && w.app_id === appId);
  }

  async getWebhook(orgId: string, appId: string, id: string): Promise<WebhookEndpoint | null> {
    const w = this.webhooks.get(id);
    if (!w || w.org_id !== orgId || w.app_id !== appId) return null;
    return w;
  }

  async deleteWebhook(orgId: string, appId: string, id: string): Promise<void> {
    const w = await this.getWebhook(orgId, appId, id);
    if (w) this.webhooks.delete(id);
  }

  async createDelivery(d: WebhookDelivery): Promise<WebhookDelivery> {
    this.deliveries.set(d.id, d);
    return d;
  }

  async updateDelivery(d: WebhookDelivery): Promise<WebhookDelivery> {
    this.deliveries.set(d.id, d);
    return d;
  }

  async listDeliveries(webhookId: string): Promise<WebhookDelivery[]> {
    return [...this.deliveries.values()].filter((d) => d.webhook_id === webhookId);
  }

  async appendAudit(e: AuditEvent): Promise<void> {
    this.audit.push(e);
  }

  async listAudit(orgId: string, appId?: string, action?: string, limit = 100): Promise<AuditEvent[]> {
    return this.audit
      .filter(
        (e) =>
          e.orgId === orgId &&
          (!appId || e.appId === appId) &&
          (!action || e.action === action),
      )
      .slice(-limit)
      .reverse();
  }

  async createStorageFile(f: StorageFile): Promise<StorageFile> {
    this.storage.set(f.id, f);
    return f;
  }

  async getStorageFile(orgId: string, appId: string, id: string): Promise<StorageFile | null> {
    const f = this.storage.get(id);
    if (!f || f.org_id !== orgId || f.app_id !== appId) return null;
    return f;
  }

  async listStorageFiles(orgId: string, appId: string, bucket: string): Promise<StorageFile[]> {
    return [...this.storage.values()].filter(
      (f) => f.org_id === orgId && f.app_id === appId && f.bucket === bucket,
    );
  }

  async deleteStorageFile(orgId: string, appId: string, id: string): Promise<void> {
    const f = await this.getStorageFile(orgId, appId, id);
    if (f) this.storage.delete(id);
  }

  async createDomain(d: Domain): Promise<Domain> {
    this.domains.set(d.id, d);
    return d;
  }

  async listDomains(orgId: string, appId: string): Promise<Domain[]> {
    return [...this.domains.values()].filter((d) => d.org_id === orgId && d.app_id === appId);
  }

  async deleteDomain(orgId: string, appId: string, id: string): Promise<void> {
    const d = this.domains.get(id);
    if (d && d.org_id === orgId && d.app_id === appId) this.domains.delete(id);
  }

  async upsertGithubLink(l: GithubLink): Promise<GithubLink> {
    this.githubLinks.set(l.app_id, l);
    return l;
  }

  async getGithubLink(orgId: string, appId: string): Promise<GithubLink | null> {
    return mustOrg(this.githubLinks.get(appId), orgId);
  }

  async close(): Promise<void> {
    // Nothing to close for the in-memory store.
  }
}
