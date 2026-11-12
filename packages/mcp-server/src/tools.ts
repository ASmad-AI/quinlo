import { assertValid, BRANDING, type JsonSchema } from "@openforge/shared";
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
  ToolDefinition,
  ToolOutcome,
  WriteFileArgs,
} from "./types";

/**
 * Deterministic tool catalogue. Every tool validates its arguments against a
 * strict JSON Schema BEFORE any handler runs, so an AI client can never
 * smuggle malformed or extra fields into the backend. Argument validation
 * failures are tool errors (isError), never crashes.
 */

const APP_ID = { minLength: 1, type: "string" } as const;

function tool(
  name: string,
  description: string,
  inputSchema: JsonSchema,
  handler: ToolDefinition["handler"],
): ToolDefinition {
  return { description, handler, inputSchema, name };
}

function ok(data: unknown): ToolOutcome {
  return { data, isError: false };
}

export const INSTRUCTIONS = [
  `${BRANDING.name} build rules. Read these before generating anything:`,
  "1. Always call get_instructions first in a new session, then list_apps or create_app.",
  "2. Define the database with provision_database BEFORE writing frontend code that reads it.",
  "3. Apply a security profile with apply_security_profile before deploy_frontend. New apps deny all access by default; do not ship without a profile.",
  "4. Never invent backend boilerplate: use the tools. Never embed secrets in frontend code; use manage_secret.",
  "5. Confirm with the user before publishing to production or deleting anything.",
  "6. Finish the build (run_build green) before reporting success.",
].join("\n");

export function buildTools(): ToolDefinition[] {
  return [
    tool(
      "get_instructions",
      "Read the build rules for this platform before generating an app. Call first in every session.",
      { additionalProperties: false, properties: {}, type: "object" },
      async () => ok({ instructions: INSTRUCTIONS }),
    ),
    tool(
      "list_apps",
      "List the caller's apps, optionally filtered by a search query.",
      {
        additionalProperties: false,
        properties: { query: { type: "string" } },
        type: "object",
      },
      async (ctx, args, port) => ok(await port.listApps(ctx, args as unknown as ListAppsArgs)),
    ),
    tool(
      "create_app",
      "Create a new app in the caller's organization. Returns the app id and slug.",
      {
        additionalProperties: false,
        properties: {
          description: { maxLength: 500, type: "string" },
          name: { maxLength: 80, minLength: 1, type: "string" },
        },
        required: ["name"],
        type: "object",
      },
      async (ctx, args, port) => ok(await port.createApp(ctx, args as unknown as CreateAppArgs)),
    ),
    tool(
      "provision_database",
      "Create collections, attributes, and indexes for an app. Every collection is automatically partitioned by org_id at the query layer.",
      {
        additionalProperties: false,
        properties: {
          appId: APP_ID,
          schema: {
            additionalProperties: false,
            properties: {
              collections: {
                items: {
                  additionalProperties: false,
                  properties: {
                    attributes: {
                      items: {
                        additionalProperties: false,
                        properties: {
                          name: { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$", type: "string" },
                          required: { type: "boolean" },
                          type: {
                            enum: ["string", "integer", "number", "boolean", "datetime", "email", "url", "json"],
                            type: "string",
                          },
                          unique: { type: "boolean" },
                        },
                        required: ["name", "type"],
                        type: "object",
                      },
                      minItems: 1,
                      type: "array",
                    },
                    indexes: {
                      items: {
                        additionalProperties: false,
                        properties: {
                          fields: { items: { type: "string" }, minItems: 1, type: "array" },
                          unique: { type: "boolean" },
                        },
                        required: ["fields"],
                        type: "object",
                      },
                      type: "array",
                    },
                    name: { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$", type: "string" },
                  },
                  required: ["name", "attributes"],
                  type: "object",
                },
                minItems: 1,
                type: "array",
              },
            },
            required: ["collections"],
            type: "object",
          },
        },
        required: ["appId", "schema"],
        type: "object",
      },
      async (ctx, args, port) =>
        ok(await port.provisionDatabase(ctx, args as unknown as ProvisionDatabaseArgs)),
    ),
    tool(
      "get_schema",
      "Read an app's current database schema (collections, attributes, indexes).",
      {
        additionalProperties: false,
        properties: { appId: APP_ID },
        required: ["appId"],
        type: "object",
      },
      async (ctx, args, port) => ok(await port.getSchema(ctx, args as unknown as GetSchemaArgs)),
    ),
    tool(
      "configure_auth",
      "Enable authentication providers for an app. orgIsolation=true scopes every session and record to the caller's organization (recommended; default behaviour of the query layer).",
      {
        additionalProperties: false,
        properties: {
          appId: APP_ID,
          oauth: {
            items: {
              additionalProperties: false,
              properties: { provider: { enum: ["google", "github"], type: "string" } },
              required: ["provider"],
              type: "object",
            },
            type: "array",
          },
          orgIsolation: { type: "boolean" },
          providers: {
            items: { enum: ["email", "google", "github"], type: "string" },
            minItems: 1,
            type: "array",
          },
        },
        required: ["appId", "providers", "orgIsolation"],
        type: "object",
      },
      async (ctx, args, port) =>
        ok(await port.configureAuth(ctx, args as unknown as ConfigureAuthArgs)),
    ),
    tool(
      "apply_security_profile",
      "Apply a human-readable security profile (role) to an app: per-table read/create/update/delete whitelists, field-level and row-level rules. Fail-closed: anything not allowed is denied server-side, whatever the frontend does.",
      {
        additionalProperties: false,
        properties: {
          appId: APP_ID,
          profile: {
            additionalProperties: false,
            properties: {
              description: { maxLength: 500, type: "string" },
              name: { maxLength: 60, minLength: 1, type: "string" },
              rules: { type: "object" },
            },
            required: ["name", "rules"],
            type: "object",
          },
        },
        required: ["appId", "profile"],
        type: "object",
      },
      async (ctx, args, port) =>
        ok(await port.applySecurityProfile(ctx, args as unknown as ApplySecurityProfileArgs)),
    ),
    tool(
      "setup_billing",
      "Provision Stripe billing plans for an app (products, prices, checkout, webhook listener). Runs in Stripe test mode unless the app has live keys in the vault.",
      {
        additionalProperties: false,
        properties: {
          appId: APP_ID,
          plans: {
            items: {
              additionalProperties: false,
              properties: {
                currency: { maxLength: 3, minLength: 3, pattern: "^[a-z]{3}$", type: "string" },
                interval: { enum: ["month", "year", "one_time"], type: "string" },
                name: { maxLength: 80, minLength: 1, type: "string" },
                priceCents: { minimum: 0, type: "integer" },
              },
              required: ["name", "priceCents", "currency", "interval"],
              type: "object",
            },
            minItems: 1,
            type: "array",
          },
        },
        required: ["appId", "plans"],
        type: "object",
      },
      async (ctx, args, port) =>
        ok(await port.setupBilling(ctx, args as unknown as SetupBillingArgs)),
    ),
    tool(
      "list_files",
      "List project files for an app, optionally under a path prefix.",
      {
        additionalProperties: false,
        properties: { appId: APP_ID, prefix: { type: "string" } },
        required: ["appId"],
        type: "object",
      },
      async (ctx, args, port) => ok(await port.listFiles(ctx, args as unknown as ListFilesArgs)),
    ),
    tool(
      "read_file",
      "Read one project file's content.",
      {
        additionalProperties: false,
        properties: { appId: APP_ID, path: { maxLength: 500, minLength: 1, type: "string" } },
        required: ["appId", "path"],
        type: "object",
      },
      async (ctx, args, port) => ok(await port.readFile(ctx, args as unknown as ReadFileArgs)),
    ),
    tool(
      "write_file",
      "Write (create or replace) one project file. Paths are scoped to the app; '..' segments are rejected.",
      {
        additionalProperties: false,
        properties: {
          appId: APP_ID,
          content: { maxLength: 500000, type: "string" },
          path: { maxLength: 500, minLength: 1, type: "string" },
        },
        required: ["appId", "path", "content"],
        type: "object",
      },
      async (ctx, args, port) => ok(await port.writeFile(ctx, args as unknown as WriteFileArgs)),
    ),
    tool(
      "run_build",
      "Run build checks for an app (file sanity, schema/profile consistency) and report errors.",
      {
        additionalProperties: false,
        properties: { appId: APP_ID },
        required: ["appId"],
        type: "object",
      },
      async (ctx, args, port) => ok(await port.runBuild(ctx, args as unknown as RunBuildArgs)),
    ),
    tool(
      "get_preview",
      "Get the live preview URL and deployment status for an app environment.",
      {
        additionalProperties: false,
        properties: {
          appId: APP_ID,
          environment: { enum: ["staging", "production"], type: "string" },
        },
        required: ["appId"],
        type: "object",
      },
      async (ctx, args, port) => ok(await port.getPreview(ctx, args as unknown as GetPreviewArgs)),
    ),
    tool(
      "deploy_frontend",
      "Deploy a frontend bundle (static files) to staging or production. Production deploys require a security profile to be applied first.",
      {
        additionalProperties: false,
        properties: {
          appId: APP_ID,
          bundle: {
            additionalProperties: false,
            properties: {
              files: {
                items: {
                  additionalProperties: false,
                  properties: {
                    content: { maxLength: 1000000, type: "string" },
                    path: { maxLength: 500, minLength: 1, type: "string" },
                  },
                  required: ["path", "content"],
                  type: "object",
                },
                maxItems: 200,
                minItems: 1,
                type: "array",
              },
            },
            required: ["files"],
            type: "object",
          },
          environment: { enum: ["staging", "production"], type: "string" },
        },
        required: ["appId", "bundle", "environment"],
        type: "object",
      },
      async (ctx, args, port) =>
        ok(await port.deployFrontend(ctx, args as unknown as DeployFrontendArgs)),
    ),
    tool(
      "manage_secret",
      "Store, delete, or list (names only, never values) app secrets in the AES-256 vault: Stripe keys, OAuth secrets, SMTP credentials.",
      {
        additionalProperties: false,
        properties: {
          action: { enum: ["set", "delete", "list"], type: "string" },
          appId: APP_ID,
          key: { maxLength: 120, pattern: "^[A-Za-z_][A-Za-z0-9_]{0,119}$", type: "string" },
          value: { maxLength: 8000, type: "string" },
        },
        required: ["appId", "action"],
        type: "object",
      },
      async (ctx, args, port) =>
        ok(await port.manageSecret(ctx, args as unknown as ManageSecretArgs)),
    ),
    tool(
      "create_edge_function",
      "Create a sandboxed server-side function (edge function) for an app. Code runs with no filesystem/network access and a time limit.",
      {
        additionalProperties: false,
        properties: {
          appId: APP_ID,
          code: { maxLength: 100000, minLength: 1, type: "string" },
          name: { maxLength: 80, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,79}$", type: "string" },
        },
        required: ["appId", "name", "code"],
        type: "object",
      },
      async (ctx, args, port) =>
        ok(await port.createEdgeFunction(ctx, args as unknown as CreateEdgeFunctionArgs)),
    ),
    tool(
      "list_functions",
      "List an app's edge functions (names and metadata, not code).",
      {
        additionalProperties: false,
        properties: { appId: APP_ID },
        required: ["appId"],
        type: "object",
      },
      async (ctx, args, port) =>
        ok(await port.listFunctions(ctx, args as unknown as ListFunctionsArgs)),
    ),
    tool(
      "get_audit_log",
      "Read the audit log for an app (tenant-filtered): tool calls, denials, deploys, billing events.",
      {
        additionalProperties: false,
        properties: {
          action: { type: "string" },
          appId: APP_ID,
          limit: { maximum: 200, minimum: 1, type: "integer" },
        },
        required: ["appId"],
        type: "object",
      },
      async (ctx, args, port) => ok(await port.getAuditLog(ctx, args as unknown as GetAuditLogArgs)),
    ),
  ];
}

/** Execute one tool call: validate args, run handler, audit, normalize errors. */
export async function executeTool(
  tools: ToolDefinition[],
  name: string,
  args: unknown,
  ctx: McpContext,
  port: PlatformPort,
): Promise<ToolOutcome> {
  const started = Date.now();
  const def = tools.find((t) => t.name === name);
  if (!def) {
    return { data: { error: `Unknown tool: ${name}` }, errorCode: "unknown_tool", isError: true };
  }
  const argsObj = args === undefined ? {} : args;
  if (typeof argsObj !== "object" || argsObj === null || Array.isArray(argsObj)) {
    return {
      data: { error: "Tool arguments must be a JSON object" },
      errorCode: "validation",
      isError: true,
    };
  }
  try {
    assertValid(argsObj, def.inputSchema, `arguments for ${name}`);
  } catch (err) {
    const e = err as { details?: unknown; message: string };
    await safeAudit(port, ctx, name, false, Date.now() - started, "validation");
    return { data: { error: e.message, issues: e.details ?? [] }, errorCode: "validation", isError: true };
  }
  try {
    const outcome = await def.handler(ctx, argsObj as Record<string, unknown>, port);
    await safeAudit(port, ctx, name, !outcome.isError, Date.now() - started, outcome.errorCode);
    return outcome;
  } catch (err) {
    const e = err as { code?: string; message: string; status?: number };
    await safeAudit(port, ctx, name, false, Date.now() - started, e.code ?? "internal");
    return {
      data: { error: e.message || "Tool execution failed" },
      errorCode: e.code ?? "internal",
      isError: true,
    };
  }
}

async function safeAudit(
  port: PlatformPort,
  ctx: McpContext,
  toolName: string,
  success: boolean,
  durationMs: number,
  errorCode?: string,
): Promise<void> {
  try {
    await port.audit(ctx, "mcp.tool_called", { durationMs, errorCode, success, tool: toolName });
  } catch {
    // Audit failure must never fail the tool call itself.
  }
}
