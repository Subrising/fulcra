import { useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";
import { selectWorkspace } from "@/stores/session-store-hooks/selectors";
import { createPluginAgentActionContext, createPluginWorkspaceActionContext } from "../actions";
import { createPluginClientStateSource } from "../client-state/source";
import { createPluginNavigation } from "../navigation";
import { useInstalledPlugins } from "../registry";

export interface PluginClientSlashCommand {
  pluginId: string;
  name: string;
  description: string;
  argumentHint: string;
  run(args: string): Promise<void>;
}

export function usePluginClientSlashCommands(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  agentId: string;
}): PluginClientSlashCommand[] {
  const installed = useInstalledPlugins();
  // The commands are built from the chat and workspace records. Those arrive after the first render, so the lists
  // must follow the store: a list built before they arrived used to stay empty ("/account is unavailable").
  const hasWorkspace = useSessionStore((store) =>
    Boolean(selectWorkspace(store, input.serverId, input.workspaceId ?? null)),
  );
  const hasAgent = useSessionStore((store) => {
    const session = store.sessions[input.serverId];
    return Boolean(session?.agents.get(input.agentId) ?? session?.agentDetails.get(input.agentId));
  });
  return useMemo(() => {
    if (!input.workspaceId) return [];
    const workspaceId = input.workspaceId;
    const state = createPluginClientStateSource(input.serverId);
    const navigation = createPluginNavigation({
      serverId: input.serverId,
      workspaceId,
    });
    const commands = installed
      .filter((plugin) => plugin.serverId === input.serverId)
      .flatMap((plugin) =>
        plugin.clientSlashCommands.flatMap((contribution) => {
          if (contribution.context === "agent" && (!hasAgent || !state.getAgent(input.agentId)))
            return [];
          if (!hasWorkspace || !state.getWorkspace(workspaceId)) return [];
          return [
            {
              pluginId: plugin.id,
              name: contribution.name,
              description: contribution.description,
              argumentHint: contribution.argumentHint,
              async run(args: string) {
                const context =
                  contribution.context === "agent"
                    ? createPluginAgentActionContext({
                        plugin,
                        navigation,
                        state,
                        workspaceId,
                        agentId: input.agentId,
                      })
                    : createPluginWorkspaceActionContext({
                        plugin,
                        navigation,
                        state,
                        workspaceId,
                      });
                if (contribution.context === "agent" && context?.context === "agent")
                  await contribution.onSubmit({ ...context, args });
                else if (contribution.context === "workspace" && context?.context === "workspace")
                  await contribution.onSubmit({ ...context, args });
              },
            },
          ];
        }),
      );
    return commands;
  }, [input.agentId, input.serverId, input.workspaceId, installed, hasWorkspace, hasAgent]);
}
