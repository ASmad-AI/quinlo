import { decryptSecret, encryptSecret, ForgeError, newId } from "@openforge/shared";
import type { Store } from "./store";

/**
 * Secrets vault facade: values are encrypted with AES-256-GCM before they
 * reach the store and decrypted only on explicit `get`. Listing returns
 * names + metadata only — values NEVER appear in list responses, logs,
 * MCP tool results, or audit events.
 */
export class VaultService {
  constructor(
    private readonly store: Store,
    private readonly masterKey: string,
  ) {}

  async set(orgId: string, appId: string, key: string, value: string): Promise<{ key: string; updated_at: string }> {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,119}$/.test(key)) {
      throw new ForgeError("validation", "Secret key must match ^[A-Za-z_][A-Za-z0-9_]{0,119}$", 400);
    }
    const now = new Date().toISOString();
    const existing = await this.store.getSecret(orgId, appId, key);
    await this.store.upsertSecret({
      app_id: appId,
      ciphertext: encryptSecret(value, this.masterKey),
      created_at: existing?.created_at ?? now,
      id: existing?.id ?? newId("sec"),
      key,
      org_id: orgId,
      updated_at: now,
    });
    return { key, updated_at: now };
  }

  async get(orgId: string, appId: string, key: string): Promise<string | null> {
    const row = await this.store.getSecret(orgId, appId, key);
    if (!row) return null;
    try {
      return decryptSecret(row.ciphertext, this.masterKey);
    } catch {
      throw new ForgeError("internal", "Stored secret could not be decrypted (wrong master key?)", 500);
    }
  }

  async listNames(orgId: string, appId: string): Promise<Array<{ created_at: string; key: string; updated_at: string }>> {
    const rows = await this.store.listSecrets(orgId, appId);
    return rows.map((r) => ({ created_at: r.created_at, key: r.key, updated_at: r.updated_at }));
  }

  async remove(orgId: string, appId: string, key: string): Promise<boolean> {
    const row = await this.store.getSecret(orgId, appId, key);
    if (!row) return false;
    await this.store.deleteSecret(orgId, appId, key);
    return true;
  }
}
