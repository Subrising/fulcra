// Renders the real Fulcra › Today surface (client/today.tsx, with the G1 LaunchPad) for verify-launchpad-screens.mjs,
// over fictional fixtures, under a visible "Fixtures" label that belongs to this harness, not to the product.
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { TodaySurface } from "../client/today";
import { requested, refused } from "./launchpad-fixtures.mjs";

const THEMES = {
  dark: {
    colors: {
      surface0: "#181B1A",
      surface1: "#1E2120",
      surface2: "#272A29",
      border: "#252B2A",
      foreground: "#fafafa",
      foregroundMuted: "#A1A5A4",
      accent: "#20744A",
      accentForeground: "#ffffff",
      statusSuccess: "#6cb17b",
      statusWarning: "#c09664",
      statusDanger: "#d8847b",
    },
  },
  light: {
    colors: {
      surface0: "#ffffff",
      surface1: "#fafafa",
      surface2: "#f4f4f5",
      border: "#e4e4e7",
      foreground: "#1a1a1e",
      foregroundMuted: "#71717a",
      accent: "#20744A",
      accentForeground: "#ffffff",
      statusSuccess: "#3e704a",
      statusWarning: "#7b5d39",
      statusDanger: "#9d433b",
    },
  },
};
const params = new URLSearchParams(location.search);
const theme = THEMES[params.get("scheme")] ?? THEMES.dark,
  compact = params.get("compact") === "1";
document.documentElement.style.background = document.body.style.background = theme.colors.surface0;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const opened = [];
window.__opened = () => [...opened];
const go = { inbox() {}, project() {}, recovery() {} };
const props = {
  theme,
  host: { id: "fixture-host", label: "This Mac" },
  layout: { compact, platform: "web" },
  navigation: { openAgent: ({ agentId }) => opened.push(agentId) },
  go,
};
createRoot(document.getElementById("root")).render(
  React.createElement(
    QueryClientProvider,
    { client },
    React.createElement(
      View,
      { style: { minHeight: "100vh", backgroundColor: theme.colors.surface0 } },
      React.createElement(
        View,
        {
          testID: "fixture-label",
          style: { paddingVertical: 6, paddingHorizontal: 12, backgroundColor: "#6b3fa0" },
        },
        React.createElement(
          Text,
          { style: { color: "#ffffff", fontWeight: "700", fontSize: 12, letterSpacing: 0.4 } },
          "FIXTURES: FICTIONAL DATA (component render, not a running app)",
        ),
      ),
      React.createElement(TodaySurface, props),
    ),
  ),
);
window.__fixtureReads = () => ({ requested: [...requested], refused: [...refused] });
