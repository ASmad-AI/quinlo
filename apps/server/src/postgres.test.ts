import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildDelete,
  buildGet,
  buildGetByJsonField,
  buildGetByScope,
  buildList,
  buildUpsert,
  ENTITIES_TABLE_SQL,
  PostgresStore,
} from "./postgres";

describe("Postgres SQL builders", () => {
  test("schema SQL creates the entities table and indexes", () => {
    assert.ok(ENTITIES_TABLE_SQL.includes("CREATE TABLE IF NOT EXISTS forge_entities"));
    assert.ok(ENTITIES_TABLE_SQL.includes("data JSONB"));
    assert.ok(ENTITIES_TABLE_SQL.includes("forge_entities_org_app_idx"));
  });

  test("every scoped query carries an org_id predicate and is parameterized", () => {
    const get = buildGet("record", "r1", "org_1");
    assert.ok(get.text.includes("org_id = $3"));
    assert.deepEqual(get.values, ["record", "r1", "org_1"]);
    assert.ok(!get.text.includes("org_1"), "org id must be a parameter, not interpolated");

    const byScope = buildGetByScope("record", "app_1", "tasks", "org_1");
    assert.ok(byScope.text.includes("org_id = $4"));

    const list = buildList("record", "org_1", "app_1", "tasks");
    assert.ok(list.text.includes("org_id = $2"));
    assert.ok(list.text.includes("app_id = $3"));
    assert.ok(list.text.includes("scope = $4"));

    const del = buildDelete("record", "r1", "org_1");
    assert.ok(del.text.includes("org_id = $3"));

    const upsert = buildUpsert("record", "r1", "org_1", "app_1", "tasks", { a: 1 });
    assert.ok(upsert.text.includes("ON CONFLICT"));
    assert.equal(upsert.values.length, 6);
  });

  test("JSON-field lookups validate the field name", () => {
    const q = buildGetByJsonField("api_key", "key_hash", "abc");
    assert.ok(q.text.includes("data ->> $2"));
    assert.throws(() => buildGetByJsonField("api_key", "key_hash; DROP TABLE x; --", "abc"), /Invalid JSON field/);
  });

  test("live Postgres round-trip (skipped without DATABASE_URL)", async (t) => {
    const url = process.env.DATABASE_URL;
    if (!url) {
      t.skip("DATABASE_URL not set; live Postgres verification is outstanding (see VERIFICATION.md)");
      return;
    }
    const store = new PostgresStore(url);
    try {
      await store.ensureSchema();
      const now = new Date().toISOString();
      await store.createOrg({ created_at: now, id: "org_pg_test", name: "PG Test", slug: "pg-test" });
      const org = await store.getOrg("org_pg_test");
      assert.equal(org?.name, "PG Test");
      await store.createApp({
        auth_config: { oauth: [], orgIsolation: true, providers: ["email"] },
        created_at: now,
        created_by: "user_1",
        description: "",
        id: "app_pg_test",
        name: "PG App",
        org_id: "org_pg_test",
        slug: "pg-app",
        updated_at: now,
      });
      assert.equal((await store.getApp("org_pg_test", "app_pg_test"))?.name, "PG App");
      assert.equal(await store.getApp("org_other", "app_pg_test"), null, "cross-org read must miss");
    } finally {
      await store.close();
    }
  });
});
