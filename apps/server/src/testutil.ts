import { createServer, type Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createHttpHandler, createServices, type Services, type ServiceOverrides } from "./app";
import type { ServerConfig } from "./config";
import { MemoryStore } from "./store";

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    baseUrl: "http://localhost:3000",
    dataDir: path.join(os.tmpdir(), `forge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    devAllowEphemeralKeys: true,
    functionTimeoutMs: 2000,
    host: "127.0.0.1",
    masterKey: "test-master-key-for-unit-tests-only",
    maxUploadBytes: 1024 * 1024,
    nodeEnv: "test",
    port: 0,
    publicDir: path.join(os.tmpdir(), "forge-no-public-dir"),
    rateLimitMax: 10000,
    rateLimitWindowMs: 60_000,
    seedDemo: false,
    sessionTtlMs: 60 * 60 * 1000,
    stripeApiBaseUrl: "https://api.stripe.com",
    ...overrides,
  };
}

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
  services: Services;
}

export async function startTestServer(
  configOverrides: Partial<ServerConfig> = {},
  serviceOverrides: ServiceOverrides = {},
): Promise<TestServer> {
  const config = testConfig(configOverrides);
  const store = serviceOverrides.store ?? new MemoryStore();
  const services = createServices(config, { ...serviceOverrides, store });
  const server: Server = createServer(createHttpHandler(services));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      services.webhooks.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
    services,
  };
}

/** Minimal cookie-jar HTTP client with CSRF support. */
export class Client {
  private cookies = new Map<string, string>();
  private csrfToken = "";

  constructor(private readonly baseUrl: string) {}

  private storeCookies(res: Response): void {
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const header of setCookies) {
      const first = header.split(";")[0];
      const eq = first.indexOf("=");
      if (eq > 0) {
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        this.cookies.set(name, value);
        // The CSRF cookie IS the double-submit token: a rotated cookie
        // (e.g. after login) must rotate the header we send.
        if (name === "of_csrf") this.csrfToken = value;
      }
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async ensureCsrf(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/auth/csrf`, {
      headers: this.cookies.size > 0 ? { cookie: this.cookieHeader() } : {},
    });
    this.storeCookies(res);
    const json = (await res.json()) as { csrfToken: string };
    this.csrfToken = json.csrfToken;
  }

  async requestBytes(
    method: string,
    path: string,
    opts: { bearer?: string; body?: unknown } = {},
  ): Promise<{ headers: Headers; status: number; bytes: Buffer }> {
    if (!opts.bearer && !this.csrfToken) await this.ensureCsrf();
    const headers: Record<string, string> = {};
    if (this.cookies.size > 0) headers.cookie = this.cookieHeader();
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (!opts.bearer) headers["x-csrf-token"] = this.csrfToken;
    const res = await fetch(`${this.baseUrl}${path}`, {
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      headers: { ...headers, "content-type": "application/json" },
      method,
    });
    this.storeCookies(res);
    return { bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers, status: res.status };
  }

  async request(
    method: string,
    path: string,
    opts: { bearer?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string; skipCsrf?: boolean } = {},
  ): Promise<{ body: unknown; headers: Headers; status: number; text: string }> {
    const needsCsrf = !["GET", "HEAD", "OPTIONS"].includes(method) && !opts.bearer && !opts.skipCsrf;
    if (needsCsrf && !this.csrfToken) await this.ensureCsrf();
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.cookies.size > 0) headers.cookie = this.cookieHeader();
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (needsCsrf) headers["x-csrf-token"] = this.csrfToken;
    let body: string | undefined;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    const res = await fetch(`${this.baseUrl}${path}`, { body, headers, method });
    this.storeCookies(res);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Leave as text.
    }
    return { body: parsed, headers: res.headers, status: res.status, text };
  }

  get(path: string, opts?: { bearer?: string }): Promise<{ body: unknown; headers: Headers; status: number; text: string }> {
    return this.request("GET", path, opts);
  }

  post(path: string, body?: unknown, opts?: { bearer?: string; headers?: Record<string, string>; skipCsrf?: boolean }): Promise<{ body: unknown; headers: Headers; status: number; text: string }> {
    return this.request("POST", path, { ...opts, body });
  }

  put(path: string, body?: unknown, opts?: { bearer?: string }): Promise<{ body: unknown; headers: Headers; status: number; text: string }> {
    return this.request("PUT", path, { ...opts, body });
  }

  patch(path: string, body?: unknown, opts?: { bearer?: string }): Promise<{ body: unknown; headers: Headers; status: number; text: string }> {
    return this.request("PATCH", path, { ...opts, body });
  }

  delete(path: string, opts?: { bearer?: string; skipCsrf?: boolean }): Promise<{ body: unknown; headers: Headers; status: number; text: string }> {
    return this.request("DELETE", path, opts);
  }
}

export async function signupAndLogin(
  client: Client,
  email: string,
  password = "password-123",
  name = "Test User",
): Promise<{ user: { id: string; org_id: string } }> {
  const res = await client.post("/api/v1/auth/signup", { email, name, password });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${res.text}`);
  return res.body as { user: { id: string; org_id: string } };
}
