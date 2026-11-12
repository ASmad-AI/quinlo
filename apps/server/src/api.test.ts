import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { hashPassword, newId } from "@openforge/shared";
import { readTar } from "./eject";
import { Client, signupAndLogin, startTestServer, type TestServer } from "./testutil";

describe("HTTP API end-to-end", () => {
  let server: TestServer;
  let admin: Client;
  let appId: string;

  before(async () => {
    server = await startTestServer();
    admin = new Client(server.baseUrl);
    await signupAndLogin(admin, "admin@example.com");
    const res = await admin.post("/api/v1/apps", { description: "E2E app", name: "E2E App" });
    assert.equal(res.status, 201, res.text);
    appId = (res.body as { app: { id: string } }).app.id;
    const col = await admin.post(`/api/v1/apps/${appId}/collections`, {
      attributes: [
        { name: "title", required: true, type: "string" },
        { name: "cost", required: false, type: "number" },
        { name: "owner_id", required: false, type: "string" },
        { name: "status", required: false, type: "string" },
      ],
      indexes: [{ fields: ["status"] }],
      name: "tasks",
    });
    assert.equal(col.status, 201, col.text);
  });

  after(async () => {
    await server.close();
  });

  test("health + auth session lifecycle", async () => {
    const health = await admin.get("/healthz");
    assert.equal(health.status, 200);
    const me = await admin.get("/api/v1/auth/me");
    assert.equal(me.status, 200);
    assert.equal((me.body as { user: { email: string } }).user.email, "admin@example.com");

    // CSRF: a cookie-authenticated POST without the token is refused.
    const noCsrf = new Client(server.baseUrl);
    await signupAndLogin(noCsrf, "csrf@example.com");
    const refused = await noCsrf.post("/api/v1/apps", { name: "Nope" }, { skipCsrf: true });
    assert.equal(refused.status, 403);

    // Bad login is a 401 with no user leak.
    const bad = new Client(server.baseUrl);
    const login = await bad.post("/api/v1/auth/login", { email: "admin@example.com", password: "wrong-password" });
    assert.equal(login.status, 401);
  });

  test("records CRUD as Admin, schema validation, and the /records alias", async () => {
    const created = await admin.post(`/api/v1/apps/${appId}/records/tasks`, {
      cost: 42,
      owner_id: "someone",
      status: "open",
      title: "First task",
    });
    assert.equal(created.status, 201, created.text);
    const record = (created.body as { record: { id: string; org_id: string } }).record;
    assert.ok(record.org_id);

    // Client-supplied org_id is ignored: the caller's org always wins.
    const forged = await admin.post(`/api/v1/apps/${appId}/records/tasks`, {
      org_id: "org_evil",
      title: "Forged org",
    });
    assert.equal(forged.status, 403, "org_id in payload must be rejected as a system field");

    // Unknown field + wrong type + missing required all fail validation.
    assert.equal((await admin.post(`/api/v1/apps/${appId}/records/tasks`, { nope: 1, title: "x" })).status, 400);
    assert.equal((await admin.post(`/api/v1/apps/${appId}/records/tasks`, { cost: "lots", title: "x" })).status, 400);
    assert.equal((await admin.post(`/api/v1/apps/${appId}/records/tasks`, { cost: 1 })).status, 400);

    const list = await admin.get(`/api/v1/apps/${appId}/records/tasks`);
    assert.equal(list.status, 200);
    assert.equal((list.body as { total: number }).total, 1);

    const alias = await admin.get(`/api/v1/records/tasks?app_id=${appId}`);
    assert.equal(alias.status, 200);
    assert.equal((alias.body as { total: number }).total, 1);

    const patched = await admin.patch(`/api/v1/apps/${appId}/records/tasks/${record.id}`, { status: "done" });
    assert.equal(patched.status, 200);
    assert.equal((patched.body as { record: { status: string } }).record.status, "done");

    const fetched = await admin.get(`/api/v1/apps/${appId}/records/tasks/${record.id}`);
    assert.equal(fetched.status, 200);

    const deleted = await admin.delete(`/api/v1/apps/${appId}/records/tasks/${record.id}`);
    assert.equal(deleted.status, 204);
    assert.equal((await admin.get(`/api/v1/apps/${appId}/records/tasks/${record.id}`)).status, 404);
  });

  test("Profile Lock: Member sees own rows only, forbidden fields 403, delete 403", async () => {
    // Apply a Member profile: read/create own-org rows, update own rows only, no delete, no cost field on write.
    const profile = await admin.post(`/api/v1/apps/${appId}/profiles`, {
      name: "Member",
      rules: {
        tasks: {
          create: { fields: ["owner_id", "status", "title"] },
          delete: false,
          read: {
            fields: ["owner_id", "status", "title"],
            row: [{ field: "owner_id", op: "eq", value: "$user.id" }],
          },
          update: {
            fields: ["status", "title"],
            row: [{ field: "owner_id", op: "eq", value: "$user.id" }],
          },
        },
      },
    });
    assert.equal(profile.status, 201, profile.text);

    // Second user in the SAME org, Member profile, created directly in the store.
    const adminUser = await server.services.store.findUserByEmail("admin@example.com");
    assert.ok(adminUser);
    const memberUser = await server.services.store.createUser({
      created_at: new Date().toISOString(),
      email: "member@example.com",
      id: newId("user"),
      name: "Member User",
      org_id: adminUser.org_id,
      password_hash: hashPassword("password-123"),
      profile_name: "Member",
    });
    const member = new Client(server.baseUrl);
    const login = await member.post("/api/v1/auth/login", { email: "member@example.com", password: "password-123" });
    assert.equal(login.status, 200, login.text);

    // Admin creates two rows: one owned by the member, one by someone else.
    const own = await admin.post(`/api/v1/apps/${appId}/records/tasks`, { owner_id: memberUser.id, status: "open", title: "Mine" });
    const others = await admin.post(`/api/v1/apps/${appId}/records/tasks`, { owner_id: "user_other", status: "open", title: "Theirs" });
    assert.equal(own.status, 201);
    assert.equal(others.status, 201);
    const ownId = (own.body as { record: { id: string } }).record.id;
    const othersId = (others.body as { record: { id: string } }).record.id;

    // Member list: only the own row is visible; cost field is stripped everywhere.
    const list = await member.get(`/api/v1/apps/${appId}/records/tasks`);
    assert.equal(list.status, 200);
    const records = (list.body as { records: Array<{ id: string }> }).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].id, ownId);
    assert.ok(!("cost" in records[0]), "cost field must be stripped by the profile");

    // Other user's row reads as 404 (no existence leak).
    assert.equal((await member.get(`/api/v1/apps/${appId}/records/tasks/${othersId}`)).status, 404);

    // Update own row: allowed. Update other's row: 404. Write cost: 403.
    assert.equal((await member.patch(`/api/v1/apps/${appId}/records/tasks/${ownId}`, { status: "done" })).status, 200);
    assert.equal((await member.patch(`/api/v1/apps/${appId}/records/tasks/${othersId}`, { status: "done" })).status, 404);
    assert.equal((await member.patch(`/api/v1/apps/${appId}/records/tasks/${ownId}`, { cost: 1 })).status, 403);
    assert.equal((await member.post(`/api/v1/apps/${appId}/records/tasks`, { cost: 5, title: "x" })).status, 403);

    // Delete: 403 even for the own row.
    assert.equal((await member.delete(`/api/v1/apps/${appId}/records/tasks/${ownId}`)).status, 403);

    // Non-admin cannot edit profiles.
    assert.equal((await member.post(`/api/v1/apps/${appId}/profiles`, { name: "Hacker", rules: {} })).status, 403);
  });

  test("tenant isolation: a second org sees nothing of the first", async () => {
    const stranger = new Client(server.baseUrl);
    await signupAndLogin(stranger, "stranger@example.com");
    assert.equal((await stranger.get(`/api/v1/apps/${appId}`)).status, 404);
    assert.equal((await stranger.get(`/api/v1/apps/${appId}/records/tasks`)).status, 404);
    assert.equal((await stranger.get(`/api/v1/apps/${appId}/schema`)).status, 404);
    const apps = await stranger.get("/api/v1/apps");
    assert.deepEqual((apps.body as { apps: unknown[] }).apps, []);
  });

  test("API keys: bearer auth, scopes, revoke, and MCP access", async () => {
    const created = await admin.post(`/api/v1/apps/${appId}/api-keys`, {
      name: "CI key",
      profileName: "Admin",
      scopes: ["records:read"],
    });
    assert.equal(created.status, 201, created.text);
    const { plaintext } = created.body as { plaintext: string };
    assert.ok(plaintext.startsWith("ofk_"));

    // Read-only key can list but not create.
    assert.equal((await admin.get(`/api/v1/apps/${appId}/records/tasks`, { bearer: plaintext })).status, 200);
    assert.equal(
      (await admin.post(`/api/v1/apps/${appId}/records/tasks`, { title: "x" }, { bearer: plaintext })).status,
      403,
    );

    // MCP with the same key: initialize + tools/list work.
    const rpc = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: {} }),
      headers: { authorization: `Bearer ${plaintext}`, "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(rpc.status, 200);
    const rpcJson = (await rpc.json()) as { result: { serverInfo: { name: string } } };
    assert.equal(rpcJson.result.serverInfo.name, "openforge");

    // MCP tool call through the real backend: provision a collection.
    const call = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            appId,
            schema: { collections: [{ attributes: [{ name: "label", type: "string" }], name: "labels" }] },
          },
          name: "provision_database",
        },
      }),
      headers: { authorization: `Bearer ${plaintext}`, "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(call.status, 200);
    const callJson = (await call.json()) as { result: { isError: boolean } };
    assert.equal(callJson.result.isError, false);

    // Revoke: the key stops working everywhere.
    const keyId = (created.body as { apiKey: { id: string } }).apiKey.id;
    assert.equal((await admin.post(`/api/v1/apps/${appId}/api-keys/${keyId}/revoke`, {})).status, 200);
    assert.equal((await admin.get(`/api/v1/apps/${appId}/records/tasks`, { bearer: plaintext })).status, 401);
  });

  test("files, storage, functions, deploy/promote, preview, eject, audit", async () => {
    // Files: write/read + traversal rejection.
    const put = await admin.put(`/api/v1/apps/${appId}/file`, { content: "<h1>Hello</h1>", path: "index.html" });
    assert.equal(put.status, 200, put.text);
    assert.equal((await admin.put(`/api/v1/apps/${appId}/file`, { content: "x", path: "../escape.html" })).status, 400);
    const got = await admin.get(`/api/v1/apps/${appId}/file?path=index.html`);
    assert.equal((got.body as { content: string }).content, "<h1>Hello</h1>");

    // Storage: base64 upload + download.
    const upload = await admin.post(`/api/v1/apps/${appId}/storage`, {
      bucket: "uploads",
      contentType: "text/plain",
      dataBase64: Buffer.from("hello storage").toString("base64"),
      name: "note.txt",
    });
    assert.equal(upload.status, 201, upload.text);
    const objId = (upload.body as { file: { id: string } }).file.id;
    const download = await admin.get(`/api/v1/apps/${appId}/storage/uploads/${objId}`);
    assert.equal(download.status, 200);
    assert.equal(download.text, "hello storage");

    // Functions: run + sandbox denial.
    const fn = await admin.post(`/api/v1/apps/${appId}/functions`, {
      code: "return { doubled: input.n * 2 };",
      name: "double",
    });
    assert.equal(fn.status, 201, fn.text);
    const invoked = await admin.post(`/api/v1/apps/${appId}/functions/double/invoke`, { input: { n: 21 } });
    assert.equal(invoked.status, 200);
    assert.deepEqual((invoked.body as { output: unknown }).output, { doubled: 42 });
    await admin.post(`/api/v1/apps/${appId}/functions`, { code: "return process.version;", name: "escape" });
    assert.equal((await admin.post(`/api/v1/apps/${appId}/functions/escape/invoke`, { input: {} })).status, 400);

    // Deploy staging, preview contains the inspector bridge, promote to production.
    const deploy = await admin.post(`/api/v1/apps/${appId}/deploy`, { environment: "staging" });
    assert.equal(deploy.status, 201, deploy.text);
    const preview = await admin.get(`/preview/${appId}/staging/`);
    assert.equal(preview.status, 200);
    assert.ok(preview.text.includes("forge-inspector"), "preview HTML must include the inspector bridge");
    assert.ok(preview.headers.get("content-security-policy")?.includes("sandbox"), "preview must be sandboxed");
    const promote = await admin.post(`/api/v1/apps/${appId}/promote`, {});
    assert.equal(promote.status, 200, promote.text);
    const prod = await admin.get(`/preview/${appId}/production/`);
    assert.equal(prod.status, 200);

    // Eject: a real TAR with the standalone bundle inside.
    const eject = await admin.requestBytes("POST", `/api/v1/apps/${appId}/eject`, { body: {} });
    assert.equal(eject.status, 200);
    assert.equal(eject.headers.get("content-type"), "application/x-tar");
    const entries = readTar(eject.bytes);
    const names = entries.map((e) => e.name);
    for (const needed of ["docker-compose.yml", "Dockerfile", "server/server.mjs", "server/schema.json", "server/profiles.json", "README.md"]) {
      assert.ok(names.includes(needed), `eject bundle missing ${needed}: ${names.join(", ")}`);
    }

    // Audit log recorded the activity.
    const auditLog = await admin.get(`/api/v1/apps/${appId}/audit?limit=200`);
    assert.equal(auditLog.status, 200);
    const actions = ((auditLog.body as { events: Array<{ action: string }> }).events ?? []).map((e) => e.action);
    assert.ok(actions.includes("deploy.published"), actions.join(","));
    assert.ok(actions.includes("eject.exported"), actions.join(","));
  });

  test("production deploy without profile rules is refused (fresh app)", async () => {
    const res = await admin.post("/api/v1/apps", { name: "Fresh App" });
    const freshId = (res.body as { app: { id: string } }).app.id;
    await admin.put(`/api/v1/apps/${freshId}/file`, { content: "<h1>x</h1>", path: "index.html" });
    const refused = await admin.post(`/api/v1/apps/${freshId}/deploy`, { environment: "production" });
    assert.equal(refused.status, 403);
    // Staging is fine without rules.
    assert.equal((await admin.post(`/api/v1/apps/${freshId}/deploy`, { environment: "staging" })).status, 201);
  });

  test("realtime SSE receives record events for the right app only", async () => {
    // Use an API key token for the SSE query param.
    const keyRes = await admin.post(`/api/v1/apps/${appId}/api-keys`, { name: "sse", profileName: "Admin", scopes: ["*"] });
    const token = (keyRes.body as { plaintext: string }).plaintext;
    const res = await fetch(`${server.baseUrl}/api/v1/realtime?appId=${appId}&token=${token}`);
    assert.equal(res.status, 200);
    const reader = res.body?.getReader();
    assert.ok(reader);
    let buf = "";
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
      }
    })();
    void pump;
    await new Promise((r) => setTimeout(r, 50));
    await admin.post(`/api/v1/apps/${appId}/records/tasks`, { owner_id: "x", status: "open", title: "Realtime task" });
    const deadline = Date.now() + 3000;
    while (!buf.includes("record.created") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(buf.includes("record.created"), `expected record.created SSE event, got: ${buf}`);
    await reader.cancel();
  });
});
