# GitHub Sync — Two-Way Behaviour

The Studio syncs project files with a GitHub repository in both
directions. Git operations run server-side through a safe wrapper:
`execFile` with an argv array (no shell), scoped file paths, and the
token passed via `http.extraHeader` — never on the command line, never
in logs (scrubbed from error output).

## Setup

1. Store a token in the vault (Security → Secrets) under the key
   `GITHUB_TOKEN`. It needs `repo` scope for private repositories;
   public repositories can sync read-only without one.
2. In Ops → Deploy & GitHub, link the repository: HTTPS remote URL
   (e.g. `https://github.com/you/repo.git`) + branch (default `main`).
   SSH remotes are rejected — HTTPS only.
3. The first link clones (or, for an empty remote, initializes) a
   server-side workspace for the app.

Local (`file://`) remotes are rejected unless
`OPENFORGE_ALLOW_LOCAL_GIT_REMOTES=true` — a testing escape hatch, not
for production.

## Push

Push writes the app's current project files into the workspace,
commits them with your message, and pushes to the linked branch.
Pushing with no changes reports "nothing to push" rather than creating
an empty commit.

## Pull

Pull fetches and merges the remote branch into the workspace, then
imports changed files back into the app's project files. Imported
paths are scoped (no `..` escapes) and limited to the project tree.

## Conflicts

If a pull would conflict, the merge is left in its conflicted state,
the pull reports `pulled: false` with the conflicted file list, and
the status endpoint shows the conflict. Resolve the conflict in the
linked repository (or in the workspace if you have server access),
commit the resolution, and pull again. The Studio surfaces conflicts
prominently and never auto-resolves them — your code is never
silently overwritten.

## Status

The status endpoint reports: clean/dirty, ahead/behind counts,
conflicted files, modified files, and the current HEAD SHA. It
returns 404 when no repository is linked.

## Security notes

- The token is read from the encrypted vault at sync time. It is not
  stored in git config, not written to disk, and not logged.
- Trade-off: the token exists in the git process's memory while a sync
  runs. It is visible to the same OS user via process inspection
  during that window. Run the server as a dedicated user and restrict
  shell access accordingly.
- Sync is an admin-only operation through the API; the MCP server does
  not expose git operations.
