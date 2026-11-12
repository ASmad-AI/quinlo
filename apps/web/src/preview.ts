/**
 * Preview controller: owns the sandboxed iframe, arms/disarms the
 * inspector bridge, and validates every inbound message with
 * `event.source === iframe.contentWindow` (the sandboxed frame has an
 * opaque origin, so origin strings are meaningless here).
 */

export interface SelectedElement {
  classes: string[];
  path: string;
  rect: { height: number; left: number; top: number; width: number };
  tag: string;
  text: string;
}

export type PreviewEvent =
  | { type: "ready" }
  | { selected: SelectedElement; type: "selected" }
  | { html: string; type: "document-changed" };

export class PreviewController {
  private armed = false;
  private iframe: HTMLIFrameElement | null = null;
  private readonly onEvent: (event: PreviewEvent) => void;
  private readonly onMessage = (ev: MessageEvent) => {
    // Trust ONLY messages from our own preview frame, with the bridge source tag.
    if (!this.iframe || ev.source !== this.iframe.contentWindow) return;
    const data = ev.data as { payload?: unknown; source?: string; type?: string } | null;
    if (!data || data.source !== "forge-inspector") return;
    if (data.type === "forge-inspector-ready") this.onEvent({ type: "ready" });
    else if (data.type === "forge-element-selected") this.onEvent({ selected: data.payload as SelectedElement, type: "selected" });
    else if (data.type === "forge-document-changed") {
      const payload = data.payload as { html?: string };
      if (typeof payload?.html === "string") this.onEvent({ html: payload.html, type: "document-changed" });
    }
  };

  constructor(onEvent: (event: PreviewEvent) => void) {
    this.onEvent = onEvent;
  }

  attach(iframe: HTMLIFrameElement): void {
    this.detach();
    this.iframe = iframe;
    this.armed = false;
    window.addEventListener("message", this.onMessage);
    iframe.addEventListener("load", this.onLoad);
  }

  detach(): void {
    if (this.iframe) this.iframe.removeEventListener("load", this.onLoad);
    window.removeEventListener("message", this.onMessage);
    this.iframe = null;
    this.armed = false;
  }

  private readonly onLoad = () => {
    // Re-arm after every navigation/reload of the preview document.
    if (this.armed) this.send("forge-arm-inspector", {});
  };

  isArmed(): boolean {
    return this.armed;
  }

  arm(): void {
    this.armed = true;
    this.send("forge-arm-inspector", {});
  }

  disarm(): void {
    this.armed = false;
    this.send("forge-disarm-inspector", {});
  }

  applyTextEdit(path: string, text: string): void {
    this.send("forge-apply-text-edit", { path, text });
  }

  requestDocument(): void {
    this.send("forge-request-document", {});
  }

  reload(): void {
    if (!this.iframe) return;
    const src = this.iframe.src;
    // Cache-bust so a fresh deploy is shown immediately.
    const url = new URL(src, window.location.href);
    url.searchParams.set("_t", String(Date.now()));
    this.iframe.src = url.toString();
  }

  private send(type: string, payload: unknown): void {
    this.iframe?.contentWindow?.postMessage({ payload, source: "forge-studio", type }, "*");
  }
}
