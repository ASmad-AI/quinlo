import type { SecurityProfile } from "@openforge/shared";
import type { App, BillingPlan, CollectionSchema, StoredRecord } from "./store";

/**
 * Eject: export an app as a standalone bundle that runs WITHOUT this
 * platform. The bundle contains:
 *
 *   docker-compose.yml  Postgres + app (single Node service)
 *   Dockerfile          builds the frontend, then serves API + static
 *   .env.example        DATABASE_URL / SESSION_SECRET / PORT
 *   server/             standalone Node API (original code, generated):
 *                       auth, org-scoped records, profile enforcement
 *   server/schema.json, profiles.json, records.jsonl (data dump)
 *   frontend/           the app's project files, or a minimal scaffold
 *   README.md           run instructions (`npm run build`, compose up)
 *
 * The bundle is delivered as a plain .tar (ustar, written dependency-free
 * below). No proprietary runtime, no phone-home: `tar -xf` + compose up.
 */

export interface EjectFile {
  content: Buffer | string;
  path: string;
}

export interface EjectInput {
  app: App;
  files: Array<{ content: string; path: string }>;
  plans: BillingPlan[];
  profiles: SecurityProfile[];
  records: StoredRecord[];
  schemas: CollectionSchema[];
}

const STANDALONE_SERVER = `// Standalone API for an ejected app. Generated export; runs with plain Node 20+.
// No platform dependency. Storage: one JSONB table in Postgres.
import { createHash, randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) { console.error('SESSION_SECRET is required'); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SCHEMA = JSON.parse(readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));
const PROFILES = JSON.parse(readFileSync(path.join(__dirname, 'profiles.json'), 'utf8'));

async function init() {
  await pool.query('CREATE TABLE IF NOT EXISTS ejected_rows (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, collection TEXT NOT NULL, data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())');
  await pool.query("CREATE TABLE IF NOT EXISTS ejected_users (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL, profile_name TEXT NOT NULL DEFAULT 'Member')");
  await pool.query('CREATE INDEX IF NOT EXISTS ejected_rows_org_idx ON ejected_rows (org_id, collection)');
}
function hashPw(pw) { const salt = randomBytes(16); return 'scrypt$' + salt.toString('hex') + '$' + scryptSync(pw, salt, 32).toString('hex'); }
function checkPw(pw, stored) { const p = stored.split('$'); const d = scryptSync(pw, Buffer.from(p[1], 'hex'), 32); const e = Buffer.from(p[2], 'hex'); return d.length === e.length && timingSafeEqual(d, e); }
function sign(payload) { const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); return body + '.' + createHmac('sha256', SESSION_SECRET).update(body).digest('base64url'); }
function verify(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.'); if (dot <= 0) return null;
  const body = token.slice(0, dot); const sig = token.slice(dot + 1);
  const exp = createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(exp);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return Date.now() > p.exp * 1000 ? null : p; } catch { return null; }
}
function profileFor(name) { return PROFILES.find((p) => p.name === name) || { name, rules: {} }; }
function allowedFields(profile, table, op, allFields) {
  const rule = (profile.rules || {})[table];
  if (!rule) return null;
  const entry = rule[op];
  if (!entry || entry === false) return null;
  if (op === 'delete') return new Set();
  const fields = entry.fields === '*' ? allFields : entry.fields || [];
  const deny = new Set(entry.denyFields || []);
  return new Set(fields.filter((f) => !deny.has(f)));
}
function rowOk(profile, table, op, row, ctx) {
  const rule = (profile.rules || {})[table];
  const entry = rule && rule[op];
  const conds = Array.isArray(entry) ? entry : (entry && entry.row) || [];
  return conds.every((c) => {
    const actual = row[c.field];
    const v = c.value === '$user.id' ? ctx.userId : c.value === '$org.id' ? ctx.orgId : c.value;
    if (c.op === 'eq') return actual === v;
    if (c.op === 'ne') return actual !== v;
    if (c.op === 'exists') return actual !== undefined && actual !== null;
    if (c.op === 'is_null') return actual === undefined || actual === null;
    if (c.op === 'in') return Array.isArray(v) && v.includes(actual);
    if (c.op === 'not_in') return Array.isArray(v) && !v.includes(actual);
    return false;
  });
}
function send(res, status, obj) { const body = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }); res.end(body); }
async function body(req) { const chunks = []; for await (const c of req) chunks.push(c); const t = Buffer.concat(chunks).toString('utf8'); return t ? JSON.parse(t) : {}; }
function cookies(req) { const out = {}; const h = req.headers.cookie || ''; for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return out; }

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname === '/api/auth/signup' && req.method === 'POST') {
      const b = await body(req);
      const orgId = 'org_' + randomBytes(8).toString('hex');
      const id = 'user_' + randomBytes(8).toString('hex');
      await pool.query('INSERT INTO ejected_users (id, org_id, email, name, password_hash, profile_name) VALUES ($1,$2,$3,$4,$5,$6)', [id, orgId, String(b.email).toLowerCase(), String(b.name || ''), hashPw(String(b.password)), 'Admin']);
      const token = sign({ exp: Math.floor(Date.now() / 1000) + 604800, orgId, sub: id });
      res.setHeader('set-cookie', 'session=' + token + '; HttpOnly; Path=/; SameSite=Lax');
      return send(res, 201, { user: { email: b.email, id, name: b.name } });
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const b = await body(req);
      const r = await pool.query('SELECT * FROM ejected_users WHERE email = $1', [String(b.email).toLowerCase()]);
      const u = r.rows[0];
      if (!u || !checkPw(String(b.password), u.password_hash)) return send(res, 401, { error: 'Invalid email or password' });
      const token = sign({ exp: Math.floor(Date.now() / 1000) + 604800, orgId: u.org_id, sub: u.id });
      res.setHeader('set-cookie', 'session=' + token + '; HttpOnly; Path=/; SameSite=Lax');
      return send(res, 200, { user: { email: u.email, id: u.id, name: u.name } });
    }
    const m = url.pathname.match(/^\\/api\\/records\\/([A-Za-z][A-Za-z0-9_]*)(\\/([A-Za-z0-9_-]+))?$/);
    if (m) {
      const session = verify(cookies(req).session);
      if (!session) return send(res, 401, { error: 'Unauthorized' });
      const u = (await pool.query('SELECT profile_name FROM ejected_users WHERE id = $1', [session.sub])).rows[0];
      const profile = profileFor(u ? u.profile_name : 'Guest');
      const collection = m[1];
      const schema = SCHEMA.find((s) => s.name === collection);
      if (!schema) return send(res, 404, { error: 'Collection not found' });
      const allFields = schema.attributes.map((a) => a.name);
      const ctx = { orgId: session.orgId, userId: session.sub };
      if (req.method === 'GET' && !m[3]) {
        const allowed = allowedFields(profile, collection, 'read', allFields);
        if (!allowed) return send(res, 403, { error: 'Denied by security profile' });
        const rows = (await pool.query('SELECT * FROM ejected_rows WHERE org_id = $1 AND collection = $2 ORDER BY created_at DESC LIMIT 200', [session.orgId, collection])).rows;
        const out = rows.filter((r) => rowOk(profile, collection, 'read', r.data, ctx)).map((r) => ({ created_at: r.created_at, id: r.id, org_id: r.org_id, ...Object.fromEntries(Object.entries(r.data).filter(([k]) => allowed.has(k))) }));
        return send(res, 200, { records: out, total: out.length });
      }
      if (req.method === 'POST') {
        const allowed = allowedFields(profile, collection, 'create', allFields);
        if (!allowed) return send(res, 403, { error: 'Denied by security profile' });
        const b = await body(req);
        for (const k of Object.keys(b)) { if (!allowed.has(k)) return send(res, 403, { error: 'Field not writable: ' + k }); }
        const id = 'rec_' + randomBytes(8).toString('hex');
        await pool.query('INSERT INTO ejected_rows (id, org_id, collection, data) VALUES ($1,$2,$3,$4)', [id, session.orgId, collection, JSON.stringify(b)]);
        return send(res, 201, { created_at: new Date().toISOString(), id, org_id: session.orgId, ...b });
      }
      if ((req.method === 'PATCH' || req.method === 'DELETE') && m[3]) {
        const id = m[3];
        const row = (await pool.query('SELECT * FROM ejected_rows WHERE id = $1 AND org_id = $2', [id, session.orgId])).rows[0];
        if (!row) return send(res, 404, { error: 'Record not found' });
        const op = req.method === 'DELETE' ? 'delete' : 'update';
        const allowed = op === 'delete' ? (profile.rules[collection] && profile.rules[collection].delete ? new Set() : null) : allowedFields(profile, collection, 'update', allFields);
        if (!allowed || !rowOk(profile, collection, op, row.data, ctx)) return send(res, 403, { error: 'Denied by security profile' });
        if (req.method === 'DELETE') { await pool.query('DELETE FROM ejected_rows WHERE id = $1', [id]); res.writeHead(204); res.end(); return; }
        const b = await body(req);
        for (const k of Object.keys(b)) { if (!allowed.has(k)) return send(res, 403, { error: 'Field not writable: ' + k }); }
        const merged = { ...row.data, ...b };
        await pool.query('UPDATE ejected_rows SET data = $1, updated_at = now() WHERE id = $2', [JSON.stringify(merged), id]);
        return send(res, 200, { id, org_id: session.orgId, ...merged });
      }
      return send(res, 405, { error: 'Method not allowed' });
    }
    // Static frontend (built into public/).
    const pub = path.join(__dirname, 'public');
    let file = path.join(pub, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(pub) || !existsSync(file)) file = path.join(pub, 'index.html');
    const data = await readFile(file).catch(() => null);
    if (!data) return send(res, 404, { error: 'Not found' });
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': data.length });
    res.end(data);
  } catch (err) { send(res, 500, { error: 'Internal server error' }); }
});

await init();
server.listen(PORT, () => console.log('Ejected app listening on ' + PORT));
`;

const STANDALONE_IMPORT = `// Import records.jsonl into the ejected database. Run: npm run import
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const lines = readFileSync(path.join(__dirname, 'records.jsonl'), 'utf8').split('\\n').filter(Boolean);
let count = 0;
for (const line of lines) {
  const row = JSON.parse(line);
  await pool.query('INSERT INTO ejected_rows (id, org_id, collection, data) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING', [row.id, row.org_id, row.collection, JSON.stringify(row.fields || {})]);
  count++;
}
console.log('Imported ' + count + ' records');
await pool.end();
`;

function frontendScaffold(app: App, firstCollection: string | null): EjectFile[] {
  const collection = firstCollection ?? "items";
  return [
    {
      content: JSON.stringify(
        {
          dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
          devDependencies: { "@vitejs/plugin-react": "^4.3.1", vite: "^5.4.0" },
          name: `${app.slug}-frontend`,
          private: true,
          scripts: { build: "vite build", dev: "vite", preview: "vite preview" },
          type: "module",
          version: "0.1.0",
        },
        null,
        2,
      ),
      path: "frontend/package.json",
    },
    {
      content: `import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [react()] });\n`,
      path: "frontend/vite.config.js",
    },
    {
      content: `<!doctype html>\n<html><head><meta charset="utf-8" /><title>${app.name}</title></head>\n<body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n`,
      path: "frontend/index.html",
    },
    {
      content: `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\n\ncreateRoot(document.getElementById("root")).render(<App />);\n`,
      path: "frontend/src/main.jsx",
    },
    {
      content: `import React, { useEffect, useState } from "react";\n\nexport default function App() {\n  const [records, setRecords] = useState([]);\n  const [error, setError] = useState("");\n  useEffect(() => {\n    fetch("/api/records/${collection}", { credentials: "include" })\n      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))\n      .then((j) => setRecords(j.records || []))\n      .catch((e) => setError(e.message));\n  }, []);\n  return (\n    <main style={{ fontFamily: "system-ui", margin: "2rem auto", maxWidth: 720 }}>\n      <h1>${app.name}</h1>\n      {error ? <p role="alert">Could not load records: {error} (sign in first)</p> : null}\n      <ul>{records.map((r) => (<li key={r.id}>{JSON.stringify(r)}</li>))}</ul>\n    </main>\n  );\n}\n`,
      path: "frontend/src/App.jsx",
    },
  ];
}

export function buildEjectBundle(input: EjectInput): EjectFile[] {
  const { app, files, plans, profiles, records, schemas } = input;
  const out: EjectFile[] = [];

  const schemaDoc = schemas.map((s) => ({
    attributes: s.attributes,
    indexes: s.indexes,
    name: s.name,
  }));
  const profilesDoc = profiles.map((p) => ({ description: p.description, name: p.name, rules: p.rules }));
  const recordsDoc = records
    .map((r) => JSON.stringify({ collection: r.collection, fields: r.fields, id: r.id, org_id: r.org_id }))
    .join("\n");

  out.push({
    content: [
      "services:",
      "  db:",
      "    image: postgres:16-alpine",
      "    environment:",
      "      POSTGRES_DB: ${POSTGRES_DB:-app}",
      "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}",
      "      POSTGRES_USER: ${POSTGRES_USER:-app}",
      "    volumes:",
      "      - pgdata:/var/lib/postgresql/data",
      "    healthcheck:",
      "      test: [\"CMD-SHELL\", \"pg_isready -U ${POSTGRES_USER:-app}\"]",
      "      interval: 5s",
      "      timeout: 5s",
      "      retries: 10",
      "  app:",
      "    build: .",
      "    depends_on:",
      "      db:",
      "        condition: service_healthy",
      "    environment:",
      "      DATABASE_URL: postgres://${POSTGRES_USER:-app}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB:-app}",
      "      PORT: \"3000\"",
      "      SESSION_SECRET: ${SESSION_SECRET:?set SESSION_SECRET}",
      "    ports:",
      '      - "${PORT:-3000}:3000"',
      "volumes:",
      "  pgdata:",
      "",
    ].join("\n"),
    path: "docker-compose.yml",
  });
  out.push({
    content: [
      "FROM node:22-alpine AS frontend",
      "WORKDIR /build/frontend",
      "COPY frontend/package.json frontend/package-lock.json* ./",
      "RUN npm install --no-audit --no-fund",
      "COPY frontend/ ./",
      "RUN npm run build",
      "",
      "FROM node:22-alpine",
      "WORKDIR /app",
      "COPY server/package.json ./",
      "RUN npm install --omit=dev --no-audit --no-fund",
      "COPY server/ ./",
      "COPY --from=frontend /build/frontend/dist ./public",
      "EXPOSE 3000",
      'CMD ["node", "server.mjs"]',
      "",
    ].join("\n"),
    path: "Dockerfile",
  });
  out.push({
    content: [
      "# Copy to .env and fill in secrets before starting.",
      "PORT=3000",
      "POSTGRES_DB=app",
      "POSTGRES_PASSWORD=change-me",
      "POSTGRES_USER=app",
      "SESSION_SECRET=change-me-to-a-long-random-string",
      "",
    ].join("\n"),
    path: ".env.example",
  });
  out.push({
    content: JSON.stringify(
      { dependencies: { pg: "^8.13.0" }, name: `${app.slug}-server`, private: true, scripts: { import: "node import.mjs", start: "node server.mjs" }, type: "module", version: "0.1.0" },
      null,
      2,
    ),
    path: "server/package.json",
  });
  out.push({ content: STANDALONE_SERVER, path: "server/server.mjs" });
  out.push({ content: STANDALONE_IMPORT, path: "server/import.mjs" });
  out.push({ content: JSON.stringify(schemaDoc, null, 2), path: "server/schema.json" });
  out.push({ content: JSON.stringify(profilesDoc, null, 2), path: "server/profiles.json" });
  out.push({ content: recordsDoc, path: "server/records.jsonl" });
  out.push({
    content: JSON.stringify(
      plans.map((p) => ({ currency: p.currency, interval: p.interval, name: p.name, price_cents: p.price_cents })),
      null,
      2,
    ),
    path: "server/billing-plans.json",
  });

  if (files.length > 0) {
    for (const f of files) {
      out.push({ content: f.content, path: `frontend/${f.path}` });
    }
  } else {
    out.push(...frontendScaffold(app, schemas[0]?.name ?? null));
  }

  out.push({
    content: [
      `# ${app.name} (ejected)`,
      "",
      "Standalone export. No platform dependency: a Node API + Postgres + static frontend.",
      "",
      "## Run",
      "",
      "```bash",
      "cp .env.example .env   # then set POSTGRES_PASSWORD and SESSION_SECRET",
      "docker compose up --build",
      "# import the data dump (once the stack is up):",
      "docker compose exec app npm run import",
      "```",
      "",
      "Or without Docker: `cd frontend && npm install && npm run build`, copy",
      "`frontend/dist` to `server/public`, set `DATABASE_URL`, then",
      "`cd server && npm install && npm start`.",
      "",
      "## What is inside",
      "",
      "- `server/server.mjs` — auth + org-scoped records + profile enforcement.",
      "- `server/schema.json`, `server/profiles.json` — the exported schema and",
      "  security profiles (human-readable, edit them and restart).",
      "- `server/records.jsonl` — the data dump (one JSON object per line).",
      "- `frontend/` — the app's frontend source.",
      "",
    ].join("\n"),
    path: "README.md",
  });
  out.push({ content: "node_modules/\n.env\n", path: ".gitignore" });
  return out;
}

/* ------------------------------------------------------------------ */
/* Minimal ustar TAR writer (no dependencies).                         */
/* ------------------------------------------------------------------ */

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function writeField(header: Buffer, offset: number, length: number, value: string | Buffer): void {
  const buf = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  buf.copy(header, offset, 0, Math.min(length, buf.length));
}

export function writeTar(files: EjectFile[]): Buffer {
  const blocks: Buffer[] = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const file of files) {
    if (file.path.length > 100) {
      throw new Error(`Path too long for ustar TAR entry: ${file.path}`);
    }
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
    const header = Buffer.alloc(512, 0);
    writeField(header, 0, 100, file.path);
    writeField(header, 100, 8, octal(0o644, 8));
    writeField(header, 108, 8, octal(0, 8));
    writeField(header, 116, 8, octal(0, 8));
    writeField(header, 124, 12, octal(data.length, 12));
    writeField(header, 136, 12, octal(mtime, 12));
    writeField(header, 148, 8, "        "); // checksum placeholder (spaces)
    writeField(header, 156, 1, "0");
    writeField(header, 257, 6, "ustar\0");
    writeField(header, 265, 2, "00");
    let sum = 0;
    for (const byte of header) sum += byte;
    writeField(header, 148, 8, octal(sum, 8).slice(0, 7) + " ");
    blocks.push(header);
    blocks.push(data);
    const remainder = data.length % 512;
    if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // End-of-archive marker.
  return Buffer.concat(blocks);
}

/** Parse a TAR buffer back into entries (used by tests). */
export function readTar(buf: Buffer): Array<{ name: string; size: number }> {
  const entries: Array<{ name: string; size: number }> = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeStr || "0", 8);
    entries.push({ name, size });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
