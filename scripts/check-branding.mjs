/**
 * Branding lint: the product name may ONLY appear in branding.json, docs,
 * and test fixtures. Source files must import BRANDING from
 * @openforge/shared so a rename is a one-file change (see NAMING.md).
 * The slug is checked only inside src/ trees (package names, compose
 * files, and docs legitimately contain it).
 */
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const branding = JSON.parse(await readFile(path.join(root, "branding.json"), "utf8"));
const NAME = branding.name;
const SLUG = branding.slug;

const ALLOWED_FILES = new Set([
  "branding.json",
  "README.md",
  "NAMING.md",
  "INVENTORY.md",
  "PARITY.md",
  "DESIGN.md",
  "VERIFICATION.md",
  "SECURITY.md",
  "NOTICE",
  "LICENSE",
  "CHANGELOG.md",
  "package.json",
]);
const ALLOWED_DIRS = new Set(["docs", ".github"]);

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "dist", ".git", "data"].includes(e.name)) continue;
      out.push(...(await walk(full)));
    } else if (/\.(ts|tsx|js|mjs|css|html|json|yml|yaml|sh)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];
for (const file of await walk(root)) {
  const rel = path.relative(root, file);
  const top = rel.split(path.sep)[0];
  if (ALLOWED_FILES.has(rel) || ALLOWED_FILES.has(path.basename(rel))) continue;
  if (ALLOWED_DIRS.has(top)) continue;
  if (rel.endsWith("check-branding.mjs") || rel.endsWith(".test.ts")) continue;
  const text = await readFile(file, "utf8");
  if (text.includes(NAME)) {
    violations.push(`${rel}: literal product name "${NAME}" (use BRANDING)`);
  }
  const inSrc = /(^|\/)(apps|packages)\/[^/]+\/src\//.test(rel);
  if (inSrc) {
    for (const [idx, line] of text.split("\n").entries()) {
      if (!line.includes(SLUG)) continue;
      if (line.includes("@openforge/")) continue;
      if (line.includes("BRANDING")) continue;
      violations.push(`${rel}:${idx + 1}: literal slug "${SLUG}" (use BRANDING.slug)`);
    }
  }
}

if (violations.length > 0) {
  console.error(`Branding violations:\n${violations.join("\n")}`);
  process.exit(1);
}
console.log("Branding OK: no hard-coded product name in source.");
