/**
 * Preview inspector bridge.
 *
 * The server injects this script into HTML files served from /preview/*.
 * The script stays dormant until the Studio (same origin, parent frame)
 * arms it with a postMessage. While armed, hovering highlights elements
 * and clicking one reports its context (tag, CSS path, classes, text,
 * bounding box) to the Studio. The Studio can send text edits back; the
 * bridge applies them live and returns the serialized document so the
 * Studio can persist the change as a file edit.
 *
 * Security: the bridge only talks to its parent frame (verified via
 * `event.source`, since a sandboxed iframe has an opaque origin and
 * origin strings are meaningless here), only inside an iframe, and only
 * after an explicit arm message. The Studio verifies `event.source`
 * against the preview iframe's contentWindow before trusting any
 * message. Preview responses carry
 * `Content-Security-Policy: sandbox allow-scripts`, so preview code can
 * never reach the Studio's origin, cookies, or DOM, and cannot make
 * network calls (connect-src 'none'): preview is for visual inspection
 * and click-to-select, not live API calls (see PARITY.md).
 */

export const INSPECTOR_SCRIPT = `
(function () {
  "use strict";
  if (window.top === window) return; // Only inside the Studio preview iframe.
  var armed = false;
  var hoverEl = null;
  var styleEl = null;

  function ensureStyle() {
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.textContent = "[data-forge-hover]{outline:2px solid #f59e0b !important;outline-offset:1px;}";
    document.head.appendChild(styleEl);
  }

  function cssPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      var part = node.tagName.toLowerCase();
      if (node.id) { part += "#" + node.id; parts.unshift(part); break; }
      var siblings = node.parentElement ? Array.prototype.filter.call(node.parentElement.children, function (c) { return c.tagName === node.tagName; }) : [];
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function describe(el) {
    var rect = el.getBoundingClientRect();
    return {
      classes: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : String(el.className || "")).split(/\\s+/).filter(Boolean),
      path: cssPath(el),
      rect: { height: Math.round(rect.height), left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width) },
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").trim().slice(0, 300)
    };
  }

  function post(type, payload) {
    // Target origin "*" is safe here: the Studio validates event.source
    // against the preview iframe before trusting the message, and the
    // sandboxed frame has an opaque origin so no origin string exists.
    window.parent.postMessage({ payload: payload, source: "forge-inspector", type: type }, "*");
  }

  function onMouseOver(e) {
    if (!armed) return;
    if (hoverEl) hoverEl.removeAttribute("data-forge-hover");
    hoverEl = e.target;
    ensureStyle();
    hoverEl.setAttribute("data-forge-hover", "1");
  }

  function onClick(e) {
    if (!armed) return;
    e.preventDefault();
    e.stopPropagation();
    post("forge-element-selected", describe(e.target));
  }

  function onMessage(e) {
    if (e.source !== window.parent) return;
    var msg = e.data || {};
    if (msg.source !== "forge-studio") return;
    if (msg.type === "forge-arm-inspector") {
      armed = true;
      document.addEventListener("mouseover", onMouseOver, true);
      document.addEventListener("click", onClick, true);
      post("forge-inspector-ready", {});
    } else if (msg.type === "forge-disarm-inspector") {
      armed = false;
      if (hoverEl) hoverEl.removeAttribute("data-forge-hover");
      document.removeEventListener("mouseover", onMouseOver, true);
      document.removeEventListener("click", onClick, true);
    } else if (msg.type === "forge-apply-text-edit") {
      var path = msg.payload && msg.payload.path;
      var text = msg.payload && msg.payload.text;
      var el = path ? document.querySelector(path) : null;
      // querySelector cannot resolve our :nth-of-type paths reliably for all
      // shapes, so fall back to the last selected element when present.
      if (!el && hoverEl) el = hoverEl;
      if (el && typeof text === "string") {
        el.textContent = text;
        post("forge-document-changed", { html: document.documentElement.outerHTML });
      }
    } else if (msg.type === "forge-request-document") {
      post("forge-document-changed", { html: document.documentElement.outerHTML });
    }
  }

  window.addEventListener("message", onMessage);
})();
`.trim();

/** Inject the inspector script before </body> (or append if no body tag). */
export function injectInspector(html: string): string {
  const tag = `\n<script>${INSPECTOR_SCRIPT}</script>\n`;
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx >= 0) return html.slice(0, idx) + tag + html.slice(idx);
  return html + tag;
}

export const PREVIEW_CSP = "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data: https:; script-src 'unsafe-inline'; connect-src 'none'";
