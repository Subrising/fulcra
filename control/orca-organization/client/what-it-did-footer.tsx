// The folded "What it did" line under each completed turn in the chat (the app's turn-footer seam). The chat's working
// folder comes from the plugin's client state so file paths read project-relative, as in the step-through.
import { useAgent, type PluginTurnFooterProps } from "@getpaseo/plugin/client";
import { WhatItDidFooterView } from "./what-it-did-card";

export function WhatItDidTurnFooter({ agentId, turn, theme }: PluginTurnFooterProps) {
  const cwd = useAgent(agentId, (agent) => agent.cwd);
  return (
    <WhatItDidFooterView
      toolCalls={turn.toolCalls}
      durationMs={turn.durationMs}
      cwd={cwd}
      theme={theme}
    />
  );
}
