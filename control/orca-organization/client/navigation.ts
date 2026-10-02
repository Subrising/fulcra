import type { PluginClientContext } from "@getpaseo/plugin/client";
type Client = Partial<Pick<PluginClientContext, "addCommandCenterItem" | "openSurface">>;
export function registerReturnCommands(client: Client) {
  if (typeof client.addCommandCenterItem !== "function" || typeof client.openSurface !== "function")
    return () => {};
  const remove = (["global", "agent"] as const).map((context) =>
    client.addCommandCenterItem!({
      id: `return-orca-${context}`,
      context,
      title: "Return to Fulcra",
      icon: "Network",
      keywords: ["organization", "tasks", "back"],
      onSelect: (capabilities: Pick<PluginClientContext, "openSurface">) =>
        capabilities.openSurface("organization"),
    }),
  );
  return () => remove.forEach((dispose) => dispose());
}
