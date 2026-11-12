import {
  ForgeError,
  hmacHex,
  newId,
  verifyStripeSignature,
} from "@quinlo/shared";
import type { ServerConfig } from "./config";
import type { App, BillingPlan, Store, Subscription } from "./store";
import type { VaultService } from "./vault";

/**
 * Stripe billing module.
 *
 * Design: plans are stored locally FIRST (so the app always has a billing
 * model), and mirrored to Stripe only when a secret key is present in the
 * vault. No Stripe key => plans exist in local/test mode and checkout
 * returns a clear 400 instead of a fake URL. Nothing here ever invents a
 * Stripe id.
 *
 * Webhook handling verifies the Stripe signature (t/v1, 5-minute
 * tolerance) against the vault secret STRIPE_WEBHOOK_SECRET before
 * parsing any business logic. Live Stripe verification is outstanding —
 * see VERIFICATION.md. Tests run against a stub Stripe server.
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface StripePlanInput {
  currency: string;
  interval: "month" | "one_time" | "year";
  name: string;
  priceCents: number;
}

export class StripeClient {
  constructor(
    private readonly secretKey: string,
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async request(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      body: new URLSearchParams(form),
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (json.error ?? {}) as { message?: string };
      throw new ForgeError("upstream_error", `Stripe error: ${err.message ?? res.status}`, 502);
    }
    return json;
  }

  async createProduct(name: string): Promise<{ id: string }> {
    const r = await this.request("/v1/products", { name });
    return { id: String(r.id) };
  }

  async createPrice(productId: string, unitAmount: number, currency: string, interval: string): Promise<{ id: string }> {
    const form: Record<string, string> = {
      currency,
      product: productId,
      unit_amount: String(unitAmount),
    };
    if (interval === "month" || interval === "year") {
      form["recurring[interval]"] = interval;
    }
    const r = await this.request("/v1/prices", form);
    return { id: String(r.id) };
  }

  async createCheckoutSession(input: {
    cancelUrl: string;
    customerEmail?: string;
    mode: "payment" | "subscription";
    priceId: string;
    successUrl: string;
  }): Promise<{ id: string; url: string }> {
    const form: Record<string, string> = {
      cancel_url: input.cancelUrl,
      "line_items[0][price]": input.priceId,
      "line_items[0][quantity]": "1",
      mode: input.mode,
      success_url: input.successUrl,
    };
    if (input.customerEmail) form.customer_email = input.customerEmail;
    const r = await this.request("/v1/checkout/sessions", form);
    return { id: String(r.id), url: String(r.url ?? "") };
  }

  async createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }> {
    const r = await this.request("/v1/billing_portal/sessions", {
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: String(r.url ?? "") };
  }
}

export interface BillingEventSink {
  audit(event: {
    action: string;
    actorId: string;
    actorType: "api_key" | "mcp" | "system" | "user";
    appId?: string;
    detail?: Record<string, unknown>;
    orgId: string;
  }): Promise<void>;
  webhook(
    event: "on_payment_succeeded",
    app: App,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

export class BillingService {
  private readonly seenEvents = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly vault: VaultService,
    private readonly config: ServerConfig,
    private readonly events: BillingEventSink,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async stripeClient(app: App): Promise<StripeClient | null> {
    const key = await this.vault.get(app.org_id, app.id, "STRIPE_SECRET_KEY");
    if (!key) return null;
    return new StripeClient(key, this.config.stripeApiBaseUrl, this.fetchFn);
  }

  private modeFor(keyPresent: boolean, keyValue?: string | null): "live" | "test" {
    if (!keyPresent || !keyValue) return "test";
    return keyValue.startsWith("sk_live_") ? "live" : "test";
  }

  async setupPlans(
    app: App,
    plans: StripePlanInput[],
    actorId: string,
  ): Promise<BillingPlan[]> {
    const key = await this.vault.get(app.org_id, app.id, "STRIPE_SECRET_KEY");
    const client = key ? new StripeClient(key, this.config.stripeApiBaseUrl, this.fetchFn) : null;
    const mode = this.modeFor(Boolean(key), key);
    const created: BillingPlan[] = [];
    for (const plan of plans) {
      let stripeProductId: string | null = null;
      let stripePriceId: string | null = null;
      if (client) {
        // Stripe failures abort the whole setup: no half-mirrored plans.
        const product = await client.createProduct(plan.name);
        const price = await client.createPrice(product.id, plan.priceCents, plan.currency, plan.interval);
        stripeProductId = product.id;
        stripePriceId = price.id;
      }
      const row = await this.store.createPlan({
        app_id: app.id,
        created_at: new Date().toISOString(),
        currency: plan.currency,
        id: newId("plan"),
        interval: plan.interval,
        mode,
        name: plan.name,
        org_id: app.org_id,
        price_cents: plan.priceCents,
        stripe_price_id: stripePriceId,
        stripe_product_id: stripeProductId,
      });
      created.push(row);
    }
    await this.events.audit({
      action: "billing.checkout_created",
      actorId,
      actorType: "system",
      appId: app.id,
      detail: { count: created.length, mode, stripeConnected: Boolean(client) },
      orgId: app.org_id,
    });
    return created;
  }

  async createCheckout(
    app: App,
    planId: string,
    input: { cancelUrl: string; customerEmail?: string; successUrl: string },
  ): Promise<{ sessionId: string; url: string }> {
    const plan = await this.store.getPlan(app.org_id, app.id, planId);
    if (!plan) throw new ForgeError("not_found", "Billing plan not found", 404);
    const client = await this.stripeClient(app);
    if (!client || !plan.stripe_price_id) {
      throw new ForgeError(
        "bad_request",
        "Stripe is not connected for this app: store STRIPE_SECRET_KEY in the vault and re-run setup_billing",
        400,
      );
    }
    const mode = plan.interval === "one_time" ? "payment" : "subscription";
    const session = await client.createCheckoutSession({
      cancelUrl: input.cancelUrl,
      customerEmail: input.customerEmail,
      mode,
      priceId: plan.stripe_price_id,
      successUrl: input.successUrl,
    });
    if (!session.url) throw new ForgeError("upstream_error", "Stripe returned no checkout URL", 502);
    return { sessionId: session.id, url: session.url };
  }

  async createPortal(app: App, customerEmail: string, returnUrl: string): Promise<{ url: string }> {
    const subs = await this.store.listSubscriptions(app.org_id, app.id);
    const sub = subs.find((s) => s.customer_email.toLowerCase() === customerEmail.toLowerCase() && s.stripe_customer_id);
    if (!sub?.stripe_customer_id) {
      throw new ForgeError("not_found", "No Stripe customer found for this email", 404);
    }
    const client = await this.stripeClient(app);
    if (!client) {
      throw new ForgeError("bad_request", "Stripe is not connected for this app", 400);
    }
    return client.createPortalSession(sub.stripe_customer_id, returnUrl);
  }

  /**
   * Handle an inbound Stripe webhook. The signature is verified against
   * the RAW body before anything else. Returns a summary; unknown event
   * types are acknowledged (200) without action, per Stripe guidance.
   */
  async handleStripeWebhook(
    app: App,
    rawBody: Buffer,
    signatureHeader: string | undefined,
  ): Promise<{ handled: boolean; type: string }> {
    const secret = await this.vault.get(app.org_id, app.id, "STRIPE_WEBHOOK_SECRET");
    if (!secret) {
      throw new ForgeError("bad_request", "No Stripe webhook secret configured for this app", 400);
    }
    if (!verifyStripeSignature(rawBody, signatureHeader, secret)) {
      throw new ForgeError("unauthorized", "Invalid Stripe webhook signature", 401);
    }
    let event: { data?: { object?: Record<string, unknown> }; id?: string; type?: string };
    try {
      event = JSON.parse(rawBody.toString("utf8")) as typeof event;
    } catch {
      throw new ForgeError("bad_request", "Webhook body must be valid JSON", 400);
    }
    const type = event.type ?? "unknown";
    if (event.id) {
      if (this.seenEvents.has(event.id)) return { handled: false, type };
      this.seenEvents.add(event.id);
      if (this.seenEvents.size > 1000) {
        const first = this.seenEvents.values().next().value as string;
        this.seenEvents.delete(first);
      }
    }
    const obj = event.data?.object ?? {};
    let handled = true;
    if (type === "checkout.session.completed") {
      await this.applyCheckoutCompleted(app, obj);
    } else if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
      await this.applySubscriptionChange(app, obj, type);
    } else if (type === "payment_intent.succeeded") {
      await this.events.webhook("on_payment_succeeded", app, {
        amount: obj.amount,
        currency: obj.currency,
        paymentIntentId: obj.id,
      });
    } else {
      handled = false;
    }
    await this.events.audit({
      action: "billing.webhook_received",
      actorId: "stripe",
      actorType: "system",
      appId: app.id,
      detail: { handled, type },
      orgId: app.org_id,
    });
    return { handled, type };
  }

  private async applyCheckoutCompleted(app: App, session: Record<string, unknown>): Promise<void> {
    const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;
    const customerId = typeof session.customer === "string" ? session.customer : null;
    const customerDetails = session.customer_details as { email?: unknown } | undefined;
    const email = String(session.customer_email ?? customerDetails?.email ?? "");
    const now = new Date().toISOString();
    const existing = subscriptionId ? await this.store.getSubscriptionByStripeId(subscriptionId) : null;
    const plans = await this.store.listPlans(app.org_id, app.id);
    const plan = plans[0];
    const row: Subscription = {
      app_id: app.id,
      created_at: existing?.created_at ?? now,
      current_period_end: null,
      customer_email: email.toLowerCase(),
      id: existing?.id ?? newId("sub"),
      org_id: app.org_id,
      plan_id: existing?.plan_id ?? plan?.id ?? "plan_unknown",
      status: "active",
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      updated_at: now,
    };
    await this.store.upsertSubscription(row);
  }

  private async applySubscriptionChange(app: App, sub: Record<string, unknown>, type: string): Promise<void> {
    const stripeId = String(sub.id ?? "");
    if (!stripeId) return;
    const existing = await this.store.getSubscriptionByStripeId(stripeId);
    if (!existing) return;
    const status =
      type === "customer.subscription.deleted" ? "canceled" : String(sub.status ?? existing.status);
    await this.store.upsertSubscription({
      ...existing,
      status,
      updated_at: new Date().toISOString(),
    });
    void app;
  }

  async recordUsage(app: App, metric: string, quantity: number): Promise<void> {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(metric)) {
      throw new ForgeError("validation", "Invalid usage metric name", 400);
    }
    if (!Number.isFinite(quantity) || quantity < 0) {
      throw new ForgeError("validation", "Usage quantity must be a non-negative number", 400);
    }
    await this.store.recordUsage({
      app_id: app.id,
      id: newId("use"),
      metric,
      org_id: app.org_id,
      quantity,
      ts: new Date().toISOString(),
    });
  }

  async usageTotals(app: App): Promise<Record<string, number>> {
    const rows = await this.store.listUsage(app.org_id, app.id);
    const totals: Record<string, number> = {};
    for (const r of rows) totals[r.metric] = (totals[r.metric] ?? 0) + r.quantity;
    return totals;
  }

  /** Test helper: sign a body exactly the way Stripe does (t + v1). */
  static signTestBody(secret: string, body: string, t: number): string {
    return `t=${t},v1=${hmacHex(secret, `${t}.${body}`)}`;
  }
}
