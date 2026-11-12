import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { GithubSyncService, scopePath } from "./github";
import { MemoryStore } from "./store";
import { VaultService } from "./vault";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

describe("github sync (local bare remotes)", () => {
  test("link, push, pull, and conflict surfacing with real git", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "forge-git-"));
    const bare = path.join(tmp, "remote.git");
    await execFileAsync("git", ["init", "--bare", "-b", "main", bare]);
    const store = new MemoryStore();
    const vault = new VaultService(store, "master");
    const svc = new GithubSyncService(store, vault, path.join(tmp, "data"), true);

    // Seed one project file, then link + push to the empty remote.
    await store.upsertFile({
      app_id: "app_1",
      content: "<h1>v1</h1>",
      id: "file_1",
      org_id: "org_1",
      path: "index.html",
      size: 13,
      updated_at: new Date().toISOString(),
    });
    await svc.link("org_1", "app_1", bare, "main");
    const pushed = await svc.push("org_1", "app_1", "initial");
    assert.equal(pushed.pushed, true);
    assert.ok(pushed.sha);

    // Verify from an independent clone.
    const clone2 = path.join(tmp, "clone2");
    await execFileAsync("git", ["clone", bare, clone2]);
    assert.equal(await fs.readFile(path.join(clone2, "index.html"), "utf8"), "<h1>v1</h1>");

    // Change the file in clone2, push, then pull through the service.
    await fs.writeFile(path.join(clone2, "index.html"), "<h1>v2</h1>");
    await git(clone2, ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-am", "v2"]);
    await git(clone2, ["push", "origin", "main"]);
    const pulled = await svc.pull("org_1", "app_1");
    assert.equal(pulled.pulled, true);
    assert.ok(pulled.imported.includes("index.html"));
    const file = await store.getFile("org_1", "app_1", "index.html");
    assert.equal(file?.content, "<h1>v2</h1>");

    // Conflict: diverge both sides on the same file.
    await fs.writeFile(path.join(svc.workspaceDir("app_1"), "index.html"), "<h1>local</h1>");
    await git(svc.workspaceDir("app_1"), ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-am", "local change"]);
    await fs.writeFile(path.join(clone2, "index.html"), "<h1>remote</h1>");
    await git(clone2, ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-am", "remote change"]);
    await git(clone2, ["push", "origin", "main"]);
    const conflicted = await svc.pull("org_1", "app_1");
    assert.equal(conflicted.pulled, false);
    assert.ok(conflicted.conflicted.includes("index.html"), JSON.stringify(conflicted));

    // Status reports the conflict.
    const status = await svc.status("org_1", "app_1");
    assert.ok(status.conflicted.includes("index.html"));

    // Token never appears in error text.
    await vault.set("org_1", "app_1", "GITHUB_TOKEN", "ghp_supersecret");
    const err = await svc
      .runGit(svc.workspaceDir("app_1"), ["push", "origin", "main"], { token: "ghp_supersecret" })
      .then(
        () => null,
        (e: Error) => e,
      );
    void err; // Push may succeed or fail here; the scrub check below is the point.
    const failing = await svc
      .runGit(svc.workspaceDir("app_1"), ["fetch", "https://invalid.invalid/x.git"], { token: "ghp_supersecret" })
      .then(
        () => null,
        (e: Error) => e,
      );
    if (failing) assert.ok(!failing.message.includes("ghp_supersecret"), failing.message);
  });

  test("scopePath rejects escapes; non-GitHub URLs rejected without local remotes", async () => {
    assert.equal(scopePath("a/b/c.html"), "a/b/c.html");
    assert.equal(scopePath("/leading/slash.html"), "leading/slash.html");
    assert.throws(() => scopePath("../escape"), /Unsafe/);
    assert.throws(() => scopePath("a/../../escape"), /Unsafe/);
    assert.throws(() => scopePath(""), /Unsafe/);

    const store = new MemoryStore();
    const svc = new GithubSyncService(store, new VaultService(store, "master"), "/tmp/x", false);
    await assert.rejects(() => svc.link("org_1", "app_1", "file:///tmp/remote.git", "main"), /github.com/);
    await assert.rejects(() => svc.link("org_1", "app_1", "git@github.com:x/y.git", "main"), /github.com/);
  });
});
