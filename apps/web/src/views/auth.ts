/** Login + signup views. */
import { api, ApiError } from "../api";
import { BRANDING } from "../branding";
import { button, el, field, sectionCard, text, textInput, toast } from "../components";
import { logoSvg } from "../logo";

function authShell(title: string, tagline: string, form: HTMLElement, switchLine: HTMLElement): HTMLElement {
  const layout = el("div", { class: "auth-layout" });
  const card = el("div", { class: "card auth-card" });
  const brand = el("div", { class: "auth-brand" }, [
    el("span", { html: logoSvg(44, `${BRANDING.name} logo`) }),
    el("h1", { class: "brand-name" }, [text(BRANDING.name)]),
    el("p", { class: "auth-tagline" }, [text(tagline)]),
  ]);
  card.append(brand, el("h2", { class: "card-title" }, [text(title)]), form, switchLine);
  layout.append(card);
  return layout;
}

export function renderLogin(root: HTMLElement, onDone: () => void): void {
  const email = textInput({ autocomplete: "email", id: "login-email", placeholder: "you@example.com", type: "email" });
  const password = textInput({ autocomplete: "current-password", id: "login-password", placeholder: "Password", type: "password" });
  const error = el("p", { class: "field-hint", role: "alert" });
  const submit = button(
    "Log in",
    async () => {
      error.textContent = "";
      submit.disabled = true;
      try {
        await api.login(email.value.trim(), password.value);
        toast("Welcome back.", "success");
        onDone();
      } catch (err) {
        error.textContent = err instanceof ApiError ? err.message : "Login failed.";
      } finally {
        submit.disabled = false;
      }
    },
    "primary",
    { type: "submit" },
  );
  const form = el("form", {}, [
    field("Email", email, { id: "login-email" }),
    field("Password", password, { id: "login-password" }),
    error,
    submit,
  ]);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    submit.click();
  });
  const switchLine = el("p", { class: "auth-switch" }, [
    text("No account yet? "),
    el("a", { href: "#/signup" }, [text("Create one")]),
    text(". First signup creates your organization."),
  ]);
  root.replaceChildren(authShell("Log in", BRANDING.tagline, form, switchLine));
  email.focus();
}

export function renderSignup(root: HTMLElement, onDone: () => void): void {
  const name = textInput({ autocomplete: "name", id: "signup-name", placeholder: "Your name" });
  const orgName = textInput({ id: "signup-org", placeholder: "Organization name" });
  const email = textInput({ autocomplete: "email", id: "signup-email", placeholder: "you@example.com", type: "email" });
  const password = textInput({ autocomplete: "new-password", id: "signup-password", placeholder: "Password (min 8 characters)", type: "password" });
  const error = el("p", { class: "field-hint", role: "alert" });
  const submit = button(
    "Create account",
    async () => {
      error.textContent = "";
      submit.disabled = true;
      try {
        await api.signup(name.value.trim(), email.value.trim(), password.value, orgName.value.trim());
        toast("Account created. Welcome to the forge.", "success");
        onDone();
      } catch (err) {
        error.textContent = err instanceof ApiError ? err.message : "Signup failed.";
      } finally {
        submit.disabled = false;
      }
    },
    "primary",
    { type: "submit" },
  );
  const form = el("form", {}, [
    field("Your name", name, { id: "signup-name" }),
    field("Organization", orgName, { hint: "One organization per workspace. Data never leaves it.", id: "signup-org" }),
    field("Email", email, { id: "signup-email" }),
    field("Password", password, { id: "signup-password" }),
    error,
    submit,
  ]);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    submit.click();
  });
  const switchLine = el("p", { class: "auth-switch" }, [
    text("Already have an account? "),
    el("a", { href: "#/login" }, [text("Log in")]),
    text("."),
  ]);
  root.replaceChildren(authShell("Create your account", BRANDING.tagline, form, switchLine));
  name.focus();
}

export function renderLoggedOutNote(): HTMLElement {
  return sectionCard("Logged out", el("p", {}, [text("Your session ended. "), el("a", { href: "#/login" }, [text("Log in again")]), text(".")]));
}
