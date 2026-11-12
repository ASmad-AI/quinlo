import {
  assertAccess,
  evaluateAccess,
  filterReadableFields,
  ForgeError,
  isValidFieldName,
  newId,
  profileDenied,
  rejectedWriteFields,
  stampOrgId,
  testRowConditions,
  type AccessContext,
  type FieldRule,
  type SecurityProfile,
} from "@openforge/shared";
import type { AttributeDef } from "@openforge/mcp-server";
import type { AuthService } from "./auth";
import type { Principal } from "./http";
import type { App, CollectionSchema, StoredRecord, Store } from "./store";

/**
 * Record CRUD with all three enforcement layers, in order:
 *  1. Tenant isolation — the store only ever returns the caller's org rows,
 *     and writes are stamped with the caller's org id.
 *  2. Profile Lock — operation + field + row-condition checks from the
 *     caller's resolved profile. Denied operations are 403s; rows failing
 *     row conditions read as 404 (no existence leak).
 *  3. Schema validation — attribute types, required fields, unknown-field
 *     rejection, uniqueness.
 */

export interface EventSink {
  audit(event: {
    action: string;
    actorId: string;
    actorType: "api_key" | "mcp" | "system" | "user";
    appId?: string;
    detail?: Record<string, unknown>;
    orgId: string;
  }): Promise<void>;
  publish(orgId: string, appId: string, event: { data: unknown; type: string }): void;
  webhook(
    event: "on_record_created" | "on_record_updated" | "on_record_deleted" | "on_user_signup" | "on_payment_succeeded",
    app: App,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

export interface RecordView {
  app_id: string;
  collection: string;
  created_at: string;
  created_by: string;
  id: string;
  org_id: string;
  updated_at: string;
  [key: string]: unknown;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateFieldValue(attr: AttributeDef, value: unknown): string | null {
  if (value === null || value === undefined) {
    return attr.required ? `field "${attr.name}" is required` : null;
  }
  switch (attr.type) {
    case "string":
      return typeof value === "string" ? null : `field "${attr.name}" must be a string`;
    case "integer":
      return Number.isInteger(value) ? null : `field "${attr.name}" must be an integer`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `field "${attr.name}" must be a number`;
    case "boolean":
      return typeof value === "boolean" ? null : `field "${attr.name}" must be a boolean`;
    case "datetime":
      return typeof value === "string" && !Number.isNaN(Date.parse(value))
        ? null
        : `field "${attr.name}" must be an ISO date-time string`;
    case "email":
      return typeof value === "string" && EMAIL_RE.test(value)
        ? null
        : `field "${attr.name}" must be a valid email address`;
    case "url":
      try {
        if (typeof value !== "string") return `field "${attr.name}" must be a URL string`;
        new URL(value);
        return null;
      } catch {
        return `field "${attr.name}" must be a valid URL`;
      }
    case "json":
      return null;
    default:
      return `unknown attribute type for "${attr.name}"`;
  }
}

export function validatePayloadAgainstSchema(
  schema: CollectionSchema,
  payload: Record<string, unknown>,
  opts: { partial: boolean },
): string[] {
  const errors: string[] = [];
  const known = new Set(schema.attributes.map((a) => a.name));
  for (const key of Object.keys(payload)) {
    if (!known.has(key)) errors.push(`unknown field "${key}" for collection "${schema.name}"`);
    if (!isValidFieldName(key)) errors.push(`invalid field name "${key}"`);
  }
  for (const attr of schema.attributes) {
    const present = keyPresent(payload, attr.name);
    if (!present && attr.required && !opts.partial) {
      errors.push(`field "${attr.name}" is required`);
      continue;
    }
    if (present) {
      const err = validateFieldValue(attr, payload[attr.name]);
      if (err) errors.push(err);
    }
  }
  return errors;
}

function keyPresent(payload: Record<string, unknown>, key: string): boolean {
  return key in payload && payload[key] !== undefined && payload[key] !== null;
}

const SYSTEM_WRITE_FIELDS = new Set(["id", "org_id", "created_at", "updated_at", "created_by"]);

/** System fields are server-managed; smuggling one in is a 403, not a 400. */
function assertNoSystemFields(payload: Record<string, unknown>): void {
  const smuggled = Object.keys(payload).filter((k) => SYSTEM_WRITE_FIELDS.has(k));
  if (smuggled.length > 0) {
    throw profileDenied(`system fields are not writable: ${smuggled.join(", ")}`);
  }
}

function readRule(profile: SecurityProfile, table: string): FieldRule | undefined {
  const entry = profile.rules[table]?.read;
  if (entry && typeof entry === "object") return entry as FieldRule;
  return undefined;
}

export class RecordService {
  constructor(
    private readonly store: Store,
    private readonly auth: AuthService,
    private readonly events: EventSink,
  ) {}

  private async load(
    principal: Principal,
    appId: string,
    collection: string,
  ): Promise<{ app: App; profile: SecurityProfile; schema: CollectionSchema }> {
    const app = await this.auth.requireApp(principal, appId);
    const schema = await this.store.getCollection(principal.orgId, appId, collection);
    if (!schema) throw new ForgeError("not_found", `Collection "${collection}" not found`, 404);
    const profile = await this.auth.resolveProfileForApp(principal, app);
    return { app, profile, schema };
  }

  private accessContext(principal: Principal, profile: SecurityProfile): AccessContext {
    return {
      orgId: principal.orgId,
      profile,
      userEmail: principal.email,
      userId: principal.userId,
    };
  }

  private view(record: StoredRecord, allowedFields: Set<string>): RecordView {
    const fields = filterReadableFields(record.fields, allowedFields);
    return {
      app_id: record.app_id,
      collection: record.collection,
      created_at: record.created_at,
      created_by: record.created_by,
      id: record.id,
      org_id: record.org_id,
      updated_at: record.updated_at,
      ...fields,
    };
  }

  async list(
    principal: Principal,
    appId: string,
    collection: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ records: RecordView[]; total: number }> {
    const { profile, schema } = await this.load(principal, appId, collection);
    const ctx = this.accessContext(principal, profile);
    const allFields = schema.attributes.map((a) => a.name);
    const allowed = assertAccess(collection, "read", ctx, { allFields });
    const rule = readRule(profile, collection);
    const rows = await this.store.listRecords(principal.orgId, appId, collection);
    // Row conditions filter silently: rows the caller may not see are
    // simply absent, exactly like tenant isolation.
    const visible = rows.filter((r) =>
      testRowConditions({ ...r.fields, org_id: r.org_id }, rule?.row, ctx),
    );
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const page = visible.slice(offset, offset + limit);
    const allowedFields = allowed ?? new Set<string>();
    return { records: page.map((r) => this.view(r, allowedFields)), total: visible.length };
  }

  async get(principal: Principal, appId: string, collection: string, id: string): Promise<RecordView> {
    const { profile, schema } = await this.load(principal, appId, collection);
    const ctx = this.accessContext(principal, profile);
    const allFields = schema.attributes.map((a) => a.name);
    const allowed = assertAccess(collection, "read", ctx, { allFields });
    const record = await this.store.getRecord(principal.orgId, appId, collection, id);
    if (!record) throw new ForgeError("not_found", "Record not found", 404);
    const rule = readRule(profile, collection);
    if (!testRowConditions({ ...record.fields, org_id: record.org_id }, rule?.row, ctx)) {
      throw new ForgeError("not_found", "Record not found", 404);
    }
    return this.view(record, allowed ?? new Set<string>());
  }

  async create(
    principal: Principal,
    appId: string,
    collection: string,
    payload: Record<string, unknown>,
  ): Promise<RecordView> {
    const { app, profile, schema } = await this.load(principal, appId, collection);
    const ctx = this.accessContext(principal, profile);
    const allFields = schema.attributes.map((a) => a.name);
    const allowed = assertAccess(collection, "create", ctx, { allFields });
    const allowedFields = allowed ?? new Set<string>();
    assertNoSystemFields(payload);
    // Schema validation runs before the field-level profile check so that
    // malformed payloads get a useful 400; the operation-level check above
    // already refused callers with no create permission at all.
    const schemaErrors = validatePayloadAgainstSchema(schema, payload, { partial: false });
    if (schemaErrors.length > 0) {
      throw new ForgeError("validation", `Invalid record: ${schemaErrors.join("; ")}`, 400, schemaErrors);
    }
    const rejected = rejectedWriteFields(payload, allowedFields);
    if (rejected.length > 0) {
      throw profileDenied(`fields not writable under profile "${profile.name}": ${rejected.join(", ")}`);
    }
    await this.assertUnique(principal, appId, collection, schema, payload, null);
    const now = new Date().toISOString();
    const stamped = stampOrgId(payload, principal.orgId);
    const { org_id: _org, ...fields } = stamped;
    const record: StoredRecord = {
      app_id: appId,
      collection,
      created_at: now,
      created_by: principal.userId,
      fields: { ...fields },
      id: newId("rec"),
      org_id: principal.orgId,
      updated_at: now,
    };
    await this.store.createRecord(record);
    const view = this.view(record, allowedFields);
    await this.events.audit({
      action: "record.created",
      actorId: principal.userId,
      actorType: principal.type,
      appId,
      detail: { collection, recordId: record.id },
      orgId: principal.orgId,
    });
    this.events.publish(principal.orgId, appId, { data: view, type: "record.created" });
    await this.events.webhook("on_record_created", app, { collection, record: view });
    return view;
  }

  async update(
    principal: Principal,
    appId: string,
    collection: string,
    id: string,
    payload: Record<string, unknown>,
  ): Promise<RecordView> {
    const { app, profile, schema } = await this.load(principal, appId, collection);
    const ctx = this.accessContext(principal, profile);
    const existing = await this.store.getRecord(principal.orgId, appId, collection, id);
    if (!existing) throw new ForgeError("not_found", "Record not found", 404);
    const rowForChecks = { ...existing.fields, org_id: existing.org_id };
    const decision = evaluateAccess(collection, "update", ctx, { allFields: schema.attributes.map((a) => a.name), row: rowForChecks });
    if (!decision.allowed) {
      // Row-condition failure reads as 404; operation denial is a 403.
      const rule = profile.rules[collection]?.update;
      if (rule && typeof rule === "object" && (rule as FieldRule).row?.length) {
        throw new ForgeError("not_found", "Record not found", 404);
      }
      throw profileDenied(decision.reason);
    }
    const allowedFields = decision.allowedFields ?? new Set<string>();
    assertNoSystemFields(payload);
    const merged = { ...existing.fields, ...payload };
    const schemaErrors = validatePayloadAgainstSchema(schema, merged, { partial: false });
    if (schemaErrors.length > 0) {
      throw new ForgeError("validation", `Invalid record: ${schemaErrors.join("; ")}`, 400, schemaErrors);
    }
    const rejected = rejectedWriteFields(payload, allowedFields);
    if (rejected.length > 0) {
      throw profileDenied(`fields not writable under profile "${profile.name}": ${rejected.join(", ")}`);
    }
    await this.assertUnique(principal, appId, collection, schema, payload, id);
    const updated: StoredRecord = {
      ...existing,
      fields: merged,
      updated_at: new Date().toISOString(),
    };
    await this.store.updateRecord(updated);
    const view = this.view(updated, allowedFields);
    await this.events.audit({
      action: "record.updated",
      actorId: principal.userId,
      actorType: principal.type,
      appId,
      detail: { collection, recordId: id },
      orgId: principal.orgId,
    });
    this.events.publish(principal.orgId, appId, { data: view, type: "record.updated" });
    await this.events.webhook("on_record_updated", app, { collection, record: view });
    return view;
  }

  async delete(principal: Principal, appId: string, collection: string, id: string): Promise<void> {
    const { app, profile } = await this.load(principal, appId, collection);
    const ctx = this.accessContext(principal, profile);
    const existing = await this.store.getRecord(principal.orgId, appId, collection, id);
    if (!existing) throw new ForgeError("not_found", "Record not found", 404);
    const rowForChecks = { ...existing.fields, org_id: existing.org_id };
    const decision = evaluateAccess(collection, "delete", ctx, { row: rowForChecks });
    if (!decision.allowed) {
      const rule = profile.rules[collection]?.delete;
      if (Array.isArray(rule)) {
        throw new ForgeError("not_found", "Record not found", 404);
      }
      throw profileDenied(decision.reason);
    }
    await this.store.deleteRecord(principal.orgId, appId, collection, id);
    await this.events.audit({
      action: "record.deleted",
      actorId: principal.userId,
      actorType: principal.type,
      appId,
      detail: { collection, recordId: id },
      orgId: principal.orgId,
    });
    this.events.publish(principal.orgId, appId, { data: { collection, id }, type: "record.deleted" });
    await this.events.webhook("on_record_deleted", app, { collection, recordId: id });
  }

  private async assertUnique(
    principal: Principal,
    appId: string,
    collection: string,
    schema: CollectionSchema,
    payload: Record<string, unknown>,
    excludeId: string | null,
  ): Promise<void> {
    const uniqueAttrs = schema.attributes.filter((a) => a.unique);
    const uniqueIndexes = schema.indexes.filter((ix) => ix.unique);
    if (uniqueAttrs.length === 0 && uniqueIndexes.length === 0) return;
    const rows = await this.store.listRecords(principal.orgId, appId, collection);
    for (const attr of uniqueAttrs) {
      const value = payload[attr.name];
      if (value === undefined || value === null) continue;
      const clash = rows.find((r) => r.id !== excludeId && r.fields[attr.name] === value);
      if (clash) {
        throw new ForgeError("conflict", `Duplicate value for unique field "${attr.name}"`, 409);
      }
    }
    for (const ix of uniqueIndexes) {
      const values = ix.fields.map((f) => payload[f]);
      if (values.some((v) => v === undefined)) continue;
      const clash = rows.find(
        (r) => r.id !== excludeId && ix.fields.every((f, i) => r.fields[f] === values[i]),
      );
      if (clash) {
        throw new ForgeError("conflict", `Duplicate value for unique index (${ix.fields.join(", ")})`, 409);
      }
    }
  }
}
