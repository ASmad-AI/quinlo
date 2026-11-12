import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, test } from "node:test";
import { hmacHex } from "@openforge/shared";
import { BillingService } from "./billing";
import { MemoryStore, type App } from "./store";
import { VaultService } from "./vault";
import { testConfig } from "./testutil";

function fakeApp(): App {
  return {
    auth_config: { oauth: [], orgIsolation: true, providers: ["email"] },
    created_at: new Date().toISOString(),
    created_by: "user_1",
    description: "",
    id: "app_1",
    name: "Billing App",
    org_id: "org_1",
    slug: "billing-app",
    updated_at: new Date().toISOString(),
  };
}

/** Minimal stub Stripe API: records requests, returns canned ids. */
async function stubStripe() {
  const calls: Array<{ body: string; path: string }> = [];
  let counter = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ body, path: req.url ?? "" });
      counter += 1;
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.startsWith("/v1/products")) {
        res.end(JSON.stringify({ id: `prod_${counter}` }));
      } else if (req.url?.startsWith("/v1/prices")) {
        res.end(JSON.stringify({ id: `price_${counter}` }));
      } else if (req.url?.startsWith("/v1/checkout/sessions")) {
        res.end(JSON.stringify({ id: `cs_${counter}`, url: "https://checkout.stripe.test/session" }));
      } else if (req.url?.startsWith("/v1/billing_portal/sessions")) {
        res.end(JSON.stringify({ url: "https://billing.stripe.test/portal" }));
      } else {
        res.end(JSON.stringify({}));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("billing", () => {
  test("setupPlans without a Stripe key stores local plans; checkout refuses honestly", async () => {
    const store = new MemoryStore();
    const app = fakeApp();
    await store.createApp(app);
    const vault = new VaultService(store, "master");
    const billing = new BillingService(store, vault, testConfig(), {
      audit: async () => undefined,
      webhook: async () => undefined,
    });
    const plans = await billing.setupPlans(app, [
      { currency: "usd", interval: "month", name: "Pro", priceCents: 1999 },
    ], "user_1");
    assert.equal(plans.length, 1);
    assert.equal(plans[0].stripe_price_id, null);
    assert.equal(plans[0].mode, "test");
    await assert.rejects(
      () => billing.createCheckout(app, plans[0].id, { cancelUrl: "https://x/c", successUrl: "https://x/s" }),
      /Stripe is not connected/,
    );
  });

  test("setupPlans with a key mirrors to Stripe; checkout + portal work via the stub", async () => {
    const stripe = await stubStripe();
    try {
      const store = new MemoryStore();
      const app = fakeApp();
      await store.createApp(app);
      const vault = new VaultService(store, "master");
      await vault.set("org_1", "app_1", "STRIPE_SECRET_KEY", "sk_test_123");
      const billing = new BillingService(store, vault, testConfig({ stripeApiBaseUrl: stripe.baseUrl }), {
        audit: async () => undefined,
        webhook: async () => undefined,
      });
      const plans = await billing.setupPlans(app, [
        { currency: "usd", interval: "month", name: "Pro", priceCents: 1999 },
      ], "user_1");
      assert.ok(plans[0].stripe_product_id?.startsWith("prod_"));
      assert.ok(plans[0].stripe_price_id?.startsWith("price_"));
      assert.ok(stripe.calls.some((c) => c.path === "/v1/products" && c.body.includes("name=Pro")));
      assert.ok(stripe.calls.some((c) => c.path === "/v1/prices" && c.body.includes("unit_amount=1999")));

      const checkout = await billing.createCheckout(app, plans[0].id, {
        cancelUrl: "https://x/c",
        customerEmail: "buyer@example.com",
        successUrl: "https://x/s",
      });
      assert.equal(checkout.url, "https://checkout.stripe.test/session");

      // Portal without a customer is a clean 404.
      await assert.rejects(
        () => billing.createPortal(app, "nobody@example.com", "https://x/return"),
        /No Stripe customer/,
      );
    } finally {
      await stripe.close();
    }
  });

  test("Stripe webhook: valid signature applies checkout; bad/stale signatures rejected", async () => {
    const store = new MemoryStore();
    const app = fakeApp();
    await store.createApp(app);
    const vault = new VaultService(store, "master");
    await vault.set("org_1", "app_1", "STRIPE_WEBHOOK_SECRET", "whsec_test");
    const webhookEvents: Array<Record<string, unknown>> = [];
    const billing = new BillingService(store, vault, testConfig(), {
      audit: async () => undefined,
      webhook: async (_event, _app, payload) => {
        webhookEvents.push(payload);
      },
    });
    const eventBody = JSON.stringify({
      data: { object: { customer: "cus_1", customer_email: "buyer@example.com", id: "cs_1", subscription: "sub_1" } },
      id: "evt_1",
      type: "checkout.session.completed",
    });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${hmacHex("whsec_test", `${t}.${eventBody}`)}`;
    const result = await billing.handleStripeWebhook(app, Buffer.from(eventBody), sig);
    assert.deepEqual(result, { handled: true, type: "checkout.session.completed" });
    const subs = await store.listSubscriptions("org_1", "app_1");
    assert.equal(subs.length, 1);
    assert.equal(subs[0].status, "active");
    assert.equal(subs[0].stripe_customer_id, "cus_1");

    // Replay of the same event id is acknowledged but not re-applied.
    const replay = await billing.handleStripeWebhook(app, Buffer.from(eventBody), sig);
    assert.equal(replay.handled, false);
    assert.equal((await store.listSubscriptions("org_1", "app_1")).length, 1);

    // Tampered body, wrong secret, stale timestamp: all rejected.
    await assert.rejects(() => billing.handleStripeWebhook(app, Buffer.from(`${eventBody} `), sig), /Invalid Stripe/);
    const badSig = `t=${t},v1=${hmacHex("whsec_wrong", `${t}.${eventBody}`)}`;
    await assert.rejects(() => billing.handleStripeWebhook(app, Buffer.from(eventBody), badSig), /Invalid Stripe/);
    const staleT = t - 1000;
    const staleSig = `t=${staleT},v1=${hmacHex("whsec_test", `${staleT}.${eventBody}`)}`;
    await assert.rejects(() => billing.handleStripeWebhook(app, Buffer.from(eventBody), staleSig), /Invalid Stripe/);
    await assert.rejects(() => billing.handleStripeWebhook(app, Buffer.from(eventBody), undefined), /Invalid Stripe/);

    // Unknown event types are acknowledged without action.
    const unknownBody = JSON.stringify({ data: { object: {} }, id: "evt_2", type: "something.else" });
    const unknownSig = `t=${t},v1=${hmacHex("whsec_test", `${t}.${unknownBody}`)}`;
    const unknown = await billing.handleStripeWebhook(app, Buffer.from(unknownBody), unknownSig);
    assert.equal(unknown.handled, false);

    // payment_intent.succeeded dispatches on_payment_succeeded.
    const payBody = JSON.stringify({
      data: { object: { amount: 1999, currency: "usd", id: "pi_1" } },
      id: "evt_3",
      type: "payment_intent.succeeded",
    });
    const paySig = `t=${t},v1=${hmacHex("whsec_test", `${t}.${payBody}`)}`;
    await billing.handleStripeWebhook(app, Buffer.from(payBody), paySig);
    assert.equal(webhookEvents.length, 1);
    assert.equal(webhookEvents[0].paymentIntentId, "pi_1");
  });

  test("usage metering aggregates per metric", async () => {
    const store = new MemoryStore();
    const app = fakeApp();
    await store.createApp(app);
    const billing = new BillingService(store, new VaultService(store, "master"), testConfig(), {
      audit: async () => undefined,
      webhook: async () => undefined,
    });
    await billing.recordUsage(app, "api_calls", 10);
    await billing.recordUsage(app, "api_calls", 5);
    await billing.recordUsage(app, "storage_mb", 3);
    assert.deepEqual(await billing.usageTotals(app), { api_calls: 15, storage_mb: 3 });
    await assert.rejects(() => billing.recordUsage(app, "Bad Name", 1), /Invalid usage metric/);
    await assert.rejects(() => billing.recordUsage(app, "api_calls", -1), /non-negative/);
  });
});
