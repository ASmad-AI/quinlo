/**
 * Deterministic Profile Lock engine ("the Apper Lock" in the PRD, re-implemented
 * from scratch as original code).
 *
 * Two layers, enforced server-side on EVERY request, independent of any
 * frontend code:
 *
 *   Layer 1 — tenant isolation: every row carries `org_id`; the query layer
 *   always constrains to the caller's org (see tenants.ts). No profile can
 *   widen this.
 *
 *   Layer 2 — profiles: human-readable JSON whitelists. A profile names, per
 *   table, which operations are allowed, which fields may be read/written,
 *   and which row conditions must hold. Anything not explicitly allowed is
 *   DENIED (fail-closed). A profile with no rule for a table denies all
 *   access to that table. Unknown fields are stripped from responses and
 *   rejected on writes.
 *
 * Profiles are data, never code: no expressions are evaluated, only the
 * small condition language below. AI-generated frontends cannot override
 * profiles; only a profile edit (itself audited) changes access.
 */

import { profileDenied } from "./errors";

export type Operation = "read" | "create" | "update" | "delete";

export type RowConditionOp = "eq" | "ne" | "in" | "not_in" | "exists" | "is_null";

export interface RowCondition {
  /** Field on the row to test. Must be a valid field name. */
  field: string;
  op: RowConditionOp;
  /**
   * Literal value, or a context reference: "$user.id" (caller's user id),
   * "$org.id" (caller's org id), "$user.email". For `in`/`not_in`, an array.
   */
  value?: unknown;
}

export interface FieldRule {
  /** Whitelisted fields, or "*" for all non-denied fields. Required. */
  fields: string[] | "*";
  /** Fields always excluded, even when fields is "*". Applied after the whitelist. */
  denyFields?: string[];
  /** Row conditions; ALL must hold. Omit for "any row in this org". */
  row?: RowCondition[];
}

export interface TableRule {
  create?: FieldRule | false;
  delete?: boolean | RowCondition[];
  read?: FieldRule | false;
  update?: FieldRule | false;
}

export interface SecurityProfile {
  appId: string;
  createdAt: string;
  description?: string;
  id: string;
  /** Exactly one default profile per app; assigned to new members. */
  isDefault?: boolean;
  name: string;
  rules: Record<string, TableRule>;
  updatedAt: string;
}

export interface AccessContext {
  orgId: string;
  profile: SecurityProfile;
  userEmail?: string;
  userId: string;
}

export interface AccessDecision {
  /** For read/create/update: fields the caller may see/write. Undefined for delete. */
  allowedFields?: Set<string>;
  allowed: boolean;
  reason: string;
}

/** Fields that are never writable through the record API, whatever a profile says. */
export const SYSTEM_FIELDS = ["id", "org_id", "created_at", "updated_at", "created_by"] as const;

/** Fields that are never readable unless a profile whitelists them by name. */
export const SENSITIVE_FIELD_HINTS = [
  "password",
  "password_hash",
  "secret",
  "api_key",
  "token",
  "private_key",
] as const;

function resolveValue(value: unknown, ctx: AccessContext): unknown {
  if (typeof value === "string") {
    if (value === "$user.id") return ctx.userId;
    if (value === "$org.id") return ctx.orgId;
    if (value === "$user.email") return ctx.userEmail;
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx));
  return value;
}

export function testRowCondition(
  row: Record<string, unknown>,
  cond: RowCondition,
  ctx: AccessContext,
): boolean {
  const actual = row[cond.field];
  switch (cond.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "is_null":
      return actual === undefined || actual === null;
    case "eq":
      return actual === resolveValue(cond.value, ctx);
    case "ne":
      return actual !== resolveValue(cond.value, ctx);
    case "in": {
      const allowed = resolveValue(cond.value, ctx);
      return Array.isArray(allowed) && allowed.includes(actual);
    }
    case "not_in": {
      const denied = resolveValue(cond.value, ctx);
      return Array.isArray(denied) && !denied.includes(actual);
    }
    default:
      return false; // Unknown operator: fail closed.
  }
}

export function testRowConditions(
  row: Record<string, unknown>,
  conditions: RowCondition[] | undefined,
  ctx: AccessContext,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((c) => testRowCondition(row, c, ctx));
}

function fieldSet(
  rule: FieldRule,
  allFields: string[] | undefined,
): Set<string> {
  const denied = new Set(rule.denyFields ?? []);
  if (rule.fields === "*") {
    // "*" needs the schema's field list to be concrete; without it, deny all
    // except nothing — callers must pass allFields. Fail closed by design.
    if (!allFields) return new Set();
    return new Set(allFields.filter((f) => !denied.has(f)));
  }
  return new Set(rule.fields.filter((f) => !denied.has(f)));
}

/**
 * Decide whether `ctx` may perform `op` on `table`, optionally against a
 * concrete `row` (required for update/delete row conditions). For read, the
 * caller must pass the table's field list so "*" rules resolve concretely.
 */
export function evaluateAccess(
  table: string,
  op: Operation,
  ctx: AccessContext,
  opts: { allFields?: string[]; row?: Record<string, unknown> } = {},
): AccessDecision {
  const rule = ctx.profile.rules[table];
  if (!rule) {
    return { allowed: false, reason: `no rule for table "${table}" in profile "${ctx.profile.name}"` };
  }
  const entry = rule[op];
  if (entry === undefined || entry === false) {
    return { allowed: false, reason: `operation "${op}" on "${table}" is not allowed by profile "${ctx.profile.name}"` };
  }
  if (op === "delete") {
    if (entry === true) return { allowed: true, reason: "delete allowed" };
    if (Array.isArray(entry)) {
      if (!opts.row) {
        return { allowed: false, reason: "delete requires a row to evaluate conditions" };
      }
      const ok = testRowConditions(opts.row, entry, ctx);
      return ok
        ? { allowed: true, reason: "row conditions satisfied" }
        : { allowed: false, reason: "row conditions not satisfied" };
    }
    return { allowed: false, reason: "invalid delete rule" };
  }
  const fieldRule = entry as FieldRule;
  if (opts.row && !testRowConditions(opts.row, fieldRule.row, ctx)) {
    return { allowed: false, reason: "row conditions not satisfied" };
  }
  const allowedFields = fieldSet(fieldRule, opts.allFields);
  return { allowed: true, allowedFields, reason: "allowed by profile" };
}

/** Throw a 403 ForgeError unless access is allowed. Returns allowed fields. */
export function assertAccess(
  table: string,
  op: Operation,
  ctx: AccessContext,
  opts: { allFields?: string[]; row?: Record<string, unknown> } = {},
): Set<string> | undefined {
  const decision = evaluateAccess(table, op, ctx, opts);
  if (!decision.allowed) throw profileDenied(decision.reason);
  return decision.allowedFields;
}

/**
 * Strip every field the caller may not read. System fields id/org_id/
 * created_at/updated_at/created_by are always readable (they carry no
 * secret); everything else must be whitelisted. Unknown fields are dropped.
 */
export function filterReadableFields(
  row: Record<string, unknown>,
  allowedFields: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (SYSTEM_FIELDS.includes(key as (typeof SYSTEM_FIELDS)[number]) || allowedFields.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Validate a write payload: every field must be whitelisted and none may be
 * a system field. Returns the list of rejected fields (empty = accepted).
 */
export function rejectedWriteFields(
  payload: Record<string, unknown>,
  allowedFields: Set<string>,
): string[] {
  const rejected: string[] = [];
  for (const key of Object.keys(payload)) {
    if (SYSTEM_FIELDS.includes(key as (typeof SYSTEM_FIELDS)[number])) {
      rejected.push(key);
    } else if (!allowedFields.has(key)) {
      rejected.push(key);
    }
  }
  return rejected;
}

/** Structural validation for a profile document. Returns error strings (empty = valid). */
export function validateProfile(profile: unknown): string[] {
  const errors: string[] = [];
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    return ["profile must be an object"];
  }
  const p = profile as Record<string, unknown>;
  if (typeof p.name !== "string" || p.name.trim().length === 0) {
    errors.push("name must be a non-empty string");
  }
  if (typeof p.rules !== "object" || p.rules === null || Array.isArray(p.rules)) {
    errors.push("rules must be an object keyed by table name");
    return errors;
  }
  const validOps = new Set(["read", "create", "update", "delete"]);
  for (const [table, tableRule] of Object.entries(p.rules as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(table)) {
      errors.push(`table name "${table}" is invalid`);
    }
    if (typeof tableRule !== "object" || tableRule === null || Array.isArray(tableRule)) {
      errors.push(`rules.${table} must be an object`);
      continue;
    }
    for (const [op, entry] of Object.entries(tableRule as Record<string, unknown>)) {
      if (!validOps.has(op)) {
        errors.push(`rules.${table}.${op} is not a known operation`);
        continue;
      }
      if (entry === false) continue;
      if (op === "delete") {
        if (entry === true) continue;
        if (Array.isArray(entry)) {
          entry.forEach((c, i) => errors.push(...validateCondition(c, `rules.${table}.delete[${i}]`)));
          continue;
        }
        errors.push(`rules.${table}.delete must be true, false, or an array of row conditions`);
        continue;
      }
      errors.push(...validateFieldRule(entry, `rules.${table}.${op}`));
    }
  }
  return errors;
}

function validateCondition(cond: unknown, path: string): string[] {
  const errors: string[] = [];
  if (typeof cond !== "object" || cond === null || Array.isArray(cond)) {
    return [`${path} must be an object`];
  }
  const c = cond as Record<string, unknown>;
  if (typeof c.field !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(c.field)) {
    errors.push(`${path}.field must be a valid field name`);
  }
  const ops = ["eq", "ne", "in", "not_in", "exists", "is_null"];
  if (typeof c.op !== "string" || !ops.includes(c.op)) {
    errors.push(`${path}.op must be one of ${ops.join(", ")}`);
  }
  if ((c.op === "in" || c.op === "not_in") && !Array.isArray(c.value)) {
    errors.push(`${path}.value must be an array for "${c.op}"`);
  }
  return errors;
}

function validateFieldRule(entry: unknown, path: string): string[] {
  const errors: string[] = [];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return [`${path} must be an object with a "fields" whitelist`];
  }
  const r = entry as Record<string, unknown>;
  if (r.fields !== "*" && !Array.isArray(r.fields)) {
    errors.push(`${path}.fields must be "*" or an array of field names`);
  } else if (Array.isArray(r.fields)) {
    for (const f of r.fields) {
      if (typeof f !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(f)) {
        errors.push(`${path}.fields contains invalid field name ${JSON.stringify(f)}`);
      }
    }
  }
  if (r.denyFields !== undefined) {
    if (!Array.isArray(r.denyFields) || r.denyFields.some((f) => typeof f !== "string")) {
      errors.push(`${path}.denyFields must be an array of field names`);
    }
  }
  if (r.row !== undefined) {
    if (!Array.isArray(r.row)) {
      errors.push(`${path}.row must be an array of row conditions`);
    } else {
      r.row.forEach((c, i) => errors.push(...validateCondition(c, `${path}.row[${i}]`)));
    }
  }
  return errors;
}

/** Built-in profiles shipped with every new app. Editable; never magic. */
export function defaultProfiles(appId: string, now: string): SecurityProfile[] {
  const base = { appId, createdAt: now, updatedAt: now };
  return [
    {
      ...base,
      description: "Full access to every table in the organization.",
      id: "profile_admin",
      isDefault: false,
      name: "Admin",
      rules: {},
    },
    {
      ...base,
      description: "Standard member. Reads and edits org data, cannot delete or manage billing.",
      id: "profile_member",
      isDefault: true,
      name: "Member",
      rules: {},
    },
    {
      ...base,
      description: "Unauthenticated visitors. No access until an admin grants it explicitly.",
      id: "profile_guest",
      isDefault: false,
      name: "Guest",
      rules: {},
    },
  ];
}

/**
 * Expand the Admin profile's empty rules into full access for the app's
 * tables. Admin is the ONLY profile with implicit access, and only when its
 * rules object is empty (an admin can narrow it explicitly). This keeps the
 * stored document readable while preserving fail-closed behaviour for every
 * other profile.
 */
export function effectiveRules(
  profile: SecurityProfile,
  tables: string[],
): Record<string, TableRule> {
  if (profile.name === "Admin" && Object.keys(profile.rules).length === 0) {
    const rules: Record<string, TableRule> = {};
    for (const t of tables) {
      rules[t] = {
        create: { fields: "*" },
        delete: true,
        read: { fields: "*" },
        update: { fields: "*" },
      };
    }
    return rules;
  }
  return profile.rules;
}

/** Resolve a profile against the app's tables (Admin expansion applied). */
export function resolveProfile(
  profile: SecurityProfile,
  tables: string[],
): SecurityProfile {
  return { ...profile, rules: effectiveRules(profile, tables) };
}
