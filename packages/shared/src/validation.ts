/**
 * Minimal deterministic JSON Schema validator (subset of draft 2020-12).
 *
 * Supported keywords: type, enum, const, required, properties,
 * additionalProperties, items, minItems, maxItems, minLength, maxLength,
 * pattern, minimum, maximum, multipleOf, format (email, uri, date-time —
 * best-effort checks). Unknown keywords are ignored. No $ref support:
 * tool schemas must be self-contained. Dependency-free on purpose: the
 * same validator runs in the MCP server, the REST API, and the Studio.
 */

export type JsonSchema = {
  additionalProperties?: boolean | JsonSchema;
  const?: unknown;
  enum?: unknown[];
  format?: string;
  items?: JsonSchema;
  maxItems?: number;
  maxLength?: number;
  maximum?: number;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  multipleOf?: number;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  type?: string | string[];
  [key: string]: unknown;
};

export interface ValidationIssue {
  message: string;
  path: string;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  return typeOf(value) === type;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path = "$",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (message: string) => issues.push({ message, path });

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    fail(`must equal ${JSON.stringify(schema.const)}`);
    return issues;
  }

  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(value, e))) {
    fail(`must be one of ${JSON.stringify(schema.enum)}`);
    return issues;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      fail(`must be of type ${types.join(" | ")}, got ${typeOf(value)}`);
      return issues;
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(`must have at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      fail(`must have at most ${schema.maxLength} characters`);
    }
    if (schema.pattern !== undefined) {
      let re: RegExp;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        fail(`schema pattern is not a valid regular expression`);
        return issues;
      }
      if (!re.test(value)) fail(`must match pattern ${schema.pattern}`);
    }
    if (schema.format === "email" && !EMAIL_RE.test(value)) {
      fail("must be a valid email address");
    }
    if (schema.format === "uri") {
      try {
        new URL(value);
      } catch {
        fail("must be a valid URI");
      }
    }
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
      fail("must be a valid date-time string");
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail(`must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      fail(`must be <= ${schema.maximum}`);
    }
    if (schema.multipleOf !== undefined && value % schema.multipleOf !== 0) {
      fail(`must be a multiple of ${schema.multipleOf}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(`must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(`must contain at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        issues.push(...validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${i}]`));
      });
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) {
        issues.push({ message: `missing required property "${key}"`, path });
      }
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj && obj[key] !== undefined) {
        issues.push(...validateAgainstSchema(obj[key], sub, `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          issues.push({ message: `additional property "${key}" is not allowed`, path });
        }
      }
    } else if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties === "object"
    ) {
      for (const [key, v] of Object.entries(obj)) {
        if (!(key in props)) {
          issues.push(
            ...validateAgainstSchema(v, schema.additionalProperties as JsonSchema, `${path}.${key}`),
          );
        }
      }
    }
  }

  return issues;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keysA = Object.keys(ao);
    const keysB = Object.keys(bo);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => k in bo && deepEqual(ao[k], bo[k]));
  }
  return false;
}

/** Validate and throw a ForgeError("validation") listing every issue. */
export function assertValid(value: unknown, schema: JsonSchema, what: string): void {
  const issues = validateAgainstSchema(value, schema);
  if (issues.length > 0) {
    const detail = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    // Import cycle avoidance: construct the error without importing errors.ts.
    const err = new Error(`${what} is invalid: ${detail}`) as Error & {
      code: string;
      status: number;
      details: unknown;
    };
    err.name = "ForgeError";
    err.code = "validation";
    err.status = 400;
    err.details = issues;
    throw err;
  }
}
