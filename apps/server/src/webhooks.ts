import { ForgeError, newId, signWebhookBody } from "@quinlo/shared";
import type { App, Store, WebhookEndpoint } from "./store";

/**
 * Outbound webhooks (n8n / Zapier / Make compatible).
 *
 * Envelope (flat JSON, the shape automation tools expect):
 *   { event, app_id, app_slug, org_id, timestamp, data }
 *
 * Every delivery is HMAC-SHA256 signed: header `X-Forge-Signature:
 * sha256=<hex of raw body>`, plus `X-Forge-Event` and `X-Forge-Delivery`
 * (delivery id, for dedupe on the receiver side). Failed deliveries retry
 * with exponential backoff (1s, 5s, 15s, 60s, 300s; 5 attempts max) and
 * every attempt is recorded. Retries are best-effort in-process: a server
 * restart drops pending retries (documented in PARITY.md; a durable queue
 * is a follow-up).
 */

export const WEBHOOK_EVENTS = [
  "on_user_signup",
  "on_record_created",
  "on_record_updated",
  "on_record_deleted",
  "on_payment_succeeded",
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type DelayFn = (ms: number) => Promise<void>;

const RETRY_DELAYS_MS = [1000, 5000, 15000, 60000, 300000];

export function buildEnvelope(
  event: string,
  app: App,
  data: Record<string, unknown>,
  timestamp = new Date().toISOString(),
): Record<string, unknown> {
  return {
    app_id: app.id,
    app_slug: app.slug,
    data,
    event,
    org_id: app.org_id,
    timestamp,
  };
}

export class WebhookService {
  private closed = false;
  private readonly delayFn: DelayFn;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly store: Store,
    private readonly fetchFn: FetchFn = fetch,
    delayFn?: DelayFn,
  ) {
    this.delayFn = delayFn ?? ((ms) => this.defaultDelay(ms));
  }

  private defaultDelay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      timer.unref?.();
      this.timers.add(timer);
    });
  }

  async createEndpoint(
    orgId: string,
    appId: string,
    input: { events: string[]; url: string },
  ): Promise<WebhookEndpoint> {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new ForgeError("validation", "Webhook URL must be valid", 400);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ForgeError("validation", "Webhook URL must use http or https", 400);
    }
    if (parsed.protocol === "http:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new ForgeError("validation", "Non-local webhook URLs must use https", 400);
    }
    const unknown = input.events.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
    if (unknown.length > 0) {
      throw new ForgeError("validation", `Unknown webhook events: ${unknown.join(", ")}`, 400);
    }
    if (input.events.length === 0) {
      throw new ForgeError("validation", "At least one event is required", 400);
    }
    const endpoint = await this.store.createWebhook({
      active: true,
      app_id: appId,
      created_at: new Date().toISOString(),
      events: [...new Set(input.events)],
      id: newId("wh"),
      org_id: orgId,
      secret: `whsec_${newId("s").slice(4)}`,
      url: input.url,
    });
    return endpoint;
  }

  /** Dispatch an event to every subscribed endpoint. First attempt is awaited. */
  async dispatch(event: WebhookEventName, app: App, data: Record<string, unknown>): Promise<void> {
    const endpoints = await this.store.listWebhooks(app.org_id, app.id);
    for (const endpoint of endpoints) {
      if (!endpoint.active || !endpoint.events.includes(event)) continue;
      await this.deliver(endpoint, event, app, data);
    }
  }

  /** Send a test event to one endpoint (used by the Studio "Send test" button). */
  async sendTest(endpoint: WebhookEndpoint, app: App): Promise<{ status: string }> {
    const delivery = await this.deliver(endpoint, "on_record_created", app, {
      test: true,
    });
    return { status: delivery.status };
  }

  private async deliver(
    endpoint: WebhookEndpoint,
    event: string,
    app: App,
    data: Record<string, unknown>,
  ) {
    const envelope = buildEnvelope(event, app, data);
    const rawBody = JSON.stringify(envelope);
    const now = new Date().toISOString();
    const delivery = await this.store.createDelivery({
      attempts: 0,
      created_at: now,
      event,
      id: newId("dlv"),
      last_error: null,
      last_status: null,
      payload: envelope,
      status: "pending",
      updated_at: now,
      webhook_id: endpoint.id,
    });
    await this.attempt(endpoint, delivery.id, rawBody, event, 0);
    const latest = (await this.store.listDeliveries(endpoint.id)).find((d) => d.id === delivery.id);
    return latest ?? delivery;
  }

  private async attempt(
    endpoint: WebhookEndpoint,
    deliveryId: string,
    rawBody: string,
    event: string,
    attemptIndex: number,
  ): Promise<void> {
    const deliveries = await this.store.listDeliveries(endpoint.id);
    const delivery = deliveries.find((d) => d.id === deliveryId);
    if (!delivery) return;
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await this.fetchFn(endpoint.url, {
        body: rawBody,
        headers: {
          "content-type": "application/json",
          "x-forge-delivery": deliveryId,
          "x-forge-event": event,
          "x-forge-signature": signWebhookBody(endpoint.secret, rawBody),
        },
        method: "POST",
        signal: AbortSignal.timeout(10000),
      });
      status = res.status;
      // Drain the body so keep-alive connections are reusable.
      await res.arrayBuffer().catch(() => undefined);
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (err) {
      error = (err as Error).message ?? "fetch failed";
    }
    const attempts = delivery.attempts + 1;
    if (!error) {
      await this.store.updateDelivery({
        ...delivery,
        attempts,
        last_error: null,
        last_status: status,
        status: "delivered",
        updated_at: new Date().toISOString(),
      });
      return;
    }
    const willRetry = attemptIndex + 1 < RETRY_DELAYS_MS.length;
    await this.store.updateDelivery({
      ...delivery,
      attempts,
      last_error: error,
      last_status: status,
      status: willRetry ? "pending" : "failed",
      updated_at: new Date().toISOString(),
    });
    if (willRetry) {
      const delayMs = RETRY_DELAYS_MS[attemptIndex];
      void this.delayFn(delayMs).then(() => {
        if (!this.closed) void this.attempt(endpoint, deliveryId, rawBody, event, attemptIndex + 1);
      });
    }
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
