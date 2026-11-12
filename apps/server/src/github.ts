import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { BRANDING, ForgeError } from "@quinlo/shared";
import type { Store } from "./store";
import type { VaultService } from "./vault";

const execFileAsync = promisify(execFile);

/**
 * GitHub 2-way sync via a safe git wrapper: execFile with an argv array,
 * NO shell, cwd confined to the app's workspace directory, paths scoped
 * (no `..`, no absolute paths). The token travels in an http.extraHeader
 * (never in the URL, never logged); all error text is scrubbed of the
 * token before it reaches callers. Local/file remotes are allowed ONLY
 * when explicitly enabled (tests / air-gapped dev).
 */

export class GitError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitStatus {
  ahead: number;
  behind: number;
  clean: boolean;
  conflicted: string[];
  modified: string[];
  sha: string | null;
}

export class GithubSyncService {
  constructor(
    private readonly store: Store,
    private readonly vault: VaultService,
    private readonly dataDir: string,
    private readonly allowLocalRemotes = false,
  ) {}

  workspaceDir(appId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(appId)) throw new ForgeError("bad_request", "Invalid app id", 400);
    return path.join(this.dataDir, "github", appId);
  }

  validateRepoUrl(repoUrl: string): void {
    if (repoUrl.startsWith("https://github.com/") || repoUrl.startsWith("https://www.github.com/")) {
      return;
    }
    if (this.allowLocalRemotes && (repoUrl.startsWith("file://") || repoUrl.startsWith("/"))) {
      return;
    }
    throw new ForgeError(
      "validation",
      "Repository URL must be an https://github.com/ URL (local remotes are disabled)",
      400,
    );
  }

  private scrub(text: string, token?: string | null): string {
    if (!token) return text;
    return text.split(token).join("[redacted]");
  }

  async runGit(
    cwd: string,
    args: string[],
    opts: { env?: NodeJS.ProcessEnv; token?: string | null; timeoutMs?: number } = {},
  ): Promise<{ stderr: string; stdout: string }> {
    const fullArgs = [...args];
    const env = { ...process.env, ...(opts.env ?? {}), GIT_TERMINAL_PROMPT: "0" };
    if (opts.token) {
      // Token via extra header so it never appears in the remote URL.
      fullArgs.unshift("-c", `http.extraHeader=Authorization: Bearer ${opts.token}`);
    }
    try {
      const { stdout, stderr } = await execFileAsync("git", fullArgs, {
        cwd,
        env,
        maxBuffer: 10 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 60_000,
      });
      return { stderr: this.scrub(stderr, opts.token), stdout };
    } catch (err) {
      const e = err as { code?: number; message: string; stderr?: string; stdout?: string };
      const detail = this.scrub(e.stderr ?? e.message, opts.token);
      throw new GitError(`git ${args[0]} failed: ${detail.trim().slice(0, 500)}`, e.code ?? 1);
    }
  }

  private async tokenFor(orgId: string, appId: string): Promise<string | null> {
    return this.vault.get(orgId, appId, "GITHUB_TOKEN");
  }

  async link(
    orgId: string,
    appId: string,
    repoUrl: string,
    branch: string,
    token?: string,
  ): Promise<{ cloned: boolean; workspace: string }> {
    this.validateRepoUrl(repoUrl);
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) {
      throw new ForgeError("validation", "Invalid branch name", 400);
    }
    if (token) await this.vault.set(orgId, appId, "GITHUB_TOKEN", token);
    const dir = this.workspaceDir(appId);
    await fs.mkdir(path.dirname(dir), { recursive: true });
    const exists = await fs
      .stat(path.join(dir, ".git"))
      .then(() => true)
      .catch(() => false);
    if (exists) {
      await this.runGit(dir, ["remote", "set-url", "origin", repoUrl]);
      return { cloned: false, workspace: dir };
    }
    await fs.rm(dir, { force: true, recursive: true });
    const effectiveToken = token ?? (await this.tokenFor(orgId, appId));
    await this.runGit(path.dirname(dir), ["clone", "--branch", branch, repoUrl, dir], {
      token: effectiveToken,
    }).catch(async (err) => {
      // Empty remote (no branch yet): fall back to init + remote add.
      if (err instanceof GitError && /Remote branch .* not found|does not exist|empty/i.test(err.message)) {
        await fs.mkdir(dir, { recursive: true });
        await this.runGit(dir, ["init", "-b", branch]);
        await this.runGit(dir, ["remote", "add", "origin", repoUrl]);
        return;
      }
      throw err;
    });
    await this.store.upsertGithubLink({
      app_id: appId,
      branch,
      id: `gh_${appId}`,
      last_sync_at: null,
      last_sync_sha: null,
      org_id: orgId,
      repo_url: repoUrl,
    });
    return { cloned: true, workspace: dir };
  }

  async status(orgId: string, appId: string): Promise<GitStatus> {
    const dir = this.workspaceDir(appId);
    const link = await this.store.getGithubLink(orgId, appId);
    if (!link) throw new ForgeError("not_found", "No GitHub repository linked", 404);
    const porcelain = await this.runGit(dir, ["status", "--porcelain=v1", "--branch"]);
    const lines = porcelain.stdout.split("\n").filter(Boolean);
    const modified: string[] = [];
    const conflicted: string[] = [];
    let ahead = 0;
    let behind = 0;
    for (const line of lines) {
      if (line.startsWith("## ")) {
        const aheadM = line.match(/ahead (\d+)/);
        const behindM = line.match(/behind (\d+)/);
        if (aheadM) ahead = Number(aheadM[1]);
        if (behindM) behind = Number(behindM[1]);
        continue;
      }
      const code = line.slice(0, 2);
      const file = line.slice(3).trim();
      if (code.includes("U")) conflicted.push(file);
      else modified.push(file);
    }
    let sha: string | null = null;
    try {
      sha = (await this.runGit(dir, ["rev-parse", "HEAD"])).stdout.trim() || null;
    } catch {
      sha = null; // No commits yet.
    }
    return { ahead, behind, clean: modified.length === 0 && conflicted.length === 0, conflicted, modified, sha };
  }

  /** Write the app's project files into the workspace (scoped paths only). */
  async writeProjectFiles(orgId: string, appId: string): Promise<string[]> {
    const dir = this.workspaceDir(appId);
    const files = await this.store.listFiles(orgId, appId);
    const written: string[] = [];
    for (const f of files) {
      const safe = scopePath(f.path);
      const dest = path.join(dir, safe);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.content, "utf8");
      written.push(safe);
    }
    return written;
  }

  /** Read workspace files back into the store (after a pull). */
  async importWorkspaceFiles(orgId: string, appId: string): Promise<string[]> {
    const dir = this.workspaceDir(appId);
    const tracked = await this.runGit(dir, ["ls-files"]);
    const imported: string[] = [];
    for (const rel of tracked.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (rel.startsWith(".git/")) continue;
      const content = await fs.readFile(path.join(dir, rel), "utf8").catch(() => null);
      if (content === null) continue;
      const existing = await this.store.getFile(orgId, appId, rel);
      await this.store.upsertFile({
        app_id: appId,
        content,
        id: existing?.id ?? `file_${appId}_${rel.replace(/[^A-Za-z0-9]/g, "_")}`,
        org_id: orgId,
        path: rel,
        size: Buffer.byteLength(content),
        updated_at: new Date().toISOString(),
      });
      imported.push(rel);
    }
    return imported;
  }

  async push(orgId: string, appId: string, message: string): Promise<{ pushed: boolean; sha: string | null }> {
    const link = await this.store.getGithubLink(orgId, appId);
    if (!link) throw new ForgeError("not_found", "No GitHub repository linked", 404);
    const dir = this.workspaceDir(appId);
    await this.writeProjectFiles(orgId, appId);
    await this.runGit(dir, ["add", "-A"]);
    const st = await this.status(orgId, appId);
    const token = await this.tokenFor(orgId, appId);
    if (!st.clean || st.sha === null) {
      await this.runGit(dir, ["-c", `user.name=${BRANDING.name}`, "-c", `user.email=studio@${BRANDING.slug}.local`, "commit", "-m", message]);
    }
    const sha = (await this.runGit(dir, ["rev-parse", "HEAD"])).stdout.trim();
    await this.runGit(dir, ["push", "origin", link.branch], { token });
    await this.store.upsertGithubLink({ ...link, last_sync_at: new Date().toISOString(), last_sync_sha: sha });
    return { pushed: true, sha };
  }

  async pull(orgId: string, appId: string): Promise<{ conflicted: string[]; imported: string[]; pulled: boolean }> {
    const link = await this.store.getGithubLink(orgId, appId);
    if (!link) throw new ForgeError("not_found", "No GitHub repository linked", 404);
    const dir = this.workspaceDir(appId);
    const token = await this.tokenFor(orgId, appId);
    try {
      await this.runGit(dir, ["pull", "--rebase", "origin", link.branch], { token });
    } catch (err) {
      const st = await this.status(orgId, appId);
      if (st.conflicted.length > 0) {
        return { conflicted: st.conflicted, imported: [], pulled: false };
      }
      throw err;
    }
    const imported = await this.importWorkspaceFiles(orgId, appId);
    const sha = (await this.runGit(dir, ["rev-parse", "HEAD"])).stdout.trim();
    await this.store.upsertGithubLink({ ...link, last_sync_at: new Date().toISOString(), last_sync_sha: sha });
    return { conflicted: [], imported, pulled: true };
  }

  async sync(orgId: string, appId: string, message: string): Promise<{ pull: { conflicted: string[]; pulled: boolean }; push: { pushed: boolean; sha: string | null } | null }> {
    const pull = await this.pull(orgId, appId);
    if (!pull.pulled) {
      return { pull: { conflicted: pull.conflicted, pulled: false }, push: null };
    }
    const push = await this.push(orgId, appId, message);
    return { pull: { conflicted: [], pulled: true }, push };
  }
}

/** Reject absolute paths and `..` escapes; normalize separators. */
export function scopePath(input: string): string {
  const normalized = input.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");
  const parts = normalized.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) {
    throw new ForgeError("validation", `Unsafe file path: ${input}`, 400);
  }
  return parts.join("/");
}
