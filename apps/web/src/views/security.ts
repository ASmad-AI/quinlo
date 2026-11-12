/** Security: profile matrix + rule editor, API-key manager, secrets vault. */
import { api, type SecurityProfile, type TableRule } from "../api";
import {
  badge,
  button,
  confirmDialog,
  el,
  emptyState,
  field,
  openModal,
  sectionCard,
  checkboxInput,
  tabs,
  text,
  textArea,
  textInput,
  toast,
} from "../components";
import { appNav, pageHead, withLoading, type ViewContext } from "./helpers";

const OPS = ["read", "create", "update", "delete"] as const;

function opAllowed(rule: TableRule | undefined, op: (typeof OPS)[number]): boolean {
  if (!rule) return false;
  const value = rule[op];
  if (value === undefined || value === false) return false;
  return true;
}

function opDetail(rule: TableRule | undefined, op: (typeof OPS)[number]): string {
  if (!rule) return "deny";
  const value = rule[op];
  if (value === undefined || value === false) return "deny";
  if (value === true) return "allow";
  if (Array.isArray(value)) return `allow if ${value.length} row condition${value.length === 1 ? "" : "s"}`;
  const fields = value.fields === "*" ? "*" : value.fields.join(", ");
  const row = value.row?.length ? ` + ${value.row.length} row condition${value.row.length === 1 ? "" : "s"}` : "";
  return `${fields}${row}`;
}

async function renderProfilesTab(box: HTMLElement, appId: string, profiles: SecurityProfile[], collections: string[]): Promise<void> {
  const table = el("table", { class: "data-table matrix-table" });
  const header = el("tr", {}, [
    el("th", {}, [text("Profile \\ Table")]),
    ...collections.map((c) => el("th", {}, [text(c)])),
    el("th", {}, [text("Actions")]),
  ]);
  table.append(el("thead", {}, [header]));
  const tbody = el("tbody");
  for (const profile of profiles) {
    const cells: HTMLElement[] = [el("td", {}, [
      el("strong", {}, [text(profile.name)]),
      profile.isDefault ? badge(" default", "info") : text(""),
      profile.description ? el("div", { class: "card-hint" }, [text(profile.description)]) : text(""),
    ])];
    for (const collection of collections) {
      const rule = profile.rules[collection];
      const isAdmin = profile.name === "Admin" && Object.keys(profile.rules).length === 0;
      const cell = el("td", { class: "matrix-cell" });
      if (isAdmin) {
        cell.append(el("span", { class: "matrix-allow" }, [text("full access")]));
      } else if (!rule) {
        cell.append(el("span", { class: "matrix-deny" }, [text("deny all")]));
      } else {
        cell.append(
          el("div", { style: "text-align: left; font-size: 0.85rem" }, OPS.map((op) =>
            el("div", {}, [
              el("span", { class: opAllowed(rule, op) ? "matrix-allow" : "matrix-deny" }, [text(opAllowed(rule, op) ? "✓ " : "✗ ")]),
              text(`${op} `),
              el("span", { class: "mono" }, [text(opDetail(rule, op))]),
            ]),
          )),
        );
      }
      cells.push(cell);
    }
    cells.push(el("td", {}, [
      el("div", { class: "row" }, [
        button("Edit rules", () => openRuleEditor(appId, profile, collections, () => void refreshProfiles()), "secondary"),
        button("Delete", async () => {
          const ok = await confirmDialog("Delete profile?", `Delete the “${profile.name}” profile? Users assigned to it lose access.`, "Delete", true);
          if (!ok) return;
          try {
            await api.deleteProfile(appId, profile.id);
            toast("Profile deleted.", "success");
            await refreshProfiles();
          } catch (err) {
            toast(err instanceof Error ? err.message : "Delete failed.", "error");
          }
        }, "danger"),
      ]),
    ]));
    tbody.append(el("tr", {}, cells));
  }
  table.append(tbody);

  const refreshProfiles = async () => {
    const fresh = await api.listProfiles(appId);
    await renderProfilesTab(box, appId, fresh.profiles, collections);
  };

  const createBtn = button("New profile", () => openRuleEditor(appId, null, collections, () => void refreshProfiles()), "primary");
  box.replaceChildren(
    sectionCard(
      "Security profiles",
      collections.length === 0
        ? emptyState("No collections yet", "Create a collection in the Data tab, then grant profiles access to it here.")
        : el("div", { class: "matrix-wrap" }, [table]),
      { hint: "Fail-closed: anything not explicitly allowed is denied. Admin with no rules means full access to known tables. Rules are enforced server-side on every request — frontend code cannot override them." },
    ),
    el("div", { class: "row" }, [createBtn]),
    el("div", { class: "callout" }, [
      el("p", {}, [text("Row conditions use $user.id, $org.id, and $user.email. Example: a Member read rule with fields [\"title\", \"status\"] and row condition { field: \"owner_id\", op: \"eq\", value: \"$user.id\" } lets members read only their own rows.")]),
    ]),
  );
}

function openRuleEditor(appId: string, profile: SecurityProfile | null, collections: string[], onSaved: () => void): void {
  const name = textInput({ id: "profile-name", placeholder: "Member", value: profile?.name ?? "" });
  const description = textInput({ id: "profile-desc", placeholder: "What this profile is for", value: profile?.description ?? "" });
  const sampleRules: Record<string, TableRule> = {};
  for (const c of collections) sampleRules[c] = { read: { fields: "*" } };
  const rulesText = textArea({
    rows: 12,
    value: JSON.stringify(profile?.rules ?? sampleRules, null, 2),
  });
  rulesText.setAttribute("aria-label", "Profile rules JSON");
  const error = el("p", { class: "field-hint", role: "alert" });
  const close = openModal(
    profile ? `Edit profile “${profile.name}”` : "New profile",
    el("div", {}, [
      field("Name", name, { id: "profile-name" }),
      field("Description", description, { id: "profile-desc" }),
      field("Rules (JSON)", rulesText, { hint: "Per table: read/create/update take { fields, denyFields?, row? } or false; delete takes true/false or row conditions." }),
      error,
    ]),
    [
      button("Cancel", () => close()),
      button(
        "Save profile",
        async () => {
          let rules: Record<string, TableRule>;
          try {
            rules = JSON.parse(rulesText.value) as Record<string, TableRule>;
          } catch {
            error.textContent = "Rules are not valid JSON.";
            return;
          }
          try {
            if (profile) await api.updateProfile(appId, profile.id, { description: description.value, name: name.value.trim(), rules });
            else await api.createProfile(appId, { description: description.value, name: name.value.trim(), rules });
            close();
            toast("Profile saved.", "success");
            onSaved();
          } catch (err) {
            error.textContent = err instanceof Error ? err.message : "Save failed.";
          }
        },
        "primary",
      ),
    ],
  );
}

async function renderKeysTab(box: HTMLElement, appId: string): Promise<void> {
  const { apiKeys } = await api.listApiKeys(appId);
  const rows = apiKeys.map((key) => {
    const revoked = Boolean(key.revoked_at);
    return el("tr", {}, [
      el("td", {}, [text(key.name)]),
      el("td", { class: "mono" }, [text(`${key.prefix}…`)]),
      el("td", {}, [text(key.profile_name)]),
      el("td", {}, [text(key.scopes.join(", "))]),
      el("td", {}, [text(key.last_used_at ?? "never")]),
      el("td", {}, [revoked ? badge("revoked", "danger") : badge("active", "success")]),
      el("td", {}, [
        revoked
          ? text("—")
          : button("Revoke", async () => {
              const ok = await confirmDialog("Revoke key?", `Revoke “${key.name}”? Calls using it will start failing immediately.`, "Revoke", true);
              if (!ok) return;
              try {
                await api.revokeApiKey(appId, key.id);
                toast("Key revoked.", "success");
                await renderKeysTab(box, appId);
              } catch (err) {
                toast(err instanceof Error ? err.message : "Revoke failed.", "error");
              }
            }, "danger"),
      ]),
    ]);
  });
  const table = el("table", { class: "data-table" });
  table.append(
    el("thead", {}, [el("tr", {}, ["Name", "Prefix", "Profile", "Scopes", "Last used", "Status", ""].map((h) => el("th", {}, [text(h)])))]),
    el("tbody", {}, rows),
  );

  const openCreate = () => {
    const name = textInput({ id: "key-name", placeholder: "CI deploy key" });
    const profileName = textInput({ id: "key-profile", placeholder: "Admin", value: "Admin" });
    const scopeAll = checkboxInput("Full access (*)", true);
    const scopeRead = checkboxInput("records:read", false);
    const scopeWrite = checkboxInput("records:write", false);
    const scopeFileRead = checkboxInput("files:read", false);
    const scopeFileWrite = checkboxInput("files:write", false);
    const close = openModal(
      "New API key",
      el("div", {}, [
        field("Name", name, { id: "key-name" }),
        field("Profile", profileName, { hint: "The key acts with this profile's rules.", id: "key-profile" }),
        el("div", { class: "field" }, [el("span", { class: "field-label" }, [text("Scopes")]), scopeAll.wrap, scopeRead.wrap, scopeWrite.wrap, scopeFileRead.wrap, scopeFileWrite.wrap]),
        el("p", { class: "field-hint" }, [text("The plaintext key is shown once, when created. It is stored only as a hash.")]),
      ]),
      [
        button("Cancel", () => close()),
        button(
          "Create key",
          async () => {
            const scopes: string[] = [];
            if (scopeAll.box.checked) scopes.push("*");
            if (scopeRead.box.checked) scopes.push("records:read");
            if (scopeWrite.box.checked) scopes.push("records:write");
            if (scopeFileRead.box.checked) scopes.push("files:read");
            if (scopeFileWrite.box.checked) scopes.push("files:write");
            try {
              const { plaintext } = await api.createApiKey(appId, { name: name.value.trim(), profileName: profileName.value.trim() || "Admin", scopes: scopes.length ? scopes : ["*"] });
              close();
              const keyBox = el("div", {}, [
                el("p", {}, [text("Copy this key now — it will never be shown again.")]),
                el("pre", { class: "code-block" }, [el("code", {}, [text(plaintext)])]),
              ]);
              const close2 = openModal("Your new API key", keyBox, [
                button("Copy", async () => {
                  try {
                    await navigator.clipboard.writeText(plaintext);
                    toast("Key copied.", "success");
                  } catch {
                    toast("Clipboard unavailable.", "error");
                  }
                }, "primary"),
                button("Done", () => close2()),
              ]);
              await renderKeysTab(box, appId);
            } catch (err) {
              toast(err instanceof Error ? err.message : "Create failed.", "error");
            }
          },
          "primary",
        ),
      ],
    );
  };

  box.replaceChildren(
    sectionCard(
      "API keys",
      apiKeys.length === 0
        ? emptyState("No API keys", "Keys authenticate the versioned REST API and the MCP server. Create one with the smallest scopes you need.", button("Create API key", openCreate, "primary"))
        : el("div", { class: "table-wrap" }, [table]),
      { hint: "Send keys as Authorization: Bearer <key>. Keys are scoped to this app and bound to a profile." },
    ),
    el("div", { class: "row" }, [button("New API key", openCreate, "primary")]),
  );
}

async function renderSecretsTab(box: HTMLElement, appId: string): Promise<void> {
  const { secrets } = await api.listSecrets(appId);
  const list = el("div", { class: "stack" });
  for (const name of secrets) {
    list.append(
      el("div", { class: "row", style: "justify-content: space-between" }, [
        el("code", { class: "mono" }, [text(name)]),
        button("Delete", async () => {
          const ok = await confirmDialog("Delete secret?", `Delete ${name}? Functions and integrations using it will fail.`, "Delete", true);
          if (!ok) return;
          try {
            await api.deleteSecret(appId, name);
            toast("Secret deleted.", "success");
            await renderSecretsTab(box, appId);
          } catch (err) {
            toast(err instanceof Error ? err.message : "Delete failed.", "error");
          }
        }, "danger"),
      ]),
    );
  }
  const keyInput = textInput({ id: "secret-key", placeholder: "STRIPE_SECRET_KEY" });
  const valueInput = textInput({ id: "secret-value", placeholder: "Secret value", type: "password" });
  const saveBtn = button(
    "Save secret",
    async () => {
      if (!keyInput.value.trim() || !valueInput.value) {
        toast("Both a key name and a value are required.", "error");
        return;
      }
      try {
        await api.setSecret(appId, keyInput.value.trim(), valueInput.value);
        toast("Secret stored in the encrypted vault.", "success");
        await renderSecretsTab(box, appId);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Save failed.", "error");
      }
    },
    "primary",
  );
  box.replaceChildren(
    sectionCard(
      "Secrets vault",
      secrets.length === 0
        ? emptyState("No secrets stored", "Secrets are encrypted with AES-256-GCM before storage. Values are never returned by the API.")
        : list,
      { hint: "Use secrets for provider keys (Stripe, GitHub, OAuth). The GitHub token is read from the vault key GITHUB_TOKEN." },
    ),
    sectionCard("Add or update a secret", el("div", {}, [field("Key", keyInput, { id: "secret-key" }), field("Value", valueInput, { id: "secret-value" }), saveBtn])),
  );
}

export async function renderSecurity(root: HTMLElement, ctx: ViewContext, appId: string): Promise<void> {
  await withLoading(root, async () => {
    const { app } = await api.getApp(appId);
    const [{ profiles }, { collections }] = await Promise.all([api.listProfiles(appId), api.getSchema(appId)]);
    const collectionNames = collections.map((c) => c.name);
    const box = el("div", { class: "stack" });
    let active: "profiles" | "keys" | "secrets" = "profiles";
    const bar = el("div");
    const renderTab = async () => {
      bar.replaceChildren(tabs(
        [
          { id: "profiles", label: "Profiles" },
          { id: "keys", label: "API keys" },
          { id: "secrets", label: "Secrets" },
        ],
        active,
        (id) => {
          active = id as typeof active;
          void renderTab();
        },
      ));
      box.replaceChildren(el("p", { class: "card-hint" }, [text("Loading…")]));
      try {
        if (active === "profiles") await renderProfilesTab(box, appId, profiles, collectionNames);
        else if (active === "keys") await renderKeysTab(box, appId);
        else await renderSecretsTab(box, appId);
      } catch (err) {
        box.replaceChildren(el("div", { class: "callout callout-danger" }, [el("p", {}, [text(err instanceof Error ? err.message : "Could not load this section.")])]));
      }
    };
    root.replaceChildren(
      pageHead(app.name, "Security · Profile Lock, API keys, and the encrypted secrets vault."),
      appNav(appId, "security"),
      bar,
      box,
    );
    await renderTab();
  });
}
