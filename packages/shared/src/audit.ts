import { newId } from "./ids";

export type AuditAction =
  | "auth.login"
  | "auth.logout"
  | "auth.signup"
  | "auth.oauth"
  | "api_key.created"
  | "api_key.revoked"
  | "app.created"
  | "app.deleted"
  | "billing.checkout_created"
  | "billing.webhook_received"
  | "collection.created"
  | "collection.deleted"
  | "deploy.promoted"
  | "deploy.published"
  | "eject.exported"
  | "function.executed"
  | "github.pulled"
  | "github.pushed"
  | "mcp.tool_called"
  | "profile.applied"
  | "profile.denied"
  | "record.created"
  | "record.deleted"
  | "record.read"
  | "record.updated"
  | "secret.stored"
  | "webhook.delivered"
  | "webhook.failed";

export interface AuditEvent {
  action: AuditAction;
  actorId: string;
  actorType: "user" | "api_key" | "mcp" | "system";
  appId?: string;
  detail?: Record<string, unknown>;
  id: string;
  ip?: string;
  orgId: string;
  ts: string;
}

export function auditEvent(
  partial: Omit<AuditEvent, "id" | "ts"> & { id?: string; ts?: string },
): AuditEvent {
  return {
    id: partial.id ?? newId("evt"),
    ts: partial.ts ?? new Date().toISOString(),
    ...partial,
  } as AuditEvent;
}

/**
 * Bounded in-memory audit ring. The server persists events through the
 * store; this class is the shared, testable core (also used by the MCP
 * server to record tool calls before they reach storage).
 */
export class AuditLog {
  private readonly capacity: number;
  private events: AuditEvent[] = [];

  constructor(capacity = 1000) {
    this.capacity = capacity;
  }

  append(event: AuditEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
  }

  list(filter: { action?: AuditAction; appId?: string; orgId?: string } = {}): AuditEvent[] {
    return this.events.filter((e) => {
      if (filter.orgId && e.orgId !== filter.orgId) return false;
      if (filter.appId && e.appId !== filter.appId) return false;
      if (filter.action && e.action !== filter.action) return false;
      return true;
    });
  }

  get size(): number {
    return this.events.length;
  }
}
