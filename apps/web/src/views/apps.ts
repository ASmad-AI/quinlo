/** App list: search, create, open, delete. */
import { api, type AppSummary } from "../api";
import { BRANDING } from "../branding";
import {
  badge,
  button,
  confirmDialog,
  el,
  emptyState,
  field,
  formatDate,
  openModal,
  text,
  textArea,
  textInput,
  toast,
} from "../components";
import { pageHead, withLoading, type ViewContext } from "./helpers";

function appCard(app: AppSummary, onDelete: (app: AppSummary) => void): HTMLElement {
  const card = el("article", { class: "card" }, [
    el("h2", { class: "card-title" }, [
      el("a", { href: `#/apps/${app.id}/studio` }, [text(app.name)]),
    ]),
    el("p", { class: "card-hint" }, [text(app.description || "No description yet.")]),
    el("div", { class: "row" }, [
      badge(app.slug, "neutral"),
      badge(`Updated ${formatDate(app.updated_at)}`, "neutral"),
    ]),
    el("div", { class: "row", style: "margin-top: 0.75rem" }, [
      el("a", { class: "btn btn-primary btn-sm", href: `#/apps/${app.id}/studio` }, [text("Open Studio")]),
      el("a", { class: "btn btn-secondary btn-sm", href: `#/apps/${app.id}/data` }, [text("Data")]),
      button("Delete", () => onDelete(app), "danger"),
    ]),
  ]);
  return card;
}

export async function renderApps(root: HTMLElement, ctx: ViewContext): Promise<void> {
  await withLoading(root, async () => {
    const { apps } = await api.listApps();
    const search = textInput({ placeholder: "Search apps…" });
    search.setAttribute("aria-label", "Search apps");
    const grid = el("div", { class: "grid-3" });

    const openCreate = () => {
      const name = textInput({ id: "new-app-name", placeholder: "My SaaS" });
      const desc = textArea({ id: "new-app-desc", placeholder: "What does it do?", rows: 3 });
      const close = openModal(
        "New app",
        el("div", {}, [
          field("Name", name, { id: "new-app-name" }),
          field("Description", desc, { id: "new-app-desc" }),
          el("p", { class: "field-hint" }, [text("Default Admin / Member / Guest profiles are created with the app. Guest starts with no access.")]),
        ]),
        [
          button("Cancel", () => close()),
          button(
            "Create app",
            async () => {
              if (!name.value.trim()) {
                toast("Give the app a name first.", "error");
                return;
              }
              try {
                const { app } = await api.createApp(name.value.trim(), desc.value.trim());
                close();
                toast(`Created “${app.name}”.`, "success");
                ctx.navigate(`#/apps/${app.id}/studio`);
              } catch (err) {
                toast(err instanceof Error ? err.message : "Could not create the app.", "error");
              }
            },
            "primary",
          ),
        ],
      );
    };

    const renderGrid = (list: AppSummary[]) => {
      grid.replaceChildren();
      if (list.length === 0) {
        grid.replaceChildren(
          emptyState(
            "No apps yet",
            `Create your first app, then connect your AI assistant over MCP at ${window.location.origin}${BRANDING.mcpPath} and describe what to build.`,
            button("Create your first app", openCreate, "primary"),
          ),
        );
        return;
      }
      for (const app of list) {
        grid.append(
          appCard(app, async (target) => {
            const ok = await confirmDialog(
              "Delete app?",
              `“${target.name}” and its data, files, profiles, and keys will be deleted. This cannot be undone. Eject first if you want a copy.`,
              "Delete app",
              true,
            );
            if (!ok) return;
            try {
              await api.deleteApp(target.id);
              toast("App deleted.", "success");
              await renderApps(root, ctx);
            } catch (err) {
              toast(err instanceof Error ? err.message : "Could not delete the app.", "error");
            }
          }),
        );
      }
    };

    search.addEventListener("input", () => {
      const q = search.value.toLowerCase();
      renderGrid(apps.filter((a) => a.name.toLowerCase().includes(q) || a.slug.includes(q)));
    });

    renderGrid(apps);
    root.replaceChildren(
      pageHead("Apps", `Signed in as ${ctx.user.name} · ${ctx.user.email} · Profile: ${ctx.user.profile_name}`, [
        button("New app", openCreate, "primary"),
      ]),
      el("div", { class: "stack" }, [search, grid]),
    );
  });
}
