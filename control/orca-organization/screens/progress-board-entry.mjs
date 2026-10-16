import React from "react";
import { createRoot } from "react-dom/client";
import { View } from "react-native";
import { PluginRpcProvider } from "../../../packages/plugin/src/client/rpc-context";
import { ProgressBoardSurface } from "../client/progress-board";
import { invokeHostRpc } from "./progress-board-runtime.mjs";
const params = new URLSearchParams(location.search);
const light = params.get("theme") === "light";
const colors = light
  ? {
      surface0: "#ffffff",
      surface1: "#fafafa",
      surface2: "#f4f4f5",
      border: "#e4e4e7",
      foreground: "#1a1a1e",
      foregroundMuted: "#62626b",
      accent: "#20744a",
      statusWarning: "#825013",
    }
  : {
      surface0: "#181b1a",
      surface1: "#1e2120",
      surface2: "#272a29",
      border: "#363c3a",
      foreground: "#fafafa",
      foregroundMuted: "#a1a5a4",
      accent: "#71cda0",
      statusWarning: "#efbb79",
    };
const props = {
  theme: { colors },
  host: { id: "mini", label: "Mac mini" },
  layout: { compact: innerWidth < 1100, platform: "web" },
  navigation: {
    openAgent(input) {
      window.boardOpened = input;
    },
  },
};
createRoot(document.getElementById("root")).render(
  React.createElement(
    PluginRpcProvider,
    { invoke: (method, input) => invokeHostRpc("mini", method, input) },
    React.createElement(
      View,
      { style: { height: "100vh" } },
      React.createElement(ProgressBoardSurface, props),
    ),
  ),
);
