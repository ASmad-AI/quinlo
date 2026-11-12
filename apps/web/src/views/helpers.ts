/** Shared view plumbing: page headers, loading/error wrappers, routing context. */
import { ApiError, type PublicUser } from "../api";
import { el, errorState, spinner, text } from "../components";

export interface ViewContext {
  navigate: (hash: string) => void;
  user: PublicUser;
}

export type ViewCleanup = () => void;

export function pageHead(title: string, sub: string, actions: HTMLElement[] = []): HTMLElement {
  const head = el("div", { class: "page-head" }, [
    el("div", {}, [
      el("h1", { class: "page-title" }, [text(title)]),
      el("p", { class: "page-sub" }, [text(sub)]),
    ]),
  ]);
  if (actions.length > 0) head.append(el("div", { class: "page-actions" }, actions));
  return head;
}

/** Run a loader with spinner + error states inside `root`. Returns the loader's cleanup, if any. */
export async function withLoading(
  root: HTMLElement,
  loader: () => Promise<ViewCleanup | void>,
): Promise<ViewCleanup | void> {
  root.replaceChildren(spinner());
  try {
    return await loader();
  } catch (err) {
    const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
    const retry = async () => {
      await withLoading(root, loader);
    };
    root.replaceChildren(errorState(message, () => void retry()));
    return undefined;
  }
}

export function appNav(appId: string, active: string): HTMLElement {
  const items: Array<[string, string, string]> = [
    ["studio", "Studio", `#/apps/${appId}/studio`],
    ["data", "Data", `#/apps/${appId}/data`],
    ["security", "Security", `#/apps/${appId}/security`],
    ["ops", "Functions & Ops", `#/apps/${appId}/ops`],
  ];
  const nav = el("nav", { class: "tab-bar", "aria-label": "App sections" });
  for (const [id, label, href] of items) {
    const link = el("a", { class: `tab${id === active ? " tab-active" : ""}`, href }, [text(label)]);
    nav.append(link);
  }
  return nav;
}
