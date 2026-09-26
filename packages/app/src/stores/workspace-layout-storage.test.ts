import { describe, expect, it } from "vitest";
import { WorkspaceLayoutPersistedStateSchema } from "./workspace-layout-storage";

function layoutWithTab(target: unknown) {
  return {
    layoutByWorkspace: {
      "srv:ws": {
        root: {
          kind: "pane",
          pane: {
            id: "main",
            tabIds: ["t1"],
            focusedTabId: "t1",
            tabs: [{ tabId: "t1", target, createdAt: 1 }],
          },
        },
        focusedPaneId: "main",
      },
    },
  };
}

describe("workspace layout persistence", () => {
  it("keeps an architecture map tab across restarts", () => {
    const parsed = WorkspaceLayoutPersistedStateSchema.safeParse(
      layoutWithTab({ kind: "architecture_map" }),
    );
    expect(parsed.success).toBe(true);
  });

  it("does not persist a path or any other field on the architecture map tab", () => {
    const parsed = WorkspaceLayoutPersistedStateSchema.safeParse(
      layoutWithTab({ kind: "architecture_map", path: "../../etc/passwd" }),
    );
    expect(parsed.success).toBe(false);
  });
});
