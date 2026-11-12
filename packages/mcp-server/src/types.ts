import type { JsonSchema } from "@quinlo/shared";

/** Caller identity resolved from the MCP Authorization token. */
export interface McpContext {
  actorType: "mcp";
  apiKeyId?: string;
  orgId: string;
  profileName: string;
  userId: string;
}

/** Result of one tool execution, in MCP content form. */
export interface ToolOutcome {
  /** Human/machine-readable payload; serialized as JSON text content. */
  data: unknown;
  isError: boolean;
  /** Short machine-readable code for errors (e.g. "validation", "not_found"). */
  errorCode?: string;
}

export interface ToolDefinition {
  description: string;
  handler: (ctx: McpContext, args: Record<string, unknown>, port: PlatformPort) => Promise<ToolOutcome>;
  inputSchema: JsonSchema;
  name: string;
}

/**
 * Boundary between the MCP layer and the backend. The server implements this
 * against its store; tests use a fake. Every method receives the resolved
 * MCP context, so tenant scoping and profile enforcement happen in the
 * backend exactly as for REST callers — the MCP layer adds no privilege.
 */
export interface PlatformPort {
  authenticate(token: string): Promise<McpContext | null>;
  applySecurityProfile(ctx: McpContext, args: ApplySecurityProfileArgs): Promise<unknown>;
  audit(ctx: McpContext, action: string, detail: Record<string, unknown>): Promise<void>;
  configureAuth(ctx: McpContext, args: ConfigureAuthArgs): Promise<unknown>;
  createApp(ctx: McpContext, args: CreateAppArgs): Promise<unknown>;
  createEdgeFunction(ctx: McpContext, args: CreateEdgeFunctionArgs): Promise<unknown>;
  deployFrontend(ctx: McpContext, args: DeployFrontendArgs): Promise<unknown>;
  getAuditLog(ctx: McpContext, args: GetAuditLogArgs): Promise<unknown>;
  getPreview(ctx: McpContext, args: GetPreviewArgs): Promise<unknown>;
  getSchema(ctx: McpContext, args: GetSchemaArgs): Promise<unknown>;
  listApps(ctx: McpContext, args: ListAppsArgs): Promise<unknown>;
  listFiles(ctx: McpContext, args: ListFilesArgs): Promise<unknown>;
  listFunctions(ctx: McpContext, args: ListFunctionsArgs): Promise<unknown>;
  manageSecret(ctx: McpContext, args: ManageSecretArgs): Promise<unknown>;
  provisionDatabase(ctx: McpContext, args: ProvisionDatabaseArgs): Promise<unknown>;
  readFile(ctx: McpContext, args: ReadFileArgs): Promise<unknown>;
  runBuild(ctx: McpContext, args: RunBuildArgs): Promise<unknown>;
  setupBilling(ctx: McpContext, args: SetupBillingArgs): Promise<unknown>;
  writeFile(ctx: McpContext, args: WriteFileArgs): Promise<unknown>;
}

export interface AttributeDef {
  name: string;
  required?: boolean;
  type: "string" | "integer" | "number" | "boolean" | "datetime" | "email" | "url" | "json";
  unique?: boolean;
}

export interface CollectionDef {
  attributes: AttributeDef[];
  indexes?: Array<{ fields: string[]; unique?: boolean }>;
  name: string;
}

export interface ProvisionDatabaseArgs {
  appId: string;
  schema: { collections: CollectionDef[] };
}

export interface ConfigureAuthArgs {
  appId: string;
  oauth?: Array<{ provider: "google" | "github" }>;
  orgIsolation: boolean;
  providers: Array<"email" | "google" | "github">;
}

export interface ApplySecurityProfileArgs {
  appId: string;
  profile: { description?: string; name: string; rules: Record<string, unknown> };
}

export interface SetupBillingArgs {
  appId: string;
  plans: Array<{
    currency: string;
    interval: "month" | "year" | "one_time";
    name: string;
    priceCents: number;
  }>;
}

export interface DeployFrontendArgs {
  appId: string;
  bundle: { files: Array<{ content: string; path: string }> };
  environment: "production" | "staging";
}

export interface CreateAppArgs {
  description?: string;
  name: string;
}

export interface ListAppsArgs {
  query?: string;
}

export interface ReadFileArgs {
  appId: string;
  path: string;
}

export interface WriteFileArgs {
  appId: string;
  content: string;
  path: string;
}

export interface ListFilesArgs {
  appId: string;
  prefix?: string;
}

export interface RunBuildArgs {
  appId: string;
}

export interface GetPreviewArgs {
  appId: string;
  environment?: "production" | "staging";
}

export interface GetSchemaArgs {
  appId: string;
}

export interface ManageSecretArgs {
  action: "delete" | "list" | "set";
  appId: string;
  key?: string;
  value?: string;
}

export interface CreateEdgeFunctionArgs {
  appId: string;
  code: string;
  name: string;
}

export interface ListFunctionsArgs {
  appId: string;
}

export interface GetAuditLogArgs {
  action?: string;
  appId: string;
  limit?: number;
}
