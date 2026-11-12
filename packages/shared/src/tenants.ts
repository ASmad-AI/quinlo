import { tenantMismatch } from "./errors";

/**
 * Tenant isolation (Layer 1). Every stored row carries `org_id`. The query
 * layer ALWAYS constrains reads, writes, and deletes to the caller's org,
 * before any profile check. A caller can never widen their own scope: the
 * org id comes from the authenticated session / API key, never from the
 * request body or query string.
 */

export interface TenantRow {
  org_id: string;
  [key: string]: unknown;
}

export function requireOrgId(orgId: string | undefined | null): string {
  if (!orgId || typeof orgId !== "string" || orgId.trim().length === 0) {
    throw tenantMismatch();
  }
  return orgId;
}

/** True when the row belongs to the caller's org. */
export function belongsToOrg(row: TenantRow, orgId: string): boolean {
  return row.org_id === orgId;
}

/** Throw unless the row belongs to the caller's org. */
export function assertBelongsToOrg(row: TenantRow, orgId: string): void {
  if (!belongsToOrg(row, orgId)) throw tenantMismatch();
}

/** Predicate for filtering a result set down to one org. */
export function orgFilter<T extends TenantRow>(orgId: string): (row: T) => boolean {
  return (row) => row.org_id === orgId;
}

/**
 * Strip any client-supplied org/tenant override from a write payload and
 * stamp the caller's org id. The body can NEVER choose its own org.
 */
export function stampOrgId<T extends Record<string, unknown>>(
  payload: T,
  orgId: string,
): T & { org_id: string } {
  const { org_id: _dropped, tenant_id: _dropped2, ...rest } = payload as T & {
    org_id?: unknown;
    tenant_id?: unknown;
  };
  return { ...rest, org_id: orgId } as T & { org_id: string };
}
