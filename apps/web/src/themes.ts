/**
 * Theme registry: three themes (one default + two signature), each with a
 * dark and a light scheme. Themes are applied as data attributes on
 * <html> and resolved to semantic tokens in styles.css. The choice is
 * persisted in localStorage; the default scheme follows the OS setting.
 */
import { BRANDING } from "./branding";

export type ThemeId = "forge" | "ember" | "quench";
export type Scheme = "dark" | "light";
export type MotionPreference = "full" | "reduced";

export interface ThemeDef {
  description: string;
  id: ThemeId;
  label: string;
  signature: boolean;
}

export const THEMES: ThemeDef[] = [
  {
    description: "Graphite surfaces, amber ember accent. The default forge floor.",
    id: "forge",
    label: "Forge",
    signature: false,
  },
  {
    description: "Warm copper and terracotta. The furnace at full heat.",
    id: "ember",
    label: "Ember",
    signature: true,
  },
  {
    description: "Cool steel teal. The quench tank after the pour.",
    id: "quench",
    label: "Quench",
    signature: true,
  },
];

const THEME_KEY = `${BRANDING.slug}.theme`;
const SCHEME_KEY = `${BRANDING.slug}.scheme`;
const MOTION_KEY = `${BRANDING.slug}.motion`;

export interface ThemeState {
  motion: MotionPreference;
  scheme: Scheme;
  theme: ThemeId;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode / blocked storage: themes still apply for the session.
  }
}

export function loadThemeState(): ThemeState {
  const storedTheme = readStored(THEME_KEY);
  const storedScheme = readStored(SCHEME_KEY);
  const storedMotion = readStored(MOTION_KEY);
  const theme: ThemeId = THEMES.some((t) => t.id === storedTheme) ? (storedTheme as ThemeId) : "forge";
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const scheme: Scheme = storedScheme === "dark" || storedScheme === "light" ? storedScheme : prefersDark ? "dark" : "light";
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const motion: MotionPreference = storedMotion === "reduced" || storedMotion === "full" ? storedMotion : prefersReduced ? "reduced" : "full";
  return { motion, scheme, theme };
}

export function applyThemeState(state: ThemeState): void {
  const root = document.documentElement;
  root.dataset.theme = state.theme;
  root.dataset.scheme = state.scheme;
  root.dataset.motion = state.motion;
  root.style.colorScheme = state.scheme;
  writeStored(THEME_KEY, state.theme);
  writeStored(SCHEME_KEY, state.scheme);
  writeStored(MOTION_KEY, state.motion);
}

export function currentThemeState(): ThemeState {
  const root = document.documentElement;
  return {
    motion: root.dataset.motion === "reduced" ? "reduced" : "full",
    scheme: root.dataset.scheme === "light" ? "light" : "dark",
    theme: (root.dataset.theme as ThemeId) || "forge",
  };
}
