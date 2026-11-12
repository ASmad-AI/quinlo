import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import { MemoryStore, type App } from "./store";
import { WebhookService, buildEnvelope } from "./webhooks";

function fakeApp(): App {
  return {
    auth_config: { oauth: [], orgIsolation: true, providers: ["email"] },
    created_at: new Date().toISOString(),
    created_by: "user_1",
    description: "",
    id: "app_1",
    name: "Hooks App",
    org_id: "org_1",
    slug: "hooks-app",
    updated_at: new Date().toISOString(),
  };
}

describe("outbound webhooks", () => {
  test("envelope shape is automation-tool friendly", () => {
    const env = buildEnvelope("on_record_created", fakeApp(), { record: { id: "r1" } }, "2026-11-12T00:00:00.000Z");
    assert.deepEqual(env, {
      app_id: "app_1",
      app_slug: "hooks-app",
      data: { record: { id: "r1" } },
      event: "on_record_created",
      org_id: "org_1",
      timestamp: "2026-11-12T00:00:00.000Z",
    });
  });

  test("dispatch signs the body and records a delivery", async () => {
    const store = new MemoryStore();
    const app = fakeApp();
    await store.createApp(app);
    const seen: Array<{ body: string; headers: Record<string, string>; url: string }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      seen.push({ body: String(init?.body ?? ""), headers: init?.headers as Record<string, string>, url });
      return new Response("{}", { status: 200 });
    };
    const svc = new WebhookService(store, fetchFn as never);
    const endpoint = await svc.createEndpoint("org_1", "app_1", {
      events: ["on_record_created"],
      url: "https://hooks.example.com/catch",
    });
    await svc.dispatch("on_record_created", app, { record: { id: "r1" } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers["x-forge-event"], "on_record_created");
    const expected = `sha256=${createHmac("sha256", endpoint.secret).update(seen[0].body).digest("hex")}`;
    assert.equal(seen[0].headers["x-forge-signature"], expected);
    const deliveries = await store.listDeliveries(endpoint.id);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].status, "delivered");
    assert.equal(deliveries[0].attempts, 1);
    svc.close();
  });

  test("unsubscribed events are not delivered; http non-local URLs rejected", async () => {
    const store = new MemoryStore();
    const svc = new WebhookService(store, (async () => new Response("{}", { status: 200 })) as never);
    await svc.createEndpoint("org_1", "app_1", { events: ["on_user_signup"], url: "https://hooks.example.com/x" });
    let calls = 0;
    const counting = new WebhookService(store, (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as never);
    await counting.dispatch("on_record_created", fakeApp(), {});
    assert.equal(calls, 0);
    await assert.rejects(
      () => svc.createEndpoint("org_1", "app_1", { events: ["on_user_signup"], url: "http://hooks.example.com/x" }),
      /must use https/,
    );
    await assert.rejects(
      () => svc.createEndpoint("org_1", "app_1", { events: ["on_nope"], url: "https://hooks.example.com/x" }),
      /Unknown webhook events/,
    );
    svc.close();
    counting.close();
  });

  test("failing receiver retries to 5 attempts and ends failed; flaky receiver recovers", async () => {
    const store = new MemoryStore();
    const app = fakeApp();
    await store.createApp(app);
    // Immediate retries in tests (delay function resolves at once).
    let attempts = 0;
    const failing = new WebhookService(
      store,
      (async () => {
        attempts++;
        return new Response("boom", { status: 500 });
      }) as never,
      async () => undefined,
    );
    const endpoint = await failing.createEndpoint("org_1", "app_1", {
      events: ["on_user_signup"],
      url: "https://hooks.example.com/fail",
    });
    await failing.dispatch("on_user_signup", app, {});
    // Retries are scheduled asynchronously; wait for them to drain.
    const deadline = Date.now() + 2000;
    let deliveries = await store.listDeliveries(endpoint.id);
    while (deliveries[0]?.status === "pending" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
      deliveries = await store.listDeliveries(endpoint.id);
    }
    assert.equal(attempts, 5);
    assert.equal(deliveries[0].status, "failed");
    assert.equal(deliveries[0].attempts, 5);
    failing.close();

    // Flaky: fail twice, then succeed. Fresh store: dispatch delivers to
    // every subscribed endpoint, so reusing the store would also redeliver
    // to the failing endpoint and inflate the attempt count.
    const store2 = new MemoryStore();
    await store2.createApp(app);
    let flakyAttempts = 0;
    const flaky = new WebhookService(
      store2,
      (async () => {
        flakyAttempts++;
        return new Response("{}", { status: flakyAttempts < 3 ? 500 : 200 });
      }) as never,
      async () => undefined,
    );
    const endpoint2 = await flaky.createEndpoint("org_1", "app_1", {
      events: ["on_user_signup"],
      url: "https://hooks.example.com/flaky",
    });
    await flaky.dispatch("on_user_signup", app, {});
    const deadline2 = Date.now() + 2000;
    let d2 = await store2.listDeliveries(endpoint2.id);
    while (d2[0]?.status === "pending" && Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 5));
      d2 = await store2.listDeliveries(endpoint2.id);
    }
    assert.equal(flakyAttempts, 3);
    assert.equal(d2[0].status, "delivered");
    flaky.close();
  });
});
