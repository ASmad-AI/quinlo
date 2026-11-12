/**
 * Small DOM helpers + shared components. All styling lives in styles.css
 * via tokens; this file only builds structure. Every interactive control
 * gets a label, a focus style (CSS :focus-visible), and a disabled state.
 */
import { escapeHtml } from "./logo";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

export function text(value: string): Text {
  return document.createTextNode(value);
}

/** Escape + render untrusted strings safely. Prefer textContent via `el(...,{text})`. */
export function safeHtml(value: string): string {
  return escapeHtml(value);
}

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export function button(
  label: string,
  onClick: (ev: MouseEvent) => void | Promise<void>,
  variant: ButtonVariant = "secondary",
  opts: { disabled?: boolean; title?: string; type?: "button" | "submit" } = {},
): HTMLButtonElement {
  const btn = el("button", { class: `btn btn-${variant}`, title: opts.title, type: opts.type ?? "button" }, [text(label)]);
  btn.disabled = Boolean(opts.disabled);
  btn.addEventListener("click", (ev) => {
    void onClick(ev);
  });
  return btn;
}

export function field(
  label: string,
  control: HTMLElement,
  opts: { hint?: string; id?: string } = {},
): HTMLElement {
  const wrapper = el("div", { class: "field" });
  const labelEl = el("label", { class: "field-label", ...(opts.id ? { for: opts.id } : {}) }, [text(label)]);
  wrapper.append(labelEl, control);
  if (opts.hint) wrapper.append(el("p", { class: "field-hint" }, [text(opts.hint)]));
  return wrapper;
}

export function textInput(
  opts: { id?: string; placeholder?: string; type?: string; value?: string; autocomplete?: string } = {},
): HTMLInputElement {
  const input = el("input", {
    autocomplete: opts.autocomplete,
    class: "input",
    id: opts.id,
    placeholder: opts.placeholder,
    type: opts.type ?? "text",
    value: opts.value,
  }) as HTMLInputElement;
  return input;
}

export function textArea(opts: { id?: string; placeholder?: string; rows?: number; value?: string } = {}): HTMLTextAreaElement {
  const area = el("textarea", {
    class: "input textarea",
    id: opts.id,
    placeholder: opts.placeholder,
    rows: opts.rows ? String(opts.rows) : undefined,
  }) as HTMLTextAreaElement;
  area.value = opts.value ?? "";
  return area;
}

export function selectInput(
  options: Array<{ label: string; value: string }>,
  opts: { id?: string; value?: string } = {},
): HTMLSelectElement {
  const sel = el("select", { class: "input select", id: opts.id }) as HTMLSelectElement;
  for (const o of options) {
    const opt = el("option", { value: o.value }, [text(o.label)]) as HTMLOptionElement;
    if (o.value === opts.value) opt.selected = true;
    sel.append(opt);
  }
  return sel;
}

export function checkboxInput(label: string, checked = false, opts: { id?: string } = {}): { box: HTMLInputElement; wrap: HTMLElement } {
  const box = el("input", { class: "checkbox", id: opts.id, type: "checkbox" }) as HTMLInputElement;
  box.checked = checked;
  const wrap = el("label", { class: "checkbox-row" }, [box, text(` ${label}`)]);
  return { box, wrap };
}

export function badge(label: string, tone: "neutral" | "success" | "warning" | "danger" | "info" | "accent" = "neutral"): HTMLElement {
  return el("span", { class: `badge badge-${tone}` }, [text(label)]);
}

export function spinner(label = "Loading…"): HTMLElement {
  return el("div", { class: "spinner-wrap", role: "status" }, [
    el("span", { class: "spinner", "aria-hidden": "true" }),
    el("span", { class: "spinner-label" }, [text(label)]),
  ]);
}

export function emptyState(title: string, body: string, action?: HTMLElement): HTMLElement {
  const wrap = el("div", { class: "empty-state" }, [
    el("h3", { class: "empty-title" }, [text(title)]),
    el("p", { class: "empty-body" }, [text(body)]),
  ]);
  if (action) wrap.append(action);
  return wrap;
}

export function errorState(message: string, onRetry?: () => void): HTMLElement {
  const wrap = el("div", { class: "error-state", role: "alert" }, [
    el("h3", { class: "empty-title" }, [text("Something went wrong")]),
    el("p", { class: "empty-body" }, [text(message)]),
  ]);
  if (onRetry) wrap.append(button("Try again", onRetry));
  return wrap;
}

export function codeBlock(code: string, label = "Code"): HTMLElement {
  const pre = el("pre", { class: "code-block", tabindex: "0", "aria-label": label }, [
    el("code", {}, [text(code)]),
  ]);
  return pre;
}

/** Toast notifications (polite live region). */
let toastRegion: HTMLElement | null = null;

export function toast(message: string, tone: "success" | "error" | "info" = "info"): void {
  if (!toastRegion) {
    toastRegion = el("div", { class: "toast-region", "aria-live": "polite" });
    document.body.append(toastRegion);
  }
  const item = el("div", { class: `toast toast-${tone}`, role: "status" }, [text(message)]);
  toastRegion.append(item);
  window.setTimeout(() => item.classList.add("toast-out"), 3600);
  window.setTimeout(() => item.remove(), 4100);
}

/** Accessible modal dialog with focus trap + Escape to close. Returns a close function. */
export function openModal(title: string, body: HTMLElement, actions: HTMLElement[] = []): () => void {
  const previousFocus = document.activeElement as HTMLElement | null;
  const overlay = el("div", { class: "modal-overlay" });
  const dialog = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title });
  const header = el("div", { class: "modal-header" }, [
    el("h2", { class: "modal-title" }, [text(title)]),
    button("✕", () => close(), "ghost", { title: "Close dialog" }),
  ]);
  const footer = actions.length > 0 ? el("div", { class: "modal-footer" }, actions) : null;
  dialog.append(header, el("div", { class: "modal-body" }, [body]));
  if (footer) dialog.append(footer);
  overlay.append(dialog);
  document.body.append(overlay);

  function close(): void {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    previousFocus?.focus?.();
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
      return;
    }
    if (ev.key !== "Tab") return;
    const focusables = [...dialog.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]")].filter(
      (n) => !n.hasAttribute("disabled") && n.tabIndex >= 0,
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (ev) => {
    if (ev.target === overlay) close();
  });
  const firstInput = dialog.querySelector<HTMLElement>("input, textarea, select, button");
  firstInput?.focus();
  return close;
}

/** Confirm dialog; resolves true when the user confirms. */
export function confirmDialog(title: string, body: string, confirmLabel = "Confirm", danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const close = openModal(title, el("p", {}, [text(body)]), [
      button("Cancel", () => finish(false)),
      button(confirmLabel, () => finish(true), danger ? "danger" : "primary"),
    ]);
    function finish(value: boolean): void {
      if (done) return;
      done = true;
      close();
      resolve(value);
    }
  });
}

/** Simple tab bar; panels are rendered by the caller on selection. */
export function tabs(
  items: Array<{ id: string; label: string }>,
  activeId: string,
  onSelect: (id: string) => void,
): HTMLElement {
  const bar = el("div", { class: "tab-bar", role: "tablist" });
  for (const item of items) {
    const tab = el("button", {
      class: `tab${item.id === activeId ? " tab-active" : ""}`,
      role: "tab",
      "aria-selected": item.id === activeId ? "true" : "false",
      type: "button",
    }, [text(item.label)]);
    tab.addEventListener("click", () => onSelect(item.id));
    bar.append(tab);
  }
  return bar;
}

export function sectionCard(title: string, body: HTMLElement | HTMLElement[], opts: { hint?: string } = {}): HTMLElement {
  const children = Array.isArray(body) ? body : [body];
  const card = el("section", { class: "card" }, [el("h2", { class: "card-title" }, [text(title)])]);
  if (opts.hint) card.append(el("p", { class: "card-hint" }, [text(opts.hint)]));
  card.append(...children);
  return card;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
