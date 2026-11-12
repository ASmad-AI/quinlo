import { randomBytes, randomUUID } from "node:crypto";

/** Opaque, unguessable ids. Format: `<prefix>_<26 lowercase base32-ish chars>`. */
export function newId(prefix: string): string {
  const raw = randomBytes(16).toString("hex");
  return `${prefix}_${raw}`;
}

export function newUuid(): string {
  return randomUUID();
}

/** Short human-friendly slug from a name: lowercase, dashes, no leading/trailing dash. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return slug || "app";
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug);
}

/** Collection / table names: letters, digits, underscore; must start with a letter. */
export function isValidCollectionName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name);
}

/** Field / attribute names: letters, digits, underscore; must start with a letter. */
export function isValidFieldName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name);
}
