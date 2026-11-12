/**
 * Studio entry point: theme boot, shell layout, hash router, auth gate.
 */
import { api, ApiError, type PublicUser } from "./api";
import { avatarSvg, loadLook } from "./avatars";
import { BRANDING } from "./branding";
import { button, el, spinner, text } from "./components";
import { logoSvg } from "./logo";
import { applyThemeState, loadThemeState } from "./themes";
import { renderLogin, renderSignup } from "./views/auth";
import { renderApps } from "./views/apps";
import { renderStudio } from "./views/studio";
import { renderData } from "./views/data";
import { renderSecurity } from "./views/security";
import { renderOps } from "./views/ops";
import { renderSettings } from "./views/settings";
import { renderShowcase } from "./views/showcase";
import type { ViewCleanup, ViewContext } from "./views/helpers";

applyThemeState(loadThemeState());
document.title = `${BRANDING.name} Studio`;

const appRootEl = document.getElementById("app");
if (!appRootEl) throw new Error("Missing #app element");
const appRoot: HTMLElement = appRootEl;

let currentUser: PublicUser | null = null;
let cleanup: ViewCleanup | undefined;

function navigate(hash: string): void {
  if (window.location.hash === hash) {
    void render();
  } else {
    window.location.hash = hash;
  }
}

function shell(main: HTMLElement, user: PublicUser): HTMLElement {
  const look = loadLook();
  const nav = el("nav", { class: "nav-section", "aria-label": "Primary" }, [
    el("a", { class: "nav-link", href: "#/apps", "data-nav": "apps" }, [text("Apps")]),
    el("a", { class: "nav-link", href: "#/settings", "data-nav": "settings" }, [text("Settings")]),
    el("a", { class: "nav-link", href: "#/showcase", "data-nav": "showcase" }, [text("Design showcase")]),
  ]);
  const logoutBtn = button("Log out", async () => {
    try {
      await api.logout();
    } catch {
      // Session may already be gone; navigate anyway.
    }
    currentUser = null;
    navigate("#/login");
  }, "ghost");
  const sidebar = el("aside", { class: "sidebar" }, [
    el("a", { class: "brand-row", href: "#/apps" }, [
      el("span", { html: logoSvg(30, `${BRANDING.name} logo`) }),
      el("span", {}, [
        el("span", { class: "brand-name" }, [text(BRANDING.name)]),
        el("div", { class: "brand-tag" }, [text(BRANDING.workingTitle ? "Working title" : BRANDING.tagline)]),
      ]),
    ]),
    nav,
    el("div", { class: "sidebar-footer" }, [
      el("div", { class: "user-chip" }, [
        el("span", { html: avatarSvg({ ...look, expression: "idle" }, 32) }),
        el("span", {}, [text(user.name)]),
      ]),
      logoutBtn,
    ]),
  ]);
  const wrap = el("div", { class: "shell" }, [sidebar, main]);
  return wrap;
}

function setActiveNav(route: string): void {
  for (const link of document.querySelectorAll("[data-nav]")) {
    link.classList.toggle("nav-link-active", link.getAttribute("data-nav") === route);
  }
}

async function ensureUser(): Promise<PublicUser | null> {
  if (currentUser) return currentUser;
  try {
    const { user } = await api.me();
    currentUser = user;
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

async function render(): Promise<void> {
  cleanup?.();
  cleanup = undefined;
  const hash = window.location.hash || "#/apps";
  const path = hash.replace(/^#/, "");
  const segments = path.split("/").filter(Boolean);

  // Public routes.
  if (segments[0] === "login" || segments[0] === "signup") {
    const done = () => {
      currentUser = null;
      navigate("#/apps");
    };
    if (segments[0] === "login") renderLogin(appRoot, done);
    else renderSignup(appRoot, done);
    return;
  }

  // Everything else requires a session.
  let user: PublicUser | null;
  try {
    user = await ensureUser();
  } catch {
    appRoot.replaceChildren(el("div", { class: "auth-layout" }, [
      el("div", { class: "card" }, [
        el("h1", {}, [text("Cannot reach the server")]),
        el("p", {}, [text("Check that the backend is running, then reload.")]),
        button("Retry", () => void render(), "primary"),
      ]),
    ]));
    return;
  }
  if (!user) {
    navigate("#/login");
    return;
  }

  const main = el("main", { class: "main", id: "main" });
  appRoot.replaceChildren(shell(main, user));
  const ctx: ViewContext = { navigate, user };

  const route = segments[0];
  if (route === "apps" && segments[1]) {
    const appId = segments[1];
    const section = segments[2] ?? "studio";
    setActiveNav("apps");
    if (section === "studio") cleanup = await renderStudio(main, ctx, appId);
    else if (section === "data") await renderData(main, ctx, appId);
    else if (section === "security") await renderSecurity(main, ctx, appId);
    else if (section === "ops") await renderOps(main, ctx, appId);
    else navigate(`#/apps/${appId}/studio`);
    return;
  }
  if (route === "apps") {
    setActiveNav("apps");
    await renderApps(main, ctx);
    return;
  }
  if (route === "settings") {
    setActiveNav("settings");
    await renderSettings(main, ctx);
    return;
  }
  if (route === "showcase") {
    setActiveNav("showcase");
    renderShowcase(main, ctx);
    return;
  }
  navigate("#/apps");
}

// Offline banner (top of the app, above the shell).
const offlineBanner = el("div", { class: "offline-banner", role: "alert", hidden: true }, [
  text("You are offline. Changes cannot be saved until the connection returns."),
]);
document.body.prepend(offlineBanner);
const updateOnline = () => {
  offlineBanner.hidden = navigator.onLine;
};
window.addEventListener("online", updateOnline);
window.addEventListener("offline", updateOnline);
updateOnline();

window.addEventListener("hashchange", () => {
  void render();
});

appRoot.replaceChildren(spinner("Loading Studio…"));
void render();
