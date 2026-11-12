# Design — Brief, System, and Surface Comparison

## Design brief

**Audience.** Solo founders and indie hackers who self-host on a small
VPS and build SaaS apps with an AI assistant they already pay for. They
want to see what the AI built, inspect it, lock it down, and ship it —
without learning a new platform's mental model.

**References (structure and feel only — never copied values, assets,
or copy).**

- **Appwrite Console** — dense, professional BaaS admin: left nav,
  resource tables, API-key management, usage. The bar for the Data and
  Security surfaces.
- **Puter Builder** — split-screen build flow: prompt/chat on one side,
  live preview on the other, click-to-edit. The bar for the Studio
  surface.

**The bar, in plain words.** The Studio must feel like a workshop, not
a dashboard: the app being built is the hero, controls stay quiet until
needed, and security state is visible at a glance instead of buried in
settings. Every surface must be usable by keyboard, legible in both
schemes, and honest about what it cannot do.

## Design system

- **One tokens file:** `apps/web/src/styles.css`. Primitive ramps
  (slate/amber/copper/teal + status) are defined once; semantic tokens
  (surfaces, text, borders, accents, focus) map from them per
  theme × scheme. Components use only `var(--...)` tokens — no
  hard-coded product colours in components.
- **Three themes, each dark + light, persisted:** Forge (default,
  graphite + amber), Ember (signature, warm copper), Quench (signature,
  cool steel teal). Scheme defaults to the OS setting; motion defaults
  to the OS reduced-motion setting and can be overridden.
- **Glass used sparingly:** only modal overlays dim the page; content
  surfaces are solid and legible.
- **Showcase page:** `#/showcase` renders every component, the theme
  switcher, token swatches, type scale, avatar states, and loading /
  empty / error states live.
- **States designed for every component:** loading, empty, error,
  offline (banner), hover, focus-visible, disabled, reduced motion.
- **Avatars:** the Forge crew — Ember (Builder), Anvil (Guardian),
  Quench (Tester), Bellows (Deployer). Original parametric SVG art:
  distinct silhouettes, hues, accessories, traits, and greetings; six
  expressions (idle, thinking, working, blocked, done, error); a look
  editor with role presets; avatar packs are JSON data only. The crew
  shares nothing with any reference product's mascot.

## Surface-by-surface comparison

Honest ratings against the references. "Beat" means this surface does
something the reference does not, or does it more directly for this
audience. Surfaces were walked over HTTP + built-asset inspection on
2026-11-12; no live browser walk was possible in this environment (see
`VERIFICATION.md`), so visual polish claims are deliberately modest.

| Surface | vs Appwrite Console | vs Puter Builder | Notes |
|---|---|---|---|
| App list / home | Match | — | Search + cards + create. Console has project usage charts; this has none. **Fall short** on usage visualization. |
| Studio split-screen | — | Match | Files + editor + preview + inspector. Builder's AI chat panel is absent here (MCP is the AI surface). **Fall short** on in-Studio chat. |
| Click-to-select inspection | — | Beat | Element path/classes/rect, live text edit, save-back to file, copy-context-for-AI. Builder's click-to-edit is the model; the explicit save-back + AI-context copy go one step further. |
| Schema inspector | Match | — | Collections, attributes, typed record forms. Console has richer attribute types and relationships; **fall short** on relationships. |
| Security-profile matrix | Beat | — | No equivalent matrix in the Console's permission UI: profiles × tables × operations with rule detail in one view, plus a JSON rule editor. This is the product's signature surface. |
| API-key manager | Match | — | Scopes, profiles, one-time plaintext, revoke. Matches Console behaviour. |
| Functions | Fall short | — | Create/invoke/delete works, but there is no execution history, logs view, or schedule triggers. |
| Billing | Fall short | — | Plans + subscriptions + usage totals, but no charts, no customer list, no invoice view. |
| Webhooks | Match | — | Endpoints, events, signed delivery, retries, delivery log. Matches the integration story. |
| Deploy / domains / GitHub / eject | Beat | Match | Staging→production promotion + generated Caddyfile + 2-way GitHub sync + one-click eject in one tab. Eject has no equivalent in either reference. |
| Audit log | Match | — | Action/actor/detail table. Matches Console auditing. |
| Themes / appearance | Beat | Beat | Three signature themes × dark/light + persisted motion preference + live showcase. Neither reference ships this depth of theming in the studied surfaces. |
| Avatars / characters | Beat | Beat | Neither reference has a parametric avatar crew with expressions and a look editor. Original art only. |
| Accessibility | Match | Match | Keyboard navigation, visible focus, labelled icon controls, live regions for toasts, reduced-motion support. Contrast checked on tokens (see below). |

## Accessibility checks

- **Keyboard:** all actions are buttons/links/inputs reachable by Tab;
  modals trap focus and close on Escape; the file tree uses listbox
  semantics.
- **Focus:** `:focus-visible` rings use the theme focus token on every
  interactive element.
- **Labels:** icon-only controls carry `title`/`aria-label`; form
  fields have associated labels; the preview iframe has a title.
- **Contrast (tokens):** body text vs surface exceeds 7:1 in all six
  theme/scheme combinations (near-white on near-black in dark schemes;
  near-black on white in light schemes). Muted text exceeds 4.5:1.
  Accent-on-accent button text uses a dark ink on bright accent (dark
  schemes) and white on a darkened accent (light schemes), both above
  4.5:1. These are computed from the token values, not measured in a
  browser — a live contrast audit is a follow-up.
- **Reduced motion:** `prefers-reduced-motion` and the in-app override
  collapse animations/transitions to near-zero duration.

## Known design gaps (follow-ups)

1. No usage charts (Console parity for the home/billing surfaces).
2. No relationships in the schema inspector.
3. No function execution history / log viewer.
4. No in-Studio AI chat panel (by design — MCP is the AI surface — but
   a chat that calls the MCP server from the Studio is a plausible
   follow-up).
5. Visual polish (spacing rhythm, empty-state illustration, preview
   device frames) was not verified in a live browser here; a browser
   walk is required before any "best-in-class" claim.
