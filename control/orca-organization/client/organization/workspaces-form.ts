import type { SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import type { WorkspaceUmbrella } from "../../shared/workspace-organization";
type Prime = WorkspaceUmbrella["prime"];
export function openWorkspacesForm() {
  let state = {
    name: "",
    companyName: "",
    projectSearch: "",
    parentId: "",
    prime: null as Prime,
    primeLabel: "No intake prime",
    titles: {} as Record<string, string>,
    busy: false,
    notice: "",
  };
  let input: SettingsInputHandle | null = null;
  let closed = false;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof state>) => {
    if (
      closed ||
      Object.entries(patch).every(([key, value]) => state[key as keyof typeof state] === value)
    )
      return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closed = true;
      listeners.clear();
    },
    setNameInput: (handle: SettingsInputHandle | null) => {
      input = handle;
    },
    clearName: () => {
      input?.replaceText("");
      publish({ name: "" });
    },
    setName: (name: string) => publish({ name }),
    setCompanyName: (companyName: string) => publish({ companyName }),
    setProjectSearch: (projectSearch: string) => publish({ projectSearch }),
    setParent: (parentId: string) => publish({ parentId }),
    setNotice: (notice: string) => publish({ notice }),
    setPrime: (prime: Prime, primeLabel: string) => publish({ prime, primeLabel }),
    setTitle: (key: string, title: string) =>
      publish({ titles: { ...state.titles, [key]: title } }),
    run: async (action: () => Promise<unknown>) => {
      if (closed || state.busy) return;
      publish({ busy: true, notice: "" });
      try {
        await action();
      } catch (error) {
        publish({
          notice: error instanceof Error ? error.message : "Organization update unavailable",
        });
      } finally {
        publish({ busy: false });
      }
    },
  };
}
