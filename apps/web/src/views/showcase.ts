/** Design showcase: every component, theme switcher, and state in one place. */
import { avatarSvg, CREW, type AvatarExpression } from "../avatars";
import {
  badge,
  button,
  checkboxInput,
  codeBlock,
  el,
  emptyState,
  errorState,
  field,
  sectionCard,
  selectInput,
  spinner,
  tabs,
  text,
  textArea,
  textInput,
  toast,
} from "../components";
import { logoSvg } from "../logo";
import { applyThemeState, currentThemeState, THEMES } from "../themes";
import { pageHead, type ViewContext } from "./helpers";

const SWATCHES: Array<[string, string]> = [
  ["--color-bg", "var(--color-bg)"],
  ["--color-surface", "var(--color-surface)"],
  ["--color-surface-2", "var(--color-surface-2)"],
  ["--color-surface-3", "var(--color-surface-3)"],
  ["--color-text", "var(--color-text)"],
  ["--color-text-muted", "var(--color-text-muted)"],
  ["--color-border", "var(--color-border)"],
  ["--color-accent", "var(--color-accent)"],
  ["--color-success", "var(--color-success)"],
  ["--color-danger", "var(--color-danger)"],
  ["--color-warning", "var(--color-warning)"],
  ["--color-info", "var(--color-info)"],
];

export function renderShowcase(root: HTMLElement, _ctx: ViewContext): void {
  // Theme switcher (live)
  const themeRow = el("div", { class: "row" });
  for (const theme of THEMES) {
    themeRow.append(
      button(theme.label, () => {
        applyThemeState({ ...currentThemeState(), theme: theme.id });
        toast(`Theme: ${theme.label}`, "info");
      }, currentThemeState().theme === theme.id ? "primary" : "secondary"),
    );
  }
  themeRow.append(
    button("Toggle dark/light", () => {
      const s = currentThemeState();
      applyThemeState({ ...s, scheme: s.scheme === "dark" ? "light" : "dark" });
    }),
    button("Toggle motion", () => {
      const s = currentThemeState();
      applyThemeState({ ...s, motion: s.motion === "reduced" ? "full" : "reduced" });
    }),
  );

  const swatches = el("div", { class: "swatch-grid" });
  for (const [name, value] of SWATCHES) {
    swatches.append(
      el("div", { class: "swatch" }, [
        el("div", { class: "swatch-chip", style: `background: ${value}` }),
        el("div", { class: "swatch-label" }, [text(name)]),
      ]),
    );
  }

  const expressions: AvatarExpression[] = ["idle", "thinking", "working", "blocked", "done", "error"];
  const avatarStates = el("div", { class: "row" });
  for (const expr of expressions) {
    avatarStates.append(
      el("div", { style: "text-align: center" }, [
        el("div", { html: avatarSvg({ accessory: true, background: "disc", character: "ember", expression: expr, hueShift: 0 }, 64, { animate: true }) }),
        el("div", { class: "field-hint" }, [text(expr)]),
      ]),
    );
  }
  const crewRow = el("div", { class: "row" });
  for (const member of CREW) {
    crewRow.append(
      el("div", { style: "text-align: center" }, [
        el("div", { html: avatarSvg({ accessory: true, background: "disc", character: member.character, expression: "idle", hueShift: 0 }, 64) }),
        el("div", { class: "field-hint" }, [text(member.name)]),
      ]),
    );
  }

  const sampleTable = el("table", { class: "data-table" });
  sampleTable.append(
    el("thead", {}, [el("tr", {}, ["Name", "Status", "Owner"].map((h) => el("th", {}, [text(h)])))]),
    el("tbody", {}, [
      el("tr", {}, [el("td", {}, [text("Ship the thing")]), el("td", {}, [badge("live", "success")]), el("td", {}, [text("Ember")])]),
      el("tr", {}, [el("td", {}, [text("Fix the lock")]), el("td", {}, [badge("blocked", "warning")]), el("td", {}, [text("Anvil")])]),
    ]),
  );

  const disabledBtn = button("Disabled", () => undefined, "primary", { disabled: true });
  const formSample = el("div", {}, [
    field("Text input", textInput({ placeholder: "Type something…" })),
    field("Textarea", textArea({ placeholder: "Longer text…", rows: 3 })),
    field("Select", selectInput([{ label: "Option one", value: "1" }, { label: "Option two", value: "2" }])),
    checkboxInput("A checkbox option", true).wrap,
  ]);

  root.replaceChildren(
    pageHead("Design showcase", "Every component, token, theme, and state — live. Switch themes above and watch the whole page follow."),
    el("div", { class: "stack" }, [
      sectionCard("Themes", themeRow, { hint: "Three themes × dark/light, persisted. Motion honors the OS reduced-motion setting." }),
      sectionCard("Logo", el("div", { class: "row", style: "color: var(--color-accent)" }, [
        el("span", { html: logoSvg(56, "Logo mark, large") }),
        el("span", { html: logoSvg(28, "Logo mark, small") }),
        el("span", { html: logoSvg(16, "Logo mark, tiny") }),
      ])),
      sectionCard("Semantic tokens", swatches, { hint: "All component colour flows through these tokens. Primitives live in styles.css." }),
      sectionCard("Buttons", el("div", { class: "row" }, [
        button("Primary", () => toast("Primary clicked", "info"), "primary"),
        button("Secondary", () => toast("Secondary clicked", "info")),
        button("Danger", () => toast("Danger clicked", "error"), "danger"),
        button("Ghost", () => toast("Ghost clicked", "info"), "ghost"),
        disabledBtn,
      ])),
      sectionCard("Badges", el("div", { class: "row" }, [
        badge("neutral"), badge("success", "success"), badge("warning", "warning"),
        badge("danger", "danger"), badge("info", "info"), badge("accent", "accent"),
      ])),
      sectionCard("Forms", formSample),
      sectionCard("Tabs", tabs([{ id: "a", label: "First" }, { id: "b", label: "Second" }], "a", () => undefined)),
      sectionCard("Table", el("div", { class: "table-wrap" }, [sampleTable])),
      sectionCard("Code", codeBlock("const answer = 42;\nconsole.log(answer);")),
      sectionCard("States", el("div", { class: "stack" }, [
        spinner("Loading something…"),
        emptyState("Nothing here yet", "Empty states explain what to do next.", button("Do the thing", () => toast("Done", "success"), "primary")),
        errorState("The server refused this request.", () => toast("Retrying…", "info")),
      ])),
      sectionCard("Avatar expressions (Ember)", avatarStates, { hint: "Thinking/working animate subtly; all motion stops under reduced-motion." }),
      sectionCard("Forge crew", crewRow, { hint: "Distinct silhouettes, hues, and accessories — legible at 24px." }),
      sectionCard("Type scale", el("div", {}, [
        el("p", { style: "font-size: var(--text-3xl); margin: 0" }, [text("Display 3xl")]),
        el("p", { style: "font-size: var(--text-2xl); margin: 0" }, [text("Title 2xl")]),
        el("p", { style: "font-size: var(--text-xl); margin: 0" }, [text("Heading xl")]),
        el("p", { style: "font-size: var(--text-lg); margin: 0" }, [text("Large lg")]),
        el("p", { style: "margin: 0" }, [text("Body base")]),
        el("p", { style: "font-size: var(--text-sm); margin: 0" }, [text("Small sm")]),
        el("p", { style: "font-size: var(--text-xs); margin: 0" }, [text("Extra small xs")]),
      ])),
    ]),
  );
}
