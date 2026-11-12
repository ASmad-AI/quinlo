import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createCipheriv, createDecipheriv, createHmac, randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ */
/* Passwords (scrypt)                                                  */
/* ------------------------------------------------------------------ */

const SCRYPT_OPTS = { N: 16384, maxmem: 64 * 1024 * 1024, p: 1, r: 8 } as const;

/** Stored format: `scrypt$<salt hex>$<derived hex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32, SCRYPT_OPTS);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = scryptSync(password, salt, expected.length, SCRYPT_OPTS);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/* ------------------------------------------------------------------ */
/* Signed opaque tokens (HMAC-SHA256)                                  */
/* ------------------------------------------------------------------ */

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64url");
}

export function signToken(payload: Record<string, unknown>, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken<T extends Record<string, unknown>>(
  token: string,
  secret: string,
): T | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    if (typeof parsed.exp === "number" && Date.now() > parsed.exp * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Secrets vault: AES-256-GCM                                          */
/* ------------------------------------------------------------------ */

/**
 * The vault key is derived from the operator-supplied master key
 * (QUINLO_MASTER_KEY) with scrypt. Ciphertext format:
 * `v1$<salt hex>$<iv hex>$<authTag hex>$<ciphertext hex>`.
 * A wrong master key fails closed: decryption throws, nothing is returned.
 */
export function deriveVaultKey(masterKey: string, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, 32, { N: 16384, maxmem: 64 * 1024 * 1024, p: 1, r: 8 });
}

export function encryptSecret(plaintext: string, masterKey: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveVaultKey(masterKey, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1$${salt.toString("hex")}$${iv.toString("hex")}$${tag.toString("hex")}$${ciphertext.toString("hex")}`;
}

export function decryptSecret(packed: string, masterKey: string): string {
  const parts = packed.split("$");
  if (parts.length !== 5 || parts[0] !== "v1") {
    throw new Error("Unsupported vault ciphertext format");
  }
  const [, saltHex, ivHex, tagHex, ctHex] = parts;
  const key = deriveVaultKey(masterKey, Buffer.from(saltHex, "hex"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

/* ------------------------------------------------------------------ */
/* HMAC helpers: webhook signatures, Stripe-style verification         */
/* ------------------------------------------------------------------ */

export function hmacHex(secret: string, payload: string | Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function hmacEqualHex(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex);
  const b = Buffer.from(bHex);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify a Stripe-style signature header: `t=<unix seconds>,v1=<hex>[,v1=<hex>]`.
 * The signed payload is `<t>.<raw body>`. Rejects timestamps older than
 * `toleranceSeconds` (default 300) to bound replay. Returns false — never
 * throws — for malformed input, so callers fail closed.
 */
export function verifyStripeSignature(
  rawBody: string | Buffer,
  header: string | undefined,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header || !secret) return false;
  const fields = new Map<string, string[]>();
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    const list = fields.get(k) ?? [];
    list.push(v);
    fields.set(k, list);
  }
  const tValues = fields.get("t") ?? [];
  const v1Values = fields.get("v1") ?? [];
  if (tValues.length !== 1 || v1Values.length === 0) return false;
  const t = Number(tValues[0]);
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const signed = `${t}.${Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody}`;
  const expected = hmacHex(secret, signed);
  return v1Values.some((v) => hmacEqualHex(v, expected));
}

/** Outbound webhook signature: `sha256=<hmac hex of raw JSON body>`. */
export function signWebhookBody(secret: string, rawBody: string): string {
  return `sha256=${hmacHex(secret, rawBody)}`;
}

export function newSecret(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}${randomBytes(8).toString("hex")}`;
}
