import type { IncomingMessage, ServerResponse } from "node:http";
import { ForgeError } from "@openforge/shared";

/** Authenticated caller: a signed-in user or a scoped API key. */
export interface Principal {
  apiKeyId?: string;
  email?: string;
  orgId: string;
  profileName: string;
  type: "api_key" | "user";
  userId: string;
}

export interface ReqCtx {
  body: unknown;
  cookies: Record<string, string>;
  ip: string;
  method: string;
  params: Record<string, string>;
  path: string;
  principal?: Principal;
  query: URLSearchParams;
  rawBody: Buffer;
  req: IncomingMessage;
  res: ServerResponse;
}

export interface HandlerResult {
  body?: Buffer | string;
  /** Set-Cookie values (multiple cookies need multiple headers). */
  cookies?: string[];
  /** True when the handler wrote directly to ctx.res; the dispatcher must not send anything. */
  handled?: boolean;
  headers?: Record<string, string>;
  json?: unknown;
  status?: number;
}

export type Handler = (ctx: ReqCtx) => Promise<HandlerResult | void>;

export function ok(json: unknown, status = 200): HandlerResult {
  return { json, status };
}

export function created(json: unknown): HandlerResult {
  return { json, status: 201 };
}

export function noContent(): HandlerResult {
  return { status: 204 };
}

export function raw(body: Buffer | string, contentType: string, status = 200, headers: Record<string, string> = {}): HandlerResult {
  return { body, headers: { "content-type": contentType, ...headers }, status };
}

export function redirect(location: string, status = 302): HandlerResult {
  return { headers: { location }, status };
}

interface CompiledRoute {
  handler: Handler;
  method: string;
  paramNames: string[];
  pattern: RegExp;
  raw: string;
}

function compile(pattern: string): { paramNames: string[]; regex: RegExp } {
  const paramNames: string[] = [];
  const parts = pattern.split("/").filter((p) => p.length > 0);
  const regexParts = parts.map((part) => {
    if (part.startsWith(":")) {
      paramNames.push(part.slice(1));
      return "([^/]+)";
    }
    if (part === "*") {
      paramNames.push("wildcard");
      return "(.*)";
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { paramNames, regex: new RegExp(`^/${regexParts.join("/")}/?$`) };
}

export class Router {
  private routes: CompiledRoute[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    const { paramNames, regex } = compile(pattern);
    this.routes.push({ handler, method, paramNames, pattern: regex, raw: pattern });
  }

  get(pattern: string, handler: Handler): void {
    this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.add("POST", pattern, handler);
  }

  put(pattern: string, handler: Handler): void {
    this.add("PUT", pattern, handler);
  }

  patch(pattern: string, handler: Handler): void {
    this.add("PATCH", pattern, handler);
  }

  delete(pattern: string, handler: Handler): void {
    this.add("DELETE", pattern, handler);
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });
      return { handler: r.handler, params };
    }
    return null;
  }

  allows(path: string): string[] {
    const methods: string[] = [];
    for (const r of this.routes) {
      if (r.pattern.test(path) && !methods.includes(r.method)) methods.push(r.method);
    }
    return methods;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export interface CookieOptions {
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: "Lax" | "None" | "Strict";
  secure?: boolean;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export const MAX_JSON_BODY = 5 * 1024 * 1024;

export async function readBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new ForgeError("bad_request", "Request body too large", 413);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ForgeError("bad_request", "Request body must be valid JSON", 400);
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "x-xss-protection": "0",
};

export function sendResult(res: ServerResponse, result: HandlerResult | void): void {
  if (!result) {
    res.writeHead(204, SECURITY_HEADERS);
    res.end();
    return;
  }
  if (result.handled) return;
  if (result.cookies && result.cookies.length > 0) {
    res.setHeader("set-cookie", result.cookies);
  }
  const status = result.status ?? 200;
  if (result.json !== undefined) {
    const body = JSON.stringify(result.json);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json; charset=utf-8",
      ...result.headers,
    });
    res.end(body);
    return;
  }
  const body = result.body ?? "";
  const headers: Record<string, string> = { ...SECURITY_HEADERS, ...result.headers };
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  res.writeHead(status, headers);
  res.end(body);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof ForgeError) {
    const body = JSON.stringify({ error: err.toJSON() });
    res.writeHead(err.status, {
      ...SECURITY_HEADERS,
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json; charset=utf-8",
    });
    res.end(body);
    return;
  }
  const message = err instanceof Error ? err.message : "Internal error";
  // Never leak stack traces or internals to clients.
  const body = JSON.stringify({ error: { code: "internal", message: "Internal server error" } });
  res.writeHead(500, {
    ...SECURITY_HEADERS,
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  res.end(body);
  void message;
}

export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}
