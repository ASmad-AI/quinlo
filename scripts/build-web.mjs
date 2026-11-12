/**
 * Build the Studio frontend: bundle apps/web/src/main.ts (+ CSS) into
 * apps/web/dist/ with esbuild, and copy index.html + public assets.
 * The server serves dist/ as static files.
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(root, "..");
const webDir = path.join(repo, "apps", "web");
const outDir = path.join(webDir, "dist");

await mkdir(outDir, { recursive: true });

await esbuild.build({
  bundle: true,
  entryPoints: [path.join(webDir, "src", "main.ts")],
  format: "esm",
  logLevel: "info",
  minify: process.env.NODE_ENV === "production",
  outfile: path.join(outDir, "app.js"),
  sourcemap: process.env.NODE_ENV !== "production",
  target: "es2022",
});

await esbuild.build({
  bundle: true,
  entryPoints: [path.join(webDir, "src", "styles.css")],
  logLevel: "info",
  minify: process.env.NODE_ENV === "production",
  outfile: path.join(outDir, "styles.css"),
});

const html = await readFile(path.join(webDir, "index.html"), "utf8");
await writeFile(path.join(outDir, "index.html"), html, "utf8");

await cp(path.join(webDir, "public"), outDir, { recursive: true }).catch(() => undefined);

console.log("Studio build complete -> apps/web/dist");
