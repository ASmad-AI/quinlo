/**
 * Forge crew avatars: original parametric SVG art. Four characters with
 * distinct silhouettes, hues, accessories, traits, and greetings, each
 * with six expressive states. Nothing here reuses any reference
 * product's mascot or artwork. Avatar packs are plain JSON data.
 */
import { BRANDING } from "./branding";
import { el, selectInput, checkboxInput, field, text } from "./components";

export type AvatarCharacter = "ember" | "anvil" | "quench" | "bellows";
export type AvatarExpression = "idle" | "thinking" | "working" | "blocked" | "done" | "error";
export type AvatarBackground = "disc" | "ring" | "none";

export interface AvatarLook {
  accessory: boolean;
  background: AvatarBackground;
  character: AvatarCharacter;
  expression: AvatarExpression;
  hueShift: number;
}

export interface CrewMember {
  accessory: string;
  character: AvatarCharacter;
  greeting: string;
  hue: number;
  name: string;
  role: string;
  traits: string[];
}

export const CREW: CrewMember[] = [
  {
    accessory: "spark star",
    character: "ember",
    greeting: "Let's hammer out a first draft.",
    hue: 32,
    name: "Ember",
    role: "Builder",
    traits: ["Fast", "Curious", "Ships drafts"],
  },
  {
    accessory: "guard shield",
    character: "anvil",
    greeting: "Nothing ships until the lock holds.",
    hue: 220,
    name: "Anvil",
    role: "Guardian",
    traits: ["Careful", "Strict", "Fail-closed"],
  },
  {
    accessory: "inspector lens",
    character: "quench",
    greeting: "I'll try to break it before your users do.",
    hue: 178,
    name: "Quench",
    role: "Tester",
    traits: ["Skeptical", "Thorough", "Kind breaker"],
  },
  {
    accessory: "launch arrow",
    character: "bellows",
    greeting: "Staging is warm. Say the word.",
    hue: 14,
    name: "Bellows",
    role: "Deployer",
    traits: ["Steady", "Watchful", "Rolls back fast"],
  },
];

export const DEFAULT_LOOK: AvatarLook = {
  accessory: true,
  background: "disc",
  character: "ember",
  expression: "idle",
  hueShift: 0,
};

const LOOK_KEY = `${BRANDING.slug}.avatar-look`;

export function loadLook(): AvatarLook {
  try {
    const raw = window.localStorage.getItem(LOOK_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AvatarLook>;
      if (parsed && CREW.some((c) => c.character === parsed.character)) {
        return { ...DEFAULT_LOOK, ...parsed };
      }
    }
  } catch {
    // Fall through to default.
  }
  return { ...DEFAULT_LOOK };
}

export function saveLook(look: AvatarLook): void {
  try {
    window.localStorage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch {
    // Storage unavailable: look still applies for the session.
  }
}

/** Body silhouette per character, drawn in a 64x64 box. */
function bodyPath(character: AvatarCharacter): string {
  switch (character) {
    case "ember":
      // Flame teardrop.
      return "M32 8 C42 20 48 27 48 38 a16 16 0 1 1 -32 0 C16 27 22 20 32 8 Z";
    case "anvil":
      // Anvil: flat top, horn, waist, base.
      return "M12 20 h40 v6 h-14 l-3 8 h8 v6 H21 v-6 h8 l-3 -8 H12 Z M14 44 h36 v6 H14 Z";
    case "quench":
      // Droplet.
      return "M32 7 C32 7 48 26 48 38 a16 16 0 1 1 -32 0 C16 26 32 7 32 7 Z";
    case "bellows":
      // Wind puff: three-lobed cloud.
      return "M22 44 a10 10 0 1 1 2 -19.8 A12 12 0 0 1 46 28 a9 9 0 0 1 -2 16 Z";
  }
}

/** Face (eyes + mouth) per expression, positioned for the 64x64 box. */
function faceMarkup(expression: AvatarExpression, ink: string): string {
  const eye = (cx: number, cy: number, r = 2.6) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${ink}"/>`;
  const arc = (cx: number, cy: number, flip: boolean) =>
    `<path d="M${cx - 4} ${cy} Q${cx} ${cy + (flip ? -4.5 : 4.5)} ${cx + 4} ${cy}" stroke="${ink}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  const cross = (cx: number, cy: number) =>
    `<path d="M${cx - 3} ${cy - 3} L${cx + 3} ${cy + 3} M${cx + 3} ${cy - 3} L${cx - 3} ${cy + 3}" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`;
  const mouth = (d: string) => `<path d="${d}" stroke="${ink}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  switch (expression) {
    case "thinking":
      return eye(25, 33) + eye(39, 33) + mouth("M27 45 h10") + `<circle cx="47" cy="20" r="1.8" fill="${ink}"/>`;
    case "working":
      return (
        eye(25, 36) +
        eye(39, 36) +
        `<path d="M21 29 L29 31 M43 29 L35 31" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>` +
        mouth("M27 45 Q32 49 37 45")
      );
    case "blocked":
      return cross(25, 36) + cross(39, 36) + mouth("M27 46 h10");
    case "done":
      return arc(25, 36, true) + arc(39, 36, true) + mouth("M26 44 Q32 50 38 44");
    case "error":
      return eye(25, 35) + eye(39, 35) + mouth("M27 48 Q32 43 37 48");
    case "idle":
    default:
      return eye(25, 36) + eye(39, 36) + mouth("M27 45 Q32 48.5 37 45");
  }
}

function accessoryMarkup(character: AvatarCharacter, accent: string): string {
  switch (character) {
    case "ember":
      return `<path d="M50 12 l1.6 3.4 3.4 1.6 -3.4 1.6 -1.6 3.4 -1.6 -3.4 -3.4 -1.6 3.4 -1.6 Z" fill="${accent}"/>`;
    case "anvil":
      return `<path d="M50 10 l6 2 v5 c0 4 -3 6 -6 7 -3 -1 -6 -3 -6 -7 v-5 Z" fill="${accent}"/>`;
    case "quench":
      return `<circle cx="50" cy="16" r="5" fill="none" stroke="${accent}" stroke-width="2.4"/><path d="M54 20 L58 24" stroke="${accent}" stroke-width="2.4" stroke-linecap="round"/>`;
    case "bellows":
      return `<path d="M50 22 V9 M44 15 L50 9 L56 15" stroke="${accent}" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
}

const STATE_TOKENS: Record<AvatarExpression, string> = {
  blocked: "var(--color-warning)",
  done: "var(--color-success)",
  error: "var(--color-danger)",
  idle: "var(--color-accent)",
  thinking: "var(--color-info)",
  working: "var(--color-accent)",
};

export function avatarSvg(look: AvatarLook, size = 48, opts: { animate?: boolean; label?: string } = {}): string {
  const member = CREW.find((c) => c.character === look.character) ?? CREW[0];
  const hue = (member.hue + look.hueShift + 360) % 360;
  const body = `hsl(${hue} 72% 52%)`;
  const bodyDeep = `hsl(${hue} 68% 40%)`;
  const ink = "hsl(0 0% 12%)";
  const bg = look.background === "disc" ? `<circle cx="32" cy="32" r="30" fill="hsl(${hue} 60% 88%)"/>` : "";
  const ring =
    look.background === "ring"
      ? `<circle cx="32" cy="32" r="29" fill="none" stroke="${body}" stroke-width="2.5"/>`
      : "";
  const stateRing = `<circle cx="32" cy="32" r="30.5" fill="none" style="stroke:${STATE_TOKENS[look.expression]}" stroke-width="2" stroke-dasharray="${look.expression === "idle" ? "none" : "5 4"}" opacity="0.85"/>`;
  const label = opts.label ?? `${member.name} the ${member.role}, ${look.expression}`;
  const animClass = opts.animate && (look.expression === "thinking" || look.expression === "working") ? ` class="avatar-anim"` : "";
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="${label}"${animClass}>` +
    bg +
    ring +
    `<path d="${bodyPath(look.character)}" fill="${body}" stroke="${bodyDeep}" stroke-width="1.5" stroke-linejoin="round"/>` +
    faceMarkup(look.expression, ink) +
    (look.accessory ? accessoryMarkup(look.character, bodyDeep) : "") +
    stateRing +
    `</svg>`
  );
}

/** Live look editor: character, hue, background, accessory, expression + role presets. */
export function lookEditor(initial: AvatarLook, onChange: (look: AvatarLook) => void): HTMLElement {
  let look = { ...initial };
  const wrap = el("div", { class: "look-editor" });
  const previewBox = el("div", { class: "look-preview" });
  const render = () => {
    previewBox.innerHTML = avatarSvg(look, 96, { animate: true });
  };
  render();

  const apply = () => {
    saveLook(look);
    render();
    onChange({ ...look });
  };

  const charSel = selectInput(
    CREW.map((c) => ({ label: `${c.name} — ${c.role}`, value: c.character })),
    { value: look.character },
  );
  charSel.addEventListener("change", () => {
    look.character = charSel.value as AvatarCharacter;
    apply();
  });

  const hueInput = el("input", { class: "input", max: "40", min: "-40", step: "1", type: "range", value: String(look.hueShift) }) as HTMLInputElement;
  const hueVal = el("span", { class: "range-value" }, [text(String(look.hueShift))]);
  hueInput.addEventListener("input", () => {
    look.hueShift = Number(hueInput.value);
    hueVal.textContent = hueInput.value;
    apply();
  });

  const bgSel = selectInput(
    [
      { label: "Disc background", value: "disc" },
      { label: "Ring only", value: "ring" },
      { label: "No background", value: "none" },
    ],
    { value: look.background },
  );
  bgSel.addEventListener("change", () => {
    look.background = bgSel.value as AvatarBackground;
    apply();
  });

  const exprSel = selectInput(
    (["idle", "thinking", "working", "blocked", "done", "error"] as AvatarExpression[]).map((e) => ({ label: e, value: e })),
    { value: look.expression },
  );
  exprSel.addEventListener("change", () => {
    look.expression = exprSel.value as AvatarExpression;
    apply();
  });

  const acc = checkboxInput("Show role accessory", look.accessory);
  acc.box.addEventListener("change", () => {
    look.accessory = acc.box.checked;
    apply();
  });

  const presets = el("div", { class: "preset-row" });
  for (const member of CREW) {
    const btn = el("button", { class: "btn btn-secondary preset-btn", type: "button" }, [text(member.name)]);
    btn.addEventListener("click", () => {
      look = { ...look, accessory: true, character: member.character, hueShift: 0 };
      charSel.value = member.character;
      hueInput.value = "0";
      hueVal.textContent = "0";
      acc.box.checked = true;
      apply();
    });
    presets.append(btn);
  }

  const controls = el("div", { class: "look-controls" }, [
    field("Character", charSel),
    field("Hue shift", el("div", { class: "range-row" }, [hueInput, hueVal])),
    field("Background", bgSel),
    field("Expression", exprSel),
    acc.wrap,
    el("div", { class: "field" }, [el("span", { class: "field-label" }, [text("Role presets")]), presets]),
  ]);
  wrap.append(previewBox, controls);
  return wrap;
}

/** Serialize a look as an avatar pack (data only, no code). */
export function exportLookPack(look: AvatarLook): string {
  return JSON.stringify({ kind: `${BRANDING.slug}-avatar-pack`, version: 1, look }, null, 2);
}

export function importLookPack(json: string): AvatarLook | null {
  try {
    const parsed = JSON.parse(json) as { kind?: string; look?: Partial<AvatarLook> };
    if (parsed.kind !== `${BRANDING.slug}-avatar-pack` || !parsed.look) return null;
    if (!CREW.some((c) => c.character === parsed.look?.character)) return null;
    return { ...DEFAULT_LOOK, ...parsed.look };
  } catch {
    return null;
  }
}
