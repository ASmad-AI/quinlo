import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertValid, validateAgainstSchema } from "./validation";
import { orgFilter, stampOrgId, assertBelongsToOrg } from "./tenants";

describe("JSON schema validator", () => {
  test("required, types, and additionalProperties", () => {
    const schema = {
      additionalProperties: false,
      properties: { name: { minLength: 1, type: "string" }, n: { type: "integer" } },
      required: ["name"],
      type: "object",
    };
    assert.deepEqual(validateAgainstSchema({ name: "x", n: 2 }, schema), []);
    assert.ok(validateAgainstSchema({ n: 2 }, schema).some((i) => i.message.includes("name")));
    assert.ok(validateAgainstSchema({ extra: 1, name: "x" }, schema).length > 0);
    assert.ok(validateAgainstSchema({ name: "x", n: 1.5 }, schema).length > 0);
    assert.ok(validateAgainstSchema({ name: "" }, schema).length > 0);
  });

  test("enum, arrays, patterns, numbers", () => {
    assert.deepEqual(validateAgainstSchema("b", { enum: ["a", "b"] }), []);
    assert.ok(validateAgainstSchema("c", { enum: ["a", "b"] }).length > 0);
    assert.deepEqual(validateAgainstSchema([1, 2], { items: { type: "integer" }, minItems: 1, type: "array" }), []);
    assert.ok(validateAgainstSchema([], { minItems: 1, type: "array" }).length > 0);
    assert.ok(validateAgainstSchema("abc", { pattern: "^[0-9]+$" }).length > 0);
    assert.ok(validateAgainstSchema(5, { maximum: 4, type: "number" }).length > 0);
    assert.ok(validateAgainstSchema("nope", { format: "email", type: "string" }).length > 0);
  });

  test("assertValid throws a ForgeError-shaped error", () => {
    assert.throws(
      () => assertValid({ name: 1 }, { properties: { name: { type: "string" } }, type: "object" }, "input"),
      (e: unknown) => {
        const err = e as { code?: string; status?: number };
        return err.code === "validation" && err.status === 400;
      },
    );
  });
});

describe("tenant stamping", () => {
  test("stampOrgId drops client-supplied org_id/tenant_id and stamps the caller org", () => {
    assert.deepEqual(stampOrgId({ org_id: "org_evil", tenant_id: "t2", title: "T" }, "org_1"), {
      org_id: "org_1",
      title: "T",
    });
  });

  test("orgFilter and assertBelongsToOrg enforce membership", () => {
    const rows = [{ org_id: "org_1" }, { org_id: "org_2" }];
    assert.deepEqual(rows.filter(orgFilter("org_1")), [{ org_id: "org_1" }]);
    assert.throws(() => assertBelongsToOrg({ org_id: "org_2" }, "org_1"));
    assert.doesNotThrow(() => assertBelongsToOrg({ org_id: "org_1" }, "org_1"));
  });
});
