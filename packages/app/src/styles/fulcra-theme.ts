// Fulcra brand themes (FU-401): the app wears the same warm, dark, coral look as the website.
// Values and contrast ratios: FU-401 FINAL-BRIEF section 4 and TOKENS-DRAFT.
//
// This file holds data only and imports only TYPES from theme.ts. theme.ts calls the builders
// with these tints and spreads the overrides over the result. A runtime import in the other
// direction would be a cycle (theme.ts constants are not ready when this file would load).
import type { DarkThemeConfig, LightThemeConfig } from "./theme";

export const FULCRA_BRAND = {
  coral: "#ff8a5b",
  coralBright: "#ffb08f",
  coralDeep: "#a83c1a",
  coralDeepHover: "#8f3213",
  burgundy: "#5e1623",
  burgundyDeep: "#431521",
  ink: "#f5efe6",
  night: "#121112",
  paper: "#fbf7ef",
} as const;

// Coral is the one accent. It appears only on: primary fill, active nav label and 3px bar,
// focus ring, unread badge, eyebrow, links. Never on status, success, diff or terminal.
export const FULCRA_DARK_TINT: DarkThemeConfig = {
  surface0: "#121112",
  surface1: "#1b1a1b",
  surface2: "#1d1b1c",
  surface3: "#2a2726",
  surface4: "#3b3735",
  surfaceDiffEmpty: "#1b1a1b",
  surfaceSidebar: "#0e0d0e",
  foreground: "#f5efe6",
  foregroundMuted: "#b9b0a6",
  foregroundExtraMuted: "#8f857d",
  border: "rgba(242, 231, 213, 0.10)",
  borderAccent: "rgba(242, 231, 213, 0.16)",
  accent: FULCRA_BRAND.coral,
  accentBright: FULCRA_BRAND.coralBright,
  accentForeground: "#121112",
  destructive: "#f0505a",
  terminalBlack: "#0e0d0e",
  terminalBrightBlack: "#3b3735",
  ring: FULCRA_BRAND.coral,
};

// The dark builder sets success = accent and primary = foreground. Brand overrides:
export const FULCRA_DARK_OVERRIDES = {
  success: "#6cb17b",
  successForeground: "#121112",
  primary: FULCRA_BRAND.coral,
  primaryForeground: "#121112",
  destructiveForeground: "#121112",
  statusDanger: "#f0505a",
  // Selected row: warm neutral surface3 (plus the accent bar), hover one step quieter.
  surfaceSidebarHover: "#1d1b1c",
  surfaceSidebarSelected: "#2a2726",
  // User chat bubble: burgundy, a brand moment that echoes the website hero (D3).
  userBubble: FULCRA_BRAND.burgundyDeep,
  userBubbleForeground: FULCRA_BRAND.ink,
  interactionHighlight: "rgba(242, 231, 213, 0.08)",
} as const;

export const FULCRA_DARK_TERMINAL_SELECTION = "rgba(255, 138, 91, 0.28)";

// Light is a designed variant: warm paper, never white, never cold grey.
export const FULCRA_LIGHT_TINT: LightThemeConfig = {
  surface0: "#fbf7ef",
  surface1: "#f6efe2",
  surface2: "#f2e7d5",
  surface3: "#e6d9c3",
  surface4: "#d6c7ae",
  surfaceDiffEmpty: "#f6efe2",
  surfaceSidebar: "#f2e7d5",
  foreground: "#1d1416",
  foregroundMuted: "#5f5249",
  foregroundExtraMuted: "#6f6258",
  border: "#e1d3c0",
  borderAccent: "#c9b89f",
  accent: FULCRA_BRAND.coralDeep,
  accentBright: FULCRA_BRAND.coralDeepHover,
  accentForeground: "#fbf7ef",
  primary: FULCRA_BRAND.coralDeep,
  primaryForeground: "#fbf7ef",
  destructive: "#b3202f",
  terminalBlack: "#1d1416",
  terminalBrightBlack: "#5f5249",
  ring: FULCRA_BRAND.coralDeep,
};

// The light builder also sets success = accent. Success stays green.
export const FULCRA_LIGHT_OVERRIDES = {
  success: "#3e704a",
  successForeground: "#fbf7ef",
  destructiveForeground: "#fbf7ef",
  statusDanger: "#b3202f",
  surfaceSidebarHover: "#e6d9c3",
  surfaceSidebarSelected: "#e6d9c3",
  userBubble: FULCRA_BRAND.burgundy,
  userBubbleForeground: FULCRA_BRAND.paper,
  interactionHighlight: "rgba(67, 21, 33, 0.06)",
} as const;

export const FULCRA_LIGHT_TERMINAL_SELECTION = "rgba(168, 60, 26, 0.18)";

export const FULCRA_ICON_STROKE_WIDTH = 1.75;

interface WithTerminal {
  terminal: { selectionBackground: string };
}

export function withFulcraDark<T extends WithTerminal>(colors: T): T {
  return {
    ...colors,
    ...FULCRA_DARK_OVERRIDES,
    terminal: { ...colors.terminal, selectionBackground: FULCRA_DARK_TERMINAL_SELECTION },
  };
}

export function withFulcraLight<T extends WithTerminal>(colors: T): T {
  return {
    ...colors,
    ...FULCRA_LIGHT_OVERRIDES,
    terminal: { ...colors.terminal, selectionBackground: FULCRA_LIGHT_TERMINAL_SELECTION },
  };
}
