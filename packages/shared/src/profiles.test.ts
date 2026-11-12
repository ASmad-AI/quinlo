import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  evaluateAccess,
  filterReadableFields,
  rejectedWriteFields,
  resolveProfile,
  validateProfile,
  type AccessContext,
  type SecurityProfile,
} from "./profiles";

const NOW = "2026-11-12T00:00:00.000Z";

function profile(rules: SecurityProfile["rules"], name = "Member"): SecurityProfile {
  return { appId: "app_1", createdAt: NOW, id: "p1", name, rules, updatedAt: NOW };
}

function ctx(p: SecurityProfile, userId = "user_1"): AccessContext {
  return { orgId: "org_1", profile: p, userEmail: "a@example.com", userId };
}

describe("Profile Lock: fail-closed defaults", () => {
  test("no rule for a table denies every operation", () => {
    const c = ctx(profile({}));
    for (const op of ["read", "create", "update", "delete"] as const) {
      assert.equal(evaluateAccess("tasks", op, c).allowed, false);
    }
  });

  test("explicit false denies, and missing operation denies", () => {
    const c = ctx(profile({ tasks: { read: { fields: ["title"] }, update: false } }));
    assert.equal(evaluateAccess("tasks", "read", c, { allFields: ["title", "cost"] }).allowed, true);
    assert.equal(evaluateAccess("tasks", "update", c).allowed, false);
    assert.equal(evaluateAccess("tasks", "delete", c).allowed, false);
    assert.equal(evaluateAccess("tasks", "create", c).allowed, false);
  });

  test("Guest with empty rules denies everything", () => {
    const c = ctx(profile({}, "Guest"));
    assert.equal(evaluateAccess("tasks", "read", c).allowed, false);
  });

  test("unknown delete rule shape denies", () => {
    const bad = profile({ tasks: { delete: "yes" as unknown as boolean } });
    assert.equal(evaluateAccess("tasks", "delete", ctx(bad)).allowed, false);
  });
});

describe("Profile Lock: Admin expansion", () => {
  test("Admin with empty rules gets full access to known tables only", () => {
    const admin = resolveProfile(profile({}, "Admin"), ["tasks", "notes"]);
    const c = ctx(admin);
    assert.equal(evaluateAccess("tasks", "delete", c).allowed, true);
    assert.equal(evaluateAccess("unknown_table", "read", c).allowed, false);
  });

  test("Admin with explicit rules is NOT expanded (narrowing sticks)", () => {
    const admin = resolveProfile(
      profile({ tasks: { read: { fields: ["title"] } } }, "Admin"),
      ["tasks"],
    );
    const c = ctx(admin);
    assert.equal(evaluateAccess("tasks", "delete", c).allowed, false);
    const d = evaluateAccess("tasks", "read", c, { allFields: ["title", "cost"] });
    assert.deepEqual([...(d.allowedFields ?? [])], ["title"]);
  });
});

describe("Profile Lock: fields", () => {
  test("read returns only whitelisted fields; system fields always pass through", () => {
    const c = ctx(profile({ tasks: { read: { fields: ["title"] } } }));
    const d = evaluateAccess("tasks", "read", c, { allFields: ["title", "cost", "secret_note"] });
    assert.deepEqual([...(d.allowedFields ?? [])], ["title"]);
    const filtered = filterReadableFields(
      { cost: 9, created_at: "x", id: "r1", org_id: "org_1", secret_note: "s", title: "T" },
      d.allowedFields as Set<string>,
    );
    assert.deepEqual(filtered, { created_at: "x", id: "r1", org_id: "org_1", title: "T" });
  });

  test('"*" with denyFields excludes denied fields; without a field list it denies all', () => {
    const c = ctx(
      profile({ tasks: { read: { denyFields: ["internal_cost"], fields: "*" } } }),
    );
    const d = evaluateAccess("tasks", "read", c, { allFields: ["title", "internal_cost"] });
    assert.deepEqual([...(d.allowedFields ?? [])], ["title"]);
    const noSchema = evaluateAccess("tasks", "read", c);
    assert.equal(noSchema.allowedFields?.size, 0);
  });

  test("write payloads reject system fields and non-whitelisted fields", () => {
    const allowed = new Set(["title"]);
    assert.deepEqual(rejectedWriteFields({ title: "T" }, allowed), []);
    assert.deepEqual(rejectedWriteFields({ cost: 1, org_id: "org_2", title: "T" }, allowed), [
      "cost",
      "org_id",
    ]);
  });
});

describe("Profile Lock: row conditions", () => {
  const ownOnly = profile({
    tasks: {
      read: { fields: "*", row: [{ field: "owner_id", op: "eq", value: "$user.id" }] },
      update: {
        fields: ["title"],
        row: [{ field: "owner_id", op: "eq", value: "$user.id" }],
      },
    },
  });

  test("owner can read/update own rows, not others", () => {
    const c = ctx(ownOnly, "user_1");
    const mine = { owner_id: "user_1", title: "a" };
    const theirs = { owner_id: "user_2", title: "b" };
    assert.equal(evaluateAccess("tasks", "read", c, { allFields: ["title"], row: mine }).allowed, true);
    assert.equal(evaluateAccess("tasks", "read", c, { allFields: ["title"], row: theirs }).allowed, false);
    assert.equal(evaluateAccess("tasks", "update", c, { row: theirs }).allowed, false);
  });

  test("$org.id resolves to the caller org", () => {
    const p = profile({
      tasks: { read: { fields: "*", row: [{ field: "org_id", op: "eq", value: "$org.id" }] } },
    });
    const c = ctx(p);
    assert.equal(
      evaluateAccess("tasks", "read", c, { allFields: ["title"], row: { org_id: "org_1" } }).allowed,
      true,
    );
    assert.equal(
      evaluateAccess("tasks", "read", c, { allFields: ["title"], row: { org_id: "org_2" } }).allowed,
      false,
    );
  });

  test("delete with row conditions requires a row and enforces it", () => {
    const p = profile({
      tasks: { delete: [{ field: "status", op: "eq", value: "draft" }] },
    });
    const c = ctx(p);
    assert.equal(evaluateAccess("tasks", "delete", c).allowed, false);
    assert.equal(evaluateAccess("tasks", "delete", c, { row: { status: "draft" } }).allowed, true);
    assert.equal(evaluateAccess("tasks", "delete", c, { row: { status: "live" } }).allowed, false);
  });

  test("unknown condition operator fails closed", () => {
    const p = profile({
      tasks: {
        read: { fields: "*", row: [{ field: "x", op: "like" as never, value: "y" }] },
      },
    });
    assert.equal(
      evaluateAccess("tasks", "read", ctx(p), { allFields: ["x"], row: { x: "y" } }).allowed,
      false,
    );
  });
});

describe("validateProfile", () => {
  test("accepts a well-formed profile", () => {
    assert.deepEqual(
      validateProfile({
        name: "Member",
        rules: { tasks: { read: { fields: ["title"] }, delete: false } },
      }),
      [],
    );
  });

  test("rejects bad names, tables, ops, fields, and conditions", () => {
    const errors = validateProfile({
      name: "",
      rules: {
        "bad-name!": { read: { fields: ["ok"] } },
        tasks: {
          fly: { fields: ["x"] },
          read: { fields: ["bad field"] },
          update: { fields: "*", row: [{ field: "x", op: "like", value: 1 }] },
        },
      },
    });
    assert.ok(errors.length >= 5, errors.join("; "));
  });
});
