import { mount, jsx } from "./dom.mjs";
import { CleanupSurface } from "../../client/worktree-lifecycle";
const params = new URLSearchParams(location.search),
  dark = params.get("theme") === "dark";
const colors = dark
  ? {
      surface0: "#181b1a",
      foreground: "#fafafa",
      foregroundMuted: "#a1a5a4",
      border: "#404745",
      accent: "#20744a",
      accentForeground: "#fff",
    }
  : {
      surface0: "#fff",
      foreground: "#1a1a1e",
      foregroundMuted: "#65656d",
      border: "#dedee2",
      accent: "#20744a",
      accentForeground: "#fff",
    };
window.__calls = [];
mount(() =>
  jsx(CleanupSurface, {
    theme: { colors },
    layout: { compact: innerWidth < 600, platform: "web" },
  }),
);
window.__ready = true;
