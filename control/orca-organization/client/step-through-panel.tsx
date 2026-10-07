// J6: the step-through beside a conversation, as an agent panel. On this Mac a Fulcra session id is the agent id,
// so the panel replays the conversation it is opened from; a conversation outside Fulcra work says so in words.
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "react-native";
import { StepThrough } from "./step-through";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function AgentStepThroughPanel(props: PluginAgentPanelProps) {
  const c = props.theme.colors;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: 16, gap: 16 }}
    >
      {UUID.test(props.agentId) && (
        <StepThrough
          sessionId={props.agentId.toLowerCase()}
          theme={props.theme}
          layout={{ ...props.layout, compact: true }}
          host={props.host}
          startAtLatest
        />
      )}
    </ScrollView>
  );
}
