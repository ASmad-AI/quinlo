import type {
  ApplySecurityProfileArgs,
  ConfigureAuthArgs,
  CreateAppArgs,
  CreateEdgeFunctionArgs,
  DeployFrontendArgs,
  GetAuditLogArgs,
  GetPreviewArgs,
  GetSchemaArgs,
  ListAppsArgs,
  ListFilesArgs,
  ListFunctionsArgs,
  ManageSecretArgs,
  McpContext,
  PlatformPort,
  ProvisionDatabaseArgs,
  ReadFileArgs,
  RunBuildArgs,
  SetupBillingArgs,
  WriteFileArgs,
} from "@openforge/mcp-server";
import {
  auditEvent,
  defaultProfiles,
  ForgeError,
  isValidCollectionName,
  isValidFieldName,
  newId,
  slugify,
  validateProfile,
  type SecurityProfile,
} from "@openforge/shared";
import { hashToken } from "./auth";
import type { BillingService } from "./billing";
import { deploySnapshot, previewUrl } from "./deploy";
import { scopePath } from "./github";
import type { ServerConfig } from "./config";
import type { Store } from "./store";
import type { VaultService } from "./vault";
import type { WebhookService } from "./webhooks";

/**
 * PlatformPort implementation: the MCP tools delegate to the same store
 * and services as the REST API, with the same tenant scoping and profile
 * enforcement. MCP callers authenticate with Bearer API keys only.
 */

export interface PlatformPortDeps {
  billing: BillingService;
  config: ServerConfig;
  store: Store;
  vault: VaultService;
  webhooks: WebhookService;
}

const ATTRIBUTE_TYPES = new Set(["string", "integer", "number", "boolean", "datetime", "email", "url", "json"]);

export class ServerPlatformPort implements PlatformPort {
  constructor(private readonly deps: PlatformPortDeps) {}

  async authenticate(token: string): Promise<McpContext | null> {
    const key = await this.deps.store.getApiKeyByHash(hashToken(token));
    if (!key || key.revoked_at) return null;
    await this.deps.store.updateApiKey({ ...key, last_used_at: new Date().toISOString() });
    return {
      actorType: "mcp",
      apiKeyId: key.id,
      orgId: key.org_id,
      profileName: key.profile_name,
      userId: `apikey:${key.id}`,
    };
  }

  async audit(ctx: McpContext, action: string, detail: Record<string, unknown>): Promise<void> {
    await this.deps.store.appendAudit(
      auditEvent({
        action: (action as "mcp.tool_called") ?? "mcp.tool_called",
        actorId: ctx.userId,
        actorType: "mcp",
        appId: typeof detail.appId === "string" ? detail.appId : undefined,
        detail,
        orgId: ctx.orgId,
      }),
    );
  }

  private async requireApp(ctx: McpContext, appId: string) {
    const app = await this.deps.store.getApp(ctx.orgId, appId);
    if (!app) throw new ForgeError("not_found", "App not found", 404);
    return app;
  }

  async listApps(ctx: McpContext, args: ListAppsArgs): Promise<unknown> {
    const apps = await this.deps.store.listApps(ctx.orgId);
    const q = args.query?.toLowerCase() ?? "";
    const filtered = q
      ? apps.filter((a) => a.name.toLowerCase().includes(q) || a.slug.includes(q))
      : apps;
    return { apps: filtered.map((a) => ({ description: a.description, id: a.id, name: a.name, slug: a.slug })) };
  }

  async createApp(ctx: McpContext, args: CreateAppArgs): Promise<unknown> {
    const now = new Date().toISOString();
    let slug = slugify(args.name);
    if (await this.deps.store.getAppBySlug(ctx.orgId, slug)) {
      slug = `${slug}-${newId("x").slice(4, 10)}`;
    }
    const app = await this.deps.store.createApp({
      auth_config: { oauth: [], orgIsolation: true, providers: ["email"] },
      created_at: now,
      created_by: ctx.userId,
      description: args.description ?? "",
      id: newId("app"),
      name: args.name,
      org_id: ctx.orgId,
      slug,
      updated_at: now,
    });
    for (const p of defaultProfiles(app.id, now)) {
      await this.deps.store.upsertProfile({ ...p, id: newId("profile") });
    }
    return { app: { description: app.description, id: app.id, name: app.name, slug: app.slug } };
  }

  async provisionDatabase(ctx: McpContext, args: ProvisionDatabaseArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    const created: string[] = [];
    for (const col of args.schema.collections) {
      if (!isValidCollectionName(col.name)) {
        throw new ForgeError("validation", `Invalid collection name: ${col.name}`, 400);
      }
      const attrNames = new Set<string>();
      for (const attr of col.attributes) {
        if (!isValidFieldName(attr.name)) {
          throw new ForgeError("validation", `Invalid attribute name: ${attr.name}`, 400);
        }
        if (!ATTRIBUTE_TYPES.has(attr.type)) {
          throw new ForgeError("validation", `Unknown attribute type: ${attr.type}`, 400);
        }
        if (attrNames.has(attr.name)) {
          throw new ForgeError("validation", `Duplicate attribute: ${attr.name}`, 400);
        }
        attrNames.add(attr.name);
      }
      for (const ix of col.indexes ?? []) {
        for (const f of ix.fields) {
          if (!attrNames.has(f)) {
            throw new ForgeError("validation", `Index on "${col.name}" references unknown field "${f}"`, 400);
          }
        }
      }
      const existing = await this.deps.store.getCollection(ctx.orgId, app.id, col.name);
      const now = new Date().toISOString();
      await this.deps.store.upsertCollection({
        app_id: app.id,
        attributes: col.attributes,
        created_at: existing?.created_at ?? now,
        id: existing?.id ?? newId("col"),
        indexes: col.indexes ?? [],
        name: col.name,
        org_id: ctx.orgId,
      });
      created.push(col.name);
    }
    return { appId: app.id, collections: created };
  }

  async getSchema(ctx: McpContext, args: GetSchemaArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    const collections = await this.deps.store.listCollections(ctx.orgId, app.id);
    return {
      appId: app.id,
      collections: collections.map((c) => ({ attributes: c.attributes, indexes: c.indexes, name: c.name })),
    };
  }

  async configureAuth(ctx: McpContext, args: ConfigureAuthArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    const updated = await this.deps.store.updateApp({
      ...app,
      auth_config: {
        oauth: args.oauth ?? args.providers.filter((p) => p !== "email").map((p) => ({ provider: p as "github" | "google" })),
        orgIsolation: args.orgIsolation,
        providers: args.providers,
      },
      updated_at: new Date().toISOString(),
    });
    return { appId: app.id, auth: updated.auth_config };
  }

  async applySecurityProfile(ctx: McpContext, args: ApplySecurityProfileArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    const doc = { name: args.profile.name, rules: args.profile.rules };
    const errors = validateProfile(doc);
    if (errors.length > 0) {
      throw new ForgeError("validation", `Invalid security profile: ${errors.join("; ")}`, 400, errors);
    }
    const now = new Date().toISOString();
    const existing = await this.deps.store.getProfile(ctx.orgId, app.id, args.profile.name);
    const profile: SecurityProfile = {
      appId: app.id,
      createdAt: existing?.createdAt ?? now,
      description: args.profile.description ?? existing?.description,
      id: existing?.id ?? newId("profile"),
      isDefault: existing?.isDefault ?? false,
      name: args.profile.name,
      rules: args.profile.rules as SecurityProfile["rules"],
      updatedAt: now,
    };
    await this.deps.store.upsertProfile(profile);
    await this.deps.store.appendAudit(
      auditEvent({
        action: "profile.applied",
        actorId: ctx.userId,
        actorType: "mcp",
        appId: app.id,
        detail: { profile: profile.name },
        orgId: ctx.orgId,
      }),
    );
    return { appId: app.id, profile: { name: profile.name, tables: Object.keys(profile.rules) } };
  }

  async setupBilling(ctx: McpContext, args: SetupBillingArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    const plans = await this.deps.billing.setupPlans(app, args.plans, ctx.userId);
    return {
      appId: app.id,
      plans: plans.map((p) => ({
        currency: p.currency,
        id: p.id,
        interval: p.interval,
        mode: p.mode,
        name: p.name,
        priceCents: p.price_cents,
        stripeConnected: Boolean(p.stripe_price_id),
      })),
    };
  }

  async listFiles(ctx: McpContext, args: ListFilesArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    const files = await this.deps.store.listFiles(ctx.orgId, app.id);
    const prefix = args.prefix ?? "";
    return {
      appId: app.id,
      files: files
        .filter((f) => f.path.startsWith(prefix))
        .map((f) => ({ path: f.path, size: f.size, updated_at: f.updated_at })),
    };
  }

  async readFile(ctx: McpContext, args: ReadFileArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    const file = await this.deps.store.getFile(ctx.orgId, app.id, scopePath(args.path));
    if (!file) throw new ForgeError("not_found", `File not found: ${args.path}`, 404);
    return { content: file.content, path: file.path };
  }

  async writeFile(ctx: McpContext, args: WriteFileArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    const safe = scopePath(args.path);
    const existing = await this.deps.store.getFile(ctx.orgId, app.id, safe);
    await this.deps.store.upsertFile({
      app_id: app.id,
      content: args.content,
      id: existing?.id ?? newId("file"),
      org_id: ctx.orgId,
      path: safe,
      size: Buffer.byteLength(args.content),
      updated_at: new Date().toISOString(),
    });
    return { appId: app.id, path: safe, size: Buffer.byteLength(args.content) };
  }

  async runBuild(ctx: McpContext, args: RunBuildArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    const errors: string[] = [];
    const warnings: string[] = [];
    const collections = await this.deps.store.listCollections(ctx.orgId, app.id);
    for (const c of collections) {
      if (c.attributes.length === 0) errors.push(`Collection "${c.name}" has no attributes`);
    }
    const profiles = await this.deps.store.listProfiles(ctx.orgId, app.id);
    for (const p of profiles) {
      const errs = validateProfile({ name: p.name, rules: p.rules });
      errors.push(...errs.map((e) => `Profile "${p.name}": ${e}`));
    }
    const files = await this.deps.store.listFiles(ctx.orgId, app.id);
    if (!files.some((f) => f.path === "index.html")) {
      warnings.push("No index.html in project files; preview will show an empty page until one exists");
    }
    const hasRules = profiles.some((p) => Object.keys(p.rules).length > 0);
    if (!hasRules) {
      warnings.push("No security profile with rules is applied; production deploy will be refused until one exists");
    }
    return { appId: app.id, errors, ok: errors.length === 0, warnings };
  }

  async getPreview(ctx: McpContext, args: GetPreviewArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    const env = args.environment ?? "staging";
    const deployment = await this.deps.store.getDeployment(ctx.orgId, app.id, env);
    return {
      appId: app.id,
      deployed: Boolean(deployment),
      deploymentId: deployment?.id ?? null,
      environment: env,
      url: previewUrl(this.deps.config.baseUrl, app.id, env),
    };
  }

  async deployFrontend(ctx: McpContext, args: DeployFrontendArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    if (args.environment === "production") {
      const profiles = await this.deps.store.listProfiles(ctx.orgId, app.id);
      const hasRules = profiles.some((p) => Object.keys(p.rules).length > 0);
      if (!hasRules) {
        throw new ForgeError(
          "forbidden",
          "Production deploy refused: apply a security profile with rules first (apply_security_profile)",
          403,
        );
      }
    }
    const files = args.bundle.files.map((f) => ({ content: f.content, path: scopePath(f.path) }));
    const deployment = await deploySnapshot(this.deps.store, ctx.orgId, app.id, args.environment, files);
    // Keep project files in sync with the deployed bundle.
    for (const f of files) {
      const existing = await this.deps.store.getFile(ctx.orgId, app.id, f.path);
      await this.deps.store.upsertFile({
        app_id: app.id,
        content: f.content,
        id: existing?.id ?? newId("file"),
        org_id: ctx.orgId,
        path: f.path,
        size: Buffer.byteLength(f.content),
        updated_at: new Date().toISOString(),
      });
    }
    await this.deps.store.appendAudit(
      auditEvent({
        action: "deploy.published",
        actorId: ctx.userId,
        actorType: "mcp",
        appId: app.id,
        detail: { deploymentId: deployment.id, environment: args.environment, files: files.length },
        orgId: ctx.orgId,
      }),
    );
    return {
      appId: app.id,
      deploymentId: deployment.id,
      environment: args.environment,
      url: previewUrl(this.deps.config.baseUrl, app.id, args.environment),
    };
  }

  async manageSecret(ctx: McpContext, args: ManageSecretArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    if (args.action === "list") {
      const names = await this.deps.vault.listNames(ctx.orgId, app.id);
      return { appId: app.id, secrets: names };
    }
    if (!args.key) throw new ForgeError("validation", "manage_secret requires a key for set/delete", 400);
    if (args.action === "set") {
      if (args.value === undefined) throw new ForgeError("validation", "manage_secret set requires a value", 400);
      const result = await this.deps.vault.set(ctx.orgId, app.id, args.key, args.value);
      return { appId: app.id, key: result.key, stored: true };
    }
    const removed = await this.deps.vault.remove(ctx.orgId, app.id, args.key);
    return { appId: app.id, key: args.key, removed };
  }

  async createEdgeFunction(ctx: McpContext, args: CreateEdgeFunctionArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    const now = new Date().toISOString();
    const existing = await this.deps.store.getFunction(ctx.orgId, app.id, args.name);
    await this.deps.store.upsertFunction({
      app_id: app.id,
      code: args.code,
      created_at: existing?.created_at ?? now,
      id: existing?.id ?? newId("fn"),
      name: args.name,
      org_id: ctx.orgId,
      updated_at: now,
    });
    return { appId: app.id, name: args.name };
  }

  async listFunctions(ctx: McpContext, args: ListFunctionsArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    const fns = await this.deps.store.listFunctions(ctx.orgId, app.id);
    return {
      appId: app.id,
      functions: fns.map((f) => ({ name: f.name, updated_at: f.updated_at })),
    };
  }

  async getAuditLog(ctx: McpContext, args: GetAuditLogArgs): Promise<unknown> {
    const app = await this.requireApp(ctx, args.appId);
    const events = await this.deps.store.listAudit(ctx.orgId, app.id, args.action, args.limit ?? 50);
    return { appId: app.id, events };
  }
}
