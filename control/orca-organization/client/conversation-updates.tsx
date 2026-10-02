import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { WorkMessage } from "../shared/work-messages.mjs";
import { WorkButton } from "./work-button";
import { readableUpdate } from "./readable-update";

function Update({
  message,
  theme,
  references,
}: { message: WorkMessage; references?: ReadonlyMap<string, string> } & Pick<
  PluginSurfaceProps,
  "theme"
>) {
  const [expanded, setExpanded] = useState(false),
    [original, setOriginal] = useState(false),
    c = theme.colors;
  const readable = readableUpdate(message.text, references),
    text = original
      ? message.text
      : readable ||
        "This message contains a technical marker. Open the original text to inspect it.";
  const shortened = !expanded && text.length > 280;
  const excerpt = shortened ? Array.from(text).slice(0, 280).join("") + "…" : text;
  return (
    <View
      style={{
        gap: 8,
        padding: 16,
        borderRadius: 14,
        backgroundColor: c.surface1 ?? c.surface0,
        borderWidth: 1,
        borderColor: c.border,
      }}
    >
      <Text style={{ color: c.foregroundMuted, fontWeight: "600" }}>
        {message.role === "agent" ? "Agent update" : "Instruction"}
      </Text>
      <Text selectable style={{ color: c.foreground, fontSize: 16, lineHeight: 24 }}>
        {excerpt}
      </Text>
      {text.length > 280 && (
        <WorkButton
          theme={theme}
          label={expanded ? "Collapse update" : "Read more of this update"}
          expanded={expanded}
          onPress={() => setExpanded(!expanded)}
        />
      )}
      {readable !== message.text && (
        <WorkButton
          theme={theme}
          label={original ? "Hide original text" : "Show original text"}
          expanded={original}
          onPress={() => setOriginal(!original)}
        />
      )}
      {!shortened && message.truncated && (
        <Text style={{ color: c.foregroundMuted }}>
          Excerpt ends here. Open the original conversation for the full message.
        </Text>
      )}
    </View>
  );
}
export function ConversationUpdates({
  messages,
  historical,
  stale,
  theme,
  references,
}: Pick<PluginSurfaceProps, "theme"> & {
  messages?: WorkMessage[];
  references?: ReadonlyMap<string, string>;
  historical: boolean;
  stale: boolean;
}) {
  const c = theme.colors,
    [instructions, setInstructions] = useState(false),
    visible = messages?.filter((m) => instructions || m.role === "agent");
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "600" }}>
        {historical ? "Earlier conversation updates" : "Latest conversation updates"}
      </Text>
      <Text style={{ color: c.foregroundMuted }}>
        {stale ? "Connection lost · last saved excerpts. " : ""}Actual messages, newest first. Agent
        reports still need review. Technical identifiers are hidden in this view.
      </Text>
      {messages === undefined ? (
        <Text style={{ color: c.foreground }}>
          Message excerpts are unavailable. Open the original conversation to read the work.
        </Text>
      ) : !visible?.length ? (
        <Text style={{ color: c.foreground }}>
          No agent updates on this page. Show instructions, try older activity or open the original
          conversation.
        </Text>
      ) : (
        visible
          .slice()
          .toReversed()
          .map((m) => <Update key={m.id} message={m} theme={theme} references={references} />)
      )}
      {!!messages?.some((m) => m.role === "instruction") && (
        <WorkButton
          theme={theme}
          label={instructions ? "Hide instructions" : "Show instructions"}
          expanded={instructions}
          onPress={() => setInstructions(!instructions)}
        />
      )}
    </View>
  );
}
