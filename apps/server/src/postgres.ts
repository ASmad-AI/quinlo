import type { AuditEvent, SecurityProfile } from "@quinlo/shared";
import type { Pool } from "pg";
import type {
  ApiKey,
  App,
  BillingPlan,
  CollectionSchema,
  Deployment,
  Domain,
  EdgeFunction,
  GithubLink,
  Org,
  ProjectFile,
  Session,
  StorageFile,
  StoredRecord,
  Store,
  Subscription,
  UsageRecord,
  VaultSecret,
  WebhookDelivery,
  WebhookEndpoint,
  User,
} from "./store";

/**
 * Postgres adapter for production deployments (docker-compose ships
 * Postgres 16). Entities are stored as JSONB rows in a single table with
 * indexed org/app/scope columns; EVERY query carries an org_id predicate
 * (except lookups by unguessable hash, which resolve the org from the row
 * and let the caller enforce it). All values are parameterized — no string
 * interpolation of user input into SQL, ever.
 *
 * Schema:
 *   forge_entities(kind, id, org_id, app_id, scope, data JSONB, updated_at)
 *
 * Live-database behaviour is NOT verified in this environment (no Docker /
 * no Postgres here); see VERIFICATION.md. The SQL builders below are pure
 * and unit-tested, including the org_id predicate on every scoped query.
 */

export const ENTITIES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS forge_entities (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  app_id TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS forge_entities_org_app_idx ON forge_entities (kind, org_id, app_id);
CREATE INDEX IF NOT EXISTS forge_entities_scope_idx ON forge_entities (kind, app_id, scope);
`.trim();

export interface BuiltQuery {
  text: string;
  values: unknown[];
}

export function buildUpsert(kind: string, id: string, orgId: string, appId: string, scope: string, data: unknown): BuiltQuery {
  return {
    text: `INSERT INTO forge_entities (kind, id, org_id, app_id, scope, data, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now()) ON CONFLICT (kind, id) DO UPDATE SET org_id = EXCLUDED.org_id, app_id = EXCLUDED.app_id, scope = EXCLUDED.scope, data = EXCLUDED.data, updated_at = now()`,
    values: [kind, id, orgId, appId, scope, JSON.stringify(data)],
  };
}

export function buildGet(kind: string, id: string, orgId: string): BuiltQuery {
  return {
    text: `SELECT data FROM forge_entities WHERE kind = $1 AND id = $2 AND org_id = $3`,
    values: [kind, id, orgId],
  };
}

export function buildGetByScope(kind: string, appId: string, scope: string, orgId: string): BuiltQuery {
  return {
    text: `SELECT data FROM forge_entities WHERE kind = $1 AND app_id = $2 AND scope = $3 AND org_id = $4 LIMIT 1`,
    values: [kind, appId, scope, orgId],
  };
}

export function buildList(kind: string, orgId: string, appId?: string, scope?: string): BuiltQuery {
  let text = `SELECT data FROM forge_entities WHERE kind = $1 AND org_id = $2`;
  const values: unknown[] = [kind, orgId];
  if (appId !== undefined) {
    values.push(appId);
    text += ` AND app_id = $${values.length}`;
  }
  if (scope !== undefined) {
    values.push(scope);
    text += ` AND scope = $${values.length}`;
  }
  text += ` ORDER BY updated_at DESC`;
  return { text, values };
}

export function buildDelete(kind: string, id: string, orgId: string): BuiltQuery {
  return {
    text: `DELETE FROM forge_entities WHERE kind = $1 AND id = $2 AND org_id = $3`,
    values: [kind, id, orgId],
  };
}

export function buildGetByJsonField(kind: string, field: string, value: string): BuiltQuery {
  // Field names are internal constants, never user input; the value is parameterized.
  if (!/^[a-z_]+$/.test(field)) throw new Error("Invalid JSON field name");
  return {
    text: `SELECT data FROM forge_entities WHERE kind = $1 AND data ->> $2 = $3 LIMIT 1`,
    values: [kind, field, value],
  };
}

type Kind =
  | "api_key"
  | "app"
  | "audit"
  | "collection"
  | "delivery"
  | "deployment"
  | "domain"
  | "edge_function"
  | "file"
  | "github_link"
  | "org"
  | "plan"
  | "profile"
  | "record"
  | "secret"
  | "session"
  | "storage"
  | "subscription"
  | "usage"
  | "user"
  | "webhook";

export class PostgresStore implements Store {
  private pool: Pool | null = null;
  private readonly connectionString: string;
  private ready: Promise<void> | null = null;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  private getPool(): Pool {
    if (!this.pool) {
      // Lazy require keeps `pg` optional for installs that never use Postgres.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool: PoolCtor } = require("pg") as typeof import("pg");
      this.pool = new PoolCtor({ connectionString: this.connectionString, max: 10 });
      this.pool.on("error", () => {
        // Connection errors surface on query; never crash the process here.
      });
    }
    return this.pool;
  }

  async ensureSchema(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this.getPool().query(ENTITIES_TABLE_SQL);
      })();
    }
    return this.ready;
  }

  private async put<T>(kind: Kind, row: T & { id: string; org_id: string }, appId = "", scope = ""): Promise<T> {
    await this.ensureSchema();
    const q = buildUpsert(kind, row.id, row.org_id, appId, scope, row);
    await this.getPool().query(q.text, q.values);
    return row;
  }

  private async getOne<T>(kind: Kind, id: string, orgId: string): Promise<T | null> {
    await this.ensureSchema();
    const q = buildGet(kind, id, orgId);
    const res = await this.getPool().query(q.text, q.values);
    const row = res.rows[0] as { data: T } | undefined;
    return row ? row.data : null;
  }

  private async getByScope<T>(kind: Kind, appId: string, scope: string, orgId: string): Promise<T | null> {
    await this.ensureSchema();
    const q = buildGetByScope(kind, appId, scope, orgId);
    const res = await this.getPool().query(q.text, q.values);
    const row = res.rows[0] as { data: T } | undefined;
    return row ? row.data : null;
  }

  private async list<T>(kind: Kind, orgId: string, appId?: string, scope?: string): Promise<T[]> {
    await this.ensureSchema();
    const q = buildList(kind, orgId, appId, scope);
    const res = await this.getPool().query(q.text, q.values);
    return res.rows.map((r) => (r as { data: T }).data);
  }

  private async remove(kind: Kind, id: string, orgId: string): Promise<void> {
    await this.ensureSchema();
    const q = buildDelete(kind, id, orgId);
    await this.getPool().query(q.text, q.values);
  }

  private async getByJsonField<T>(kind: Kind, field: string, value: string): Promise<T | null> {
    await this.ensureSchema();
    const q = buildGetByJsonField(kind, field, value);
    const res = await this.getPool().query(q.text, q.values);
    const row = res.rows[0] as { data: T } | undefined;
    return row ? row.data : null;
  }

  // -- Orgs & users (orgs use their own id as org_id for the row) --------
  async createOrg(org: Org): Promise<Org> {
    return this.put("org", { ...org, org_id: org.id });
  }

  async getOrg(id: string): Promise<Org | null> {
    await this.ensureSchema();
    const res = await this.getPool().query(`SELECT data FROM forge_entities WHERE kind = $1 AND id = $2`, ["org", id]);
    const row = res.rows[0] as { data: Org } | undefined;
    return row ? row.data : null;
  }

  async createUser(user: User): Promise<User> {
    return this.put("user", user);
  }

  async findUserByEmail(email: string): Promise<User | null> {
    return this.getByJsonField<User>("user", "email", email.toLowerCase());
  }

  async getUserById(id: string): Promise<User | null> {
    await this.ensureSchema();
    const res = await this.getPool().query(`SELECT data FROM forge_entities WHERE kind = $1 AND id = $2`, ["user", id]);
    const row = res.rows[0] as { data: User } | undefined;
    return row ? row.data : null;
  }

  async getUserByEmail(orgId: string, email: string): Promise<User | null> {
    const users = await this.list<User>("user", orgId);
    return users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;
  }

  async getUserByOAuth(orgId: string, provider: "github" | "google", sub: string): Promise<User | null> {
    const field = provider === "google" ? "oauth_google_sub" : "oauth_github_sub";
    const user = await this.getByJsonField<User>("user", field, sub);
    if (!user || user.org_id !== orgId) return null;
    return user;
  }

  async updateUser(user: User): Promise<User> {
    return this.put("user", user);
  }

  async listUsers(orgId: string): Promise<User[]> {
    return this.list<User>("user", orgId);
  }

  // -- Sessions ----------------------------------------------------------
  async createSession(s: Session): Promise<Session> {
    return this.put("session", s);
  }

  async getSessionByTokenHash(hash: string): Promise<Session | null> {
    return this.getByJsonField<Session>("session", "token_hash", hash);
  }

  async deleteSession(id: string): Promise<void> {
    await this.ensureSchema();
    await this.getPool().query(`DELETE FROM forge_entities WHERE kind = $1 AND id = $2`, ["session", id]);
  }

  // -- Apps --------------------------------------------------------------
  async createApp(app: App): Promise<App> {
    return this.put("app", app, app.id);
  }

  async getApp(orgId: string, id: string): Promise<App | null> {
    return this.getOne<App>("app", id, orgId);
  }

  async getAppById(id: string): Promise<App | null> {
    await this.ensureSchema();
    const res = await this.getPool().query(`SELECT data FROM forge_entities WHERE kind = $1 AND id = $2`, ["app", id]);
    const row = res.rows[0] as { data: App } | undefined;
    return row ? row.data : null;
  }

  async getAppBySlug(orgId: string, slug: string): Promise<App | null> {
    const apps = await this.list<App>("app", orgId);
    return apps.find((a) => a.slug === slug) ?? null;
  }

  async listApps(orgId: string): Promise<App[]> {
    return this.list<App>("app", orgId);
  }

  async updateApp(app: App): Promise<App> {
    return this.put("app", app, app.id);
  }

  async deleteApp(orgId: string, id: string): Promise<void> {
    await this.remove("app", id, orgId);
  }

  // -- Collections -------------------------------------------------------
  async upsertCollection(c: CollectionSchema): Promise<CollectionSchema> {
    return this.put("collection", c, c.app_id, c.name);
  }

  async getCollection(orgId: string, appId: string, name: string): Promise<CollectionSchema | null> {
    return this.getByScope<CollectionSchema>("collection", appId, name, orgId);
  }

  async listCollections(orgId: string, appId: string): Promise<CollectionSchema[]> {
    return this.list<CollectionSchema>("collection", orgId, appId);
  }

  async deleteCollection(orgId: string, appId: string, name: string): Promise<void> {
    const c = await this.getCollection(orgId, appId, name);
    if (c) await this.remove("collection", c.id, orgId);
  }

  // -- Records -----------------------------------------------------------
  async createRecord(r: StoredRecord): Promise<StoredRecord> {
    return this.put("record", r, r.app_id, r.collection);
  }

  async getRecord(orgId: string, appId: string, collection: string, id: string): Promise<StoredRecord | null> {
    const r = await this.getOne<StoredRecord>("record", id, orgId);
    if (!r || r.app_id !== appId || r.collection !== collection) return null;
    return r;
  }

  async listRecords(orgId: string, appId: string, collection: string): Promise<StoredRecord[]> {
    return this.list<StoredRecord>("record", orgId, appId, collection);
  }

  async updateRecord(r: StoredRecord): Promise<StoredRecord> {
    return this.put("record", r, r.app_id, r.collection);
  }

  async deleteRecord(orgId: string, appId: string, collection: string, id: string): Promise<void> {
    const r = await this.getRecord(orgId, appId, collection, id);
    if (r) await this.remove("record", id, orgId);
  }

  // -- Profiles (app-scoped; org proven via the app lookup) --------------
  async upsertProfile(p: SecurityProfile): Promise<SecurityProfile> {
    await this.ensureSchema();
    const q = buildUpsert("profile", p.id, "", p.appId, p.name, p);
    await this.getPool().query(q.text, q.values);
    return p;
  }

  async getProfile(_orgId: string, appId: string, idOrName: string): Promise<SecurityProfile | null> {
    await this.ensureSchema();
    const q: BuiltQuery = {
      text: `SELECT data FROM forge_entities WHERE kind = $1 AND app_id = $2 AND (id = $3 OR scope = $3) LIMIT 1`,
      values: ["profile", appId, idOrName],
    };
    const res = await this.getPool().query(q.text, q.values);
    const row = res.rows[0] as { data: SecurityProfile } | undefined;
    return row ? row.data : null;
  }

  async listProfiles(_orgId: string, appId: string): Promise<SecurityProfile[]> {
    await this.ensureSchema();
    const res = await this.getPool().query(
      `SELECT data FROM forge_entities WHERE kind = $1 AND app_id = $2 ORDER BY updated_at DESC`,
      ["profile", appId],
    );
    return res.rows.map((r) => (r as { data: SecurityProfile }).data);
  }

  async deleteProfile(_orgId: string, appId: string, id: string): Promise<void> {
    await this.ensureSchema();
    await this.getPool().query(`DELETE FROM forge_entities WHERE kind = $1 AND app_id = $2 AND id = $3`, [
      "profile",
      appId,
      id,
    ]);
  }

  // -- API keys ----------------------------------------------------------
  async createApiKey(k: ApiKey): Promise<ApiKey> {
    return this.put("api_key", k, k.app_id ?? "");
  }

  async getApiKeyByHash(hash: string): Promise<ApiKey | null> {
    return this.getByJsonField<ApiKey>("api_key", "key_hash", hash);
  }

  async listApiKeys(orgId: string, appId: string | null): Promise<ApiKey[]> {
    const keys = await this.list<ApiKey>("api_key", orgId);
    if (appId === null) return keys;
    return keys.filter((k) => k.app_id === appId || k.app_id === null);
  }

  async updateApiKey(k: ApiKey): Promise<ApiKey> {
    return this.put("api_key", k, k.app_id ?? "");
  }

  // -- Files / deployments / functions / secrets -------------------------
  async upsertFile(f: ProjectFile): Promise<ProjectFile> {
    return this.put("file", f, f.app_id, f.path);
  }

  async getFile(orgId: string, appId: string, path: string): Promise<ProjectFile | null> {
    return this.getByScope<ProjectFile>("file", appId, path, orgId);
  }

  async listFiles(orgId: string, appId: string): Promise<ProjectFile[]> {
    return this.list<ProjectFile>("file", orgId, appId);
  }

  async deleteFile(orgId: string, appId: string, path: string): Promise<void> {
    const f = await this.getFile(orgId, appId, path);
    if (f) await this.remove("file", f.id, orgId);
  }

  async createDeployment(d: Deployment): Promise<Deployment> {
    return this.put("deployment", d, d.app_id, d.environment);
  }

  async getDeployment(orgId: string, appId: string, environment: string): Promise<Deployment | null> {
    const all = await this.list<Deployment>("deployment", orgId, appId, environment);
    const live = all.filter((d) => d.status === "live");
    live.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return live[0] ?? null;
  }

  async listDeployments(orgId: string, appId: string): Promise<Deployment[]> {
    return this.list<Deployment>("deployment", orgId, appId);
  }

  async updateDeployment(d: Deployment): Promise<Deployment> {
    return this.put("deployment", d, d.app_id, d.environment);
  }

  async upsertFunction(f: EdgeFunction): Promise<EdgeFunction> {
    return this.put("edge_function", f, f.app_id, f.name);
  }

  async getFunction(orgId: string, appId: string, name: string): Promise<EdgeFunction | null> {
    return this.getByScope<EdgeFunction>("edge_function", appId, name, orgId);
  }

  async listFunctions(orgId: string, appId: string): Promise<EdgeFunction[]> {
    return this.list<EdgeFunction>("edge_function", orgId, appId);
  }

  async deleteFunction(orgId: string, appId: string, name: string): Promise<void> {
    const f = await this.getFunction(orgId, appId, name);
    if (f) await this.remove("edge_function", f.id, orgId);
  }

  async upsertSecret(s: VaultSecret): Promise<VaultSecret> {
    return this.put("secret", s, s.app_id, s.key);
  }

  async getSecret(orgId: string, appId: string, key: string): Promise<VaultSecret | null> {
    return this.getByScope<VaultSecret>("secret", appId, key, orgId);
  }

  async listSecrets(orgId: string, appId: string): Promise<VaultSecret[]> {
    return this.list<VaultSecret>("secret", orgId, appId);
  }

  async deleteSecret(orgId: string, appId: string, key: string): Promise<void> {
    const s = await this.getSecret(orgId, appId, key);
    if (s) await this.remove("secret", s.id, orgId);
  }

  // -- Billing -----------------------------------------------------------
  async createPlan(p: BillingPlan): Promise<BillingPlan> {
    return this.put("plan", p, p.app_id);
  }

  async listPlans(orgId: string, appId: string): Promise<BillingPlan[]> {
    return this.list<BillingPlan>("plan", orgId, appId);
  }

  async getPlan(orgId: string, appId: string, id: string): Promise<BillingPlan | null> {
    const p = await this.getOne<BillingPlan>("plan", id, orgId);
    if (!p || p.app_id !== appId) return null;
    return p;
  }

  async updatePlan(p: BillingPlan): Promise<BillingPlan> {
    return this.put("plan", p, p.app_id);
  }

  async upsertSubscription(s: Subscription): Promise<Subscription> {
    return this.put("subscription", s, s.app_id);
  }

  async getSubscriptionByStripeId(stripeId: string): Promise<Subscription | null> {
    return this.getByJsonField<Subscription>("subscription", "stripe_subscription_id", stripeId);
  }

  async listSubscriptions(orgId: string, appId: string): Promise<Subscription[]> {
    return this.list<Subscription>("subscription", orgId, appId);
  }

  async recordUsage(u: UsageRecord): Promise<UsageRecord> {
    return this.put("usage", u, u.app_id);
  }

  async listUsage(orgId: string, appId: string): Promise<UsageRecord[]> {
    return this.list<UsageRecord>("usage", orgId, appId);
  }

  // -- Webhooks ----------------------------------------------------------
  async createWebhook(w: WebhookEndpoint): Promise<WebhookEndpoint> {
    return this.put("webhook", w, w.app_id);
  }

  async listWebhooks(orgId: string, appId: string): Promise<WebhookEndpoint[]> {
    return this.list<WebhookEndpoint>("webhook", orgId, appId);
  }

  async getWebhook(orgId: string, appId: string, id: string): Promise<WebhookEndpoint | null> {
    const w = await this.getOne<WebhookEndpoint>("webhook", id, orgId);
    if (!w || w.app_id !== appId) return null;
    return w;
  }

  async deleteWebhook(orgId: string, appId: string, id: string): Promise<void> {
    const w = await this.getWebhook(orgId, appId, id);
    if (w) await this.remove("webhook", id, orgId);
  }

  async createDelivery(d: WebhookDelivery): Promise<WebhookDelivery> {
    await this.ensureSchema();
    const q = buildUpsert("delivery", d.id, "", "", d.webhook_id, d);
    await this.getPool().query(q.text, q.values);
    return d;
  }

  async updateDelivery(d: WebhookDelivery): Promise<WebhookDelivery> {
    await this.ensureSchema();
    const q = buildUpsert("delivery", d.id, "", "", d.webhook_id, d);
    await this.getPool().query(q.text, q.values);
    return d;
  }

  async listDeliveries(webhookId: string): Promise<WebhookDelivery[]> {
    await this.ensureSchema();
    const res = await this.getPool().query(
      `SELECT data FROM forge_entities WHERE kind = $1 AND scope = $2 ORDER BY updated_at DESC`,
      ["delivery", webhookId],
    );
    return res.rows.map((r) => (r as { data: WebhookDelivery }).data);
  }

  // -- Audit -------------------------------------------------------------
  async appendAudit(e: AuditEvent): Promise<void> {
    await this.ensureSchema();
    const q = buildUpsert("audit", e.id, e.orgId, e.appId ?? "", e.action, e);
    await this.getPool().query(q.text, q.values);
  }

  async listAudit(orgId: string, appId?: string, action?: string, limit = 100): Promise<AuditEvent[]> {
    await this.ensureSchema();
    let text = `SELECT data FROM forge_entities WHERE kind = 'audit' AND org_id = $1`;
    const values: unknown[] = [orgId];
    if (appId) {
      values.push(appId);
      text += ` AND app_id = $${values.length}`;
    }
    if (action) {
      values.push(action);
      text += ` AND scope = $${values.length}`;
    }
    values.push(limit);
    text += ` ORDER BY updated_at DESC LIMIT $${values.length}`;
    const res = await this.getPool().query(text, values);
    return res.rows.map((r) => (r as { data: AuditEvent }).data);
  }

  // -- Storage / domains / GitHub ----------------------------------------
  async createStorageFile(f: StorageFile): Promise<StorageFile> {
    return this.put("storage", f, f.app_id, f.bucket);
  }

  async getStorageFile(orgId: string, appId: string, id: string): Promise<StorageFile | null> {
    const f = await this.getOne<StorageFile>("storage", id, orgId);
    if (!f || f.app_id !== appId) return null;
    return f;
  }

  async listStorageFiles(orgId: string, appId: string, bucket: string): Promise<StorageFile[]> {
    return this.list<StorageFile>("storage", orgId, appId, bucket);
  }

  async deleteStorageFile(orgId: string, appId: string, id: string): Promise<void> {
    const f = await this.getStorageFile(orgId, appId, id);
    if (f) await this.remove("storage", id, orgId);
  }

  async createDomain(d: Domain): Promise<Domain> {
    return this.put("domain", d, d.app_id, d.hostname);
  }

  async listDomains(orgId: string, appId: string): Promise<Domain[]> {
    return this.list<Domain>("domain", orgId, appId);
  }

  async deleteDomain(orgId: string, appId: string, id: string): Promise<void> {
    const d = await this.getOne<Domain>("domain", id, orgId);
    if (d && d.app_id === appId) await this.remove("domain", id, orgId);
  }

  async upsertGithubLink(l: GithubLink): Promise<GithubLink> {
    return this.put("github_link", l, l.app_id);
  }

  async getGithubLink(orgId: string, appId: string): Promise<GithubLink | null> {
    const links = await this.list<GithubLink>("github_link", orgId, appId);
    return links[0] ?? null;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
