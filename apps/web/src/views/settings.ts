/** Settings: themes, avatar look editor, MCP connection docs, account. */
import { MCP_CONNECT_URL, api } from "../api";
import { BRANDING } from "../branding";
import {
  button,
  codeBlock,
  el,
  sectionCard,
  text,
  toast,
} from "../components";
import { CREW, avatarSvg, exportLookPack, importLookPack, loadLook, lookEditor, type AvatarLook } from "../avatars";
import { THEMES, applyThemeState, currentThemeState, type Scheme, type ThemeId } from "../themes";
import { pageHead, type ViewContext } from "./helpers";

export async function renderSettings(root: HTMLElement, ctx: ViewContext): Promise<void> {
  const state = currentThemeState();

  // ---- Theme picker ----
  const themeGrid = el("div", { class: "theme-picker" });
  const renderThemes = () => {
    themeGrid.replaceChildren();
    for (const theme of THEMES) {
      const active = currentThemeState().theme === theme.id;
      const card = el("button", {
        class: `theme-option${active ? " theme-option-active" : ""}`,
        type: "button",
        "aria-pressed": active ? "true" : "false",
      }, [
        el("div", { class: "theme-option-name" }, [text(`${theme.label}${theme.signature ? " ★" : ""}`)]),
        el("p", { class: "theme-option-desc" }, [text(theme.description)]),
      ]);
      card.addEventListener("click", () => {
        applyThemeState({ ...currentThemeState(), theme: theme.id as ThemeId });
        renderThemes();
        renderScheme();
      });
      themeGrid.append(card);
    }
  };
  const schemeRow = el("div", { class: "scheme-toggle" });
  const renderScheme = () => {
    const current = currentThemeState();
    schemeRow.replaceChildren(
      button("Dark", () => {
        applyThemeState({ ...currentThemeState(), scheme: "dark" as Scheme });
        renderScheme();
      }, current.scheme === "dark" ? "primary" : "secondary"),
      button("Light", () => {
        applyThemeState({ ...currentThemeState(), scheme: "light" as Scheme });
        renderScheme();
      }, current.scheme === "light" ? "primary" : "secondary"),
      button(`Motion: ${current.motion}`, () => {
        applyThemeState({ ...currentThemeState(), motion: current.motion === "reduced" ? "full" : "reduced" });
        renderScheme();
        toast(current.motion === "reduced" ? "Motion enabled." : "Reduced motion enabled.", "info");
      }),
    );
  };
  renderThemes();
  renderScheme();

  // ---- Avatar look editor + crew ----
  let look: AvatarLook = loadLook();
  const crewGrid = el("div", { class: "crew-grid" });
  for (const member of CREW) {
    crewGrid.append(
      el("div", { class: "card crew-card" }, [
        el("div", { html: avatarSvg({ ...look, character: member.character, expression: "idle" }, 72) }),
        el("h3", { class: "crew-name" }, [text(member.name)]),
        el("p", { class: "crew-role" }, [text(member.role)]),
        el("p", { class: "crew-greeting" }, [text(`“${member.greeting}”`)]),
        el("p", { class: "card-hint" }, [text(member.traits.join(" · "))]),
      ]),
    );
  }
  const editor = lookEditor(look, (next) => {
    look = next;
  });
  const exportBtn = button("Export look as JSON", async () => {
    try {
      await navigator.clipboard.writeText(exportLookPack(look));
      toast("Avatar pack JSON copied. Share it as data — it contains no code.", "success");
    } catch {
      toast("Clipboard unavailable.", "error");
    }
  });
  const importBtn = button("Import look JSON", async () => {
    try {
      const textValue = await navigator.clipboard.readText();
      const imported = importLookPack(textValue);
      if (!imported) {
        toast("Clipboard does not contain a valid avatar pack.", "error");
        return;
      }
      look = imported;
      toast("Avatar pack imported. Reloading settings…", "success");
      await renderSettings(root, ctx);
    } catch {
      toast("Could not read the clipboard.", "error");
    }
  });

  // ---- MCP connect docs ----
  const mcpCard = sectionCard(
    "Connect your AI assistant (MCP)",
    el("div", { class: "stack" }, [
      el("p", {}, [text("Point any MCP client at this server. Authenticate with a Bearer API key (create one in any app's Security tab). Streamable HTTP is primary; legacy SSE is available for older clients.")]),
      el("div", {}, [
        el("h3", {}, [text("Server URL")]),
        codeBlock(MCP_CONNECT_URL, "MCP server URL"),
        el("h3", {}, [text("Legacy SSE URL")]),
        codeBlock(`${window.location.origin}${BRANDING.mcpLegacySsePath}`, "Legacy SSE URL"),
      ]),
      el("div", {}, [
        el("h3", {}, [text("Claude Code / Cursor (remote MCP)")]),
        codeBlock(
          `{\n  "mcpServers": {\n    "${BRANDING.slug}": {\n      "type": "http",\n      "url": "${MCP_CONNECT_URL}",\n      "headers": { "Authorization": "Bearer <YOUR_API_KEY>" }\n    }\n  }\n}`,
          "MCP client config",
        ),
      ]),
      el("div", { class: "callout" }, [
        el("p", {}, [text("Honest client notes: Claude Desktop and Cursor support remote MCP over HTTP. ChatGPT's MCP support varies by plan and client — use the stdio bridge (see docs/mcp-clients.md) when remote HTTP is unavailable. Ollama has no native MCP support and needs a harness or bridge. This server does not implement OAuth dynamic client registration; API-key auth is the supported path.")]),
      ]),
    ]),
  );

  const accountCard = sectionCard(
    "Account",
    el("div", { class: "stack" }, [
      el("dl", { class: "kv-list" }, [
        el("dt", {}, [text("Name")]),
        el("dd", {}, [text(ctx.user.name)]),
        el("dt", {}, [text("Email")]),
        el("dd", {}, [text(ctx.user.email)]),
        el("dt", {}, [text("Profile")]),
        el("dd", {}, [text(ctx.user.profile_name)]),
        el("dt", {}, [text("Organization")]),
        el("dd", { class: "mono" }, [text(ctx.user.org_id)]),
      ]),
      el("div", { class: "row" }, [
        button("Log out", async () => {
          await api.logout();
          ctx.navigate("#/login");
        }, "danger"),
      ]),
    ]),
  );

  root.replaceChildren(
    pageHead("Settings", "Themes, avatars, AI connections, and your account."),
    el("div", { class: "stack" }, [
      sectionCard("Appearance", el("div", { class: "stack" }, [themeGrid, schemeRow]), { hint: "Three themes, each dark and light. Your choice is saved on this device. Reduced motion follows your OS setting unless you override it here." }),
      sectionCard("Your forge crew", el("div", { class: "stack" }, [crewGrid, editor, el("div", { class: "row" }, [exportBtn, importBtn])]), { hint: "Parametric avatars drawn from a small set of shapes. Packs are JSON data only — never code." }),
      mcpCard,
      accountCard,
    ]),
  );
}
