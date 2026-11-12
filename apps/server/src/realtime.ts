import type { ServerResponse } from "node:http";

/**
 * Realtime hub (Server-Sent Events). Subscribers are scoped to one org +
 * app; publish() only reaches subscribers of that exact scope. There is
 * no broadcast channel. WebSocket support is a documented follow-up
 * (see PARITY.md); SSE covers live preview + dashboard updates.
 */
export class RealtimeHub {
  private readonly subscribers = new Map<string, Set<ServerResponse>>();

  private key(orgId: string, appId: string): string {
    return `${orgId}:${appId}`;
  }

  subscribe(orgId: string, appId: string, res: ServerResponse): () => void {
    const key = this.key(orgId, appId);
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    set.add(res);
    return () => {
      set?.delete(res);
      if (set?.size === 0) this.subscribers.delete(key);
    };
  }

  publish(orgId: string, appId: string, event: { data: unknown; type: string }): number {
    const set = this.subscribers.get(this.key(orgId, appId));
    if (!set) return 0;
    const line = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    let delivered = 0;
    for (const res of [...set]) {
      if (res.writableEnded) {
        set.delete(res);
        continue;
      }
      res.write(line);
      delivered++;
    }
    return delivered;
  }

  subscriberCount(orgId: string, appId: string): number {
    return this.subscribers.get(this.key(orgId, appId))?.size ?? 0;
  }
}
