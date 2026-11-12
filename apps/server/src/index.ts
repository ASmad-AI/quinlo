import { createServer } from "node:http";
import { BRANDING } from "@quinlo/shared";
import { createHttpHandler, createServices, maybeSeed } from "./app";
import { loadConfig } from "./config";
import { PostgresStore } from "./postgres";
import { MemoryStore } from "./store";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = config.databaseUrl ? new PostgresStore(config.databaseUrl) : new MemoryStore();
  if (store instanceof PostgresStore) {
    await store.ensureSchema();
  }
  const services = createServices(config, { store });
  await maybeSeed(services);
  if (!process.env.QUINLO_MASTER_KEY) {
    console.warn(
      "[warn] No QUINLO_MASTER_KEY set: using an ephemeral vault key. Secrets will NOT survive restart.",
    );
  }
  const handler = createHttpHandler(services);
  const server = createServer(handler);
  server.listen(config.port, config.host, () => {
    console.log(
      `${BRANDING.name} server listening on http://${config.host}:${config.port} ` +
        `(store: ${config.databaseUrl ? "postgres" : "memory"}, mcp: ${BRANDING.mcpPath})`,
    );
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[${signal}] Shutting down…`);
    services.webhooks.close();
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((err: unknown) => {
  console.error("Fatal startup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
