import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { buildEjectBundle, readTar, writeTar, type EjectFile } from "./eject";
import type { App } from "./store";

const execFileAsync = promisify(execFile);

function fakeApp(): App {
  return {
    auth_config: { oauth: [], orgIsolation: true, providers: ["email"] },
    created_at: "2026-11-12T00:00:00.000Z",
    created_by: "user_1",
    description: "Eject me",
    id: "app_1",
    name: "Eject App",
    org_id: "org_1",
    slug: "eject-app",
    updated_at: "2026-11-12T00:00:00.000Z",
  };
}

describe("eject bundle", () => {
  test("bundle contains compose, Dockerfile, server, data, frontend, README", () => {
    const bundle = buildEjectBundle({
      app: fakeApp(),
      files: [{ content: "<h1>hi</h1>", path: "index.html" }],
      plans: [{ app_id: "app_1", created_at: "", currency: "usd", id: "plan_1", interval: "month", mode: "test", name: "Pro", org_id: "org_1", price_cents: 999, stripe_price_id: null, stripe_product_id: null }],
      profiles: [{ appId: "app_1", createdAt: "", id: "p1", name: "Member", rules: { tasks: { read: { fields: ["title"] } } }, updatedAt: "" }],
      records: [{ app_id: "app_1", collection: "tasks", created_at: "", created_by: "u", fields: { title: "T" }, id: "rec_1", org_id: "org_1", updated_at: "" }],
      schemas: [{ app_id: "app_1", attributes: [{ name: "title", required: true, type: "string" }], created_at: "", id: "c1", indexes: [], name: "tasks", org_id: "org_1" }],
    });
    const byPath = new Map(bundle.map((f) => [f.path, String(f.content)]));
    for (const needed of ["docker-compose.yml", "Dockerfile", ".env.example", "server/package.json", "server/server.mjs", "server/import.mjs", "server/schema.json", "server/profiles.json", "server/records.jsonl", "server/billing-plans.json", "frontend/index.html", "README.md", ".gitignore"]) {
      assert.ok(byPath.has(needed), `missing ${needed}`);
    }
    assert.ok(byPath.get("docker-compose.yml")?.includes("postgres:16"));
    assert.ok(byPath.get("server/records.jsonl")?.includes('"title":"T"'));
    assert.ok(byPath.get("server/profiles.json")?.includes("Member"));
    assert.ok(byPath.get("frontend/index.html")?.includes("<h1>hi</h1>"));
    assert.ok(!byPath.get("server/server.mjs")?.includes("quinlo"), "ejected server must not depend on the platform");
  });

  test("empty project files produce a buildable React scaffold", () => {
    const bundle = buildEjectBundle({ app: fakeApp(), files: [], plans: [], profiles: [], records: [], schemas: [] });
    const byPath = new Map(bundle.map((f) => [f.path, String(f.content)]));
    assert.ok(byPath.has("frontend/package.json"));
    assert.ok(byPath.has("frontend/src/App.jsx"));
    const pkg = JSON.parse(byPath.get("frontend/package.json") as string) as { scripts: { build: string } };
    assert.equal(pkg.scripts.build, "vite build");
  });

  test("TAR writer round-trips and the generated server parses", async () => {
    const files: EjectFile[] = [
      { content: "hello", path: "a.txt" },
      { content: "x".repeat(1500), path: "big.txt" },
      { content: "", path: "empty.txt" },
    ];
    const tar = writeTar(files);
    const entries = readTar(tar);
    assert.deepEqual(entries, [
      { name: "a.txt", size: 5 },
      { name: "big.txt", size: 1500 },
      { name: "empty.txt", size: 0 },
    ]);
    // System tar can list it too (when available).
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "forge-tar-"));
    const tarPath = path.join(tmp, "bundle.tar");
    await fs.writeFile(tarPath, tar);
    try {
      const { stdout } = await execFileAsync("tar", ["-tf", tarPath]);
      assert.ok(stdout.includes("a.txt"));
      assert.ok(stdout.includes("big.txt"));
    } catch {
      // tar binary absent: the JS round-trip above is the verification.
    }

    // The generated standalone server must be syntactically valid JS.
    const bundle = buildEjectBundle({ app: fakeApp(), files: [], plans: [], profiles: [], records: [], schemas: [] });
    const serverFile = bundle.find((f) => f.path === "server/server.mjs");
    const importFile = bundle.find((f) => f.path === "server/import.mjs");
    assert.ok(serverFile && importFile);
    const serverPath = path.join(tmp, "server.mjs");
    const importPath = path.join(tmp, "import.mjs");
    await fs.writeFile(serverPath, String(serverFile.content));
    await fs.writeFile(importPath, String(importFile.content));
    await execFileAsync("node", ["--check", serverPath]);
    await execFileAsync("node", ["--check", importPath]);
  });
});
