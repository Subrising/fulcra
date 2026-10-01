// Renders the real Command Centre surface (client/organization.tsx) in a browser page for verify-screens.mjs.
// The theme tokens are the Fulcra app's own (packages/app/src/styles/theme.ts, mapped by plugins/theme.ts):
// the default dark tint and the light palette.
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { View } from "react-native";
import { OrganizationSurface } from "../client/organization";
import { requested, refused } from "./fixtures.mjs";

const THEMES = {
  dark: { colors: { surface0: "#181B1A", surface1: "#1E2120", surface2: "#272A29", border: "#252B2A", foreground: "#fafafa", foregroundMuted: "#A1A5A4", accent: "#20744A", accentForeground: "#ffffff", statusSuccess: "#6cb17b", statusWarning: "#c09664", statusDanger: "#d8847b" } },
  light: { colors: { surface0: "#ffffff", surface1: "#fafafa", surface2: "#f4f4f5", border: "#e4e4e7", foreground: "#1a1a1e", foregroundMuted: "#71717a", accent: "#20744A", accentForeground: "#ffffff", statusSuccess: "#3e704a", statusWarning: "#7b5d39", statusDanger: "#9d433b" } },
};
const params = new URLSearchParams(location.search);
globalThis.__FIXTURE_MULTIHOST = params.get("multihost") === "1";
const theme = THEMES[params.get("scheme")] ?? THEMES.dark;
document.documentElement.style.background = document.body.style.background = theme.colors.surface0;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const openedChanges = [];
const navigation = { openAgent() {}, openWorkspace() {}, openArchitectureChange: input => openedChanges.push(input) };
window.__openedChanges = () => [...openedChanges];
const props = { navigation, theme, host: { id: "mini", label: "This Mac" }, layout: { compact: params.get("compact") === "1", platform: "web" } };
createRoot(document.getElementById("root")).render(
  React.createElement(QueryClientProvider, { client },
    React.createElement(View, { style: { height: "100vh", backgroundColor: theme.colors.surface0 } }, React.createElement(OrganizationSurface, props))));
window.__fixtureReads = () => ({ requested: [...requested], refused: [...refused] });
