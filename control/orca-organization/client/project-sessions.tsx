import { useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { fleetRpc, type Fleet } from "../shared/fleet";
import { useContract } from "./use-contract";
import { Button } from "./organisation-ui";
import { StepThrough } from "./step-through";

export function ProjectSessions({
  projectId,
  ...props
}: PluginSurfaceProps & { projectId: string }) {
  const read = useContract(fleetRpc),
    [offset, setOffset] = useState(0);
  const [selected, select] = useState<Fleet["nodes"][number] | null>(null);
  const q = useQuery({
    queryKey: ["orca-project-sessions", props.host?.id, projectId, offset],
    queryFn: () => read({ projectId, offset }),
    retry: false,
  });
  if (selected)
    return (
      <StepThrough
        {...props}
        sessionId={selected.id}
        taskId={selected.task}
        provider={selected.provider}
        title={selected.title}
        onClose={() => select(null)}
      />
    );
  return (
    <View testID="org-project-sessions" style={{ gap: 8 }}>
      <Text
        accessibilityRole="header"
        style={{ color: props.theme.colors.foreground, fontWeight: "600" }}
      >
        Sessions
      </Text>
      {!q.data && (
        <Text style={{ color: props.theme.colors.foregroundMuted }}>
          {q.isPending ? "Reading sessions…" : "Sessions could not be read."}
        </Text>
      )}
      {q.data?.nodes.map((n) => (
        <Button
          key={n.id}
          theme={props.theme}
          testID={`org-session-${n.id}`}
          label={`Step through ${n.title}`}
          onPress={() => select(n)}
        >
          <Text style={{ color: props.theme.colors.foreground }}>{n.title} · Step through</Text>
        </Button>
      ))}
      {q.data && !q.data.nodes.length && (
        <Text style={{ color: props.theme.colors.foregroundMuted }}>
          {q.data.partial
            ? "The session list is incomplete; try again shortly."
            : "No sessions recorded."}
        </Text>
      )}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {offset > 0 && (
          <Button
            theme={props.theme}
            label="Previous sessions"
            onPress={() => setOffset(Math.max(0, offset - 64))}
          >
            <Text style={{ color: props.theme.colors.foreground }}>Previous</Text>
          </Button>
        )}
        {q.data?.nextOffset != null && (
          <Button
            theme={props.theme}
            label="Next sessions"
            onPress={() => setOffset(q.data!.nextOffset!)}
          >
            <Text style={{ color: props.theme.colors.foreground }}>Next</Text>
          </Button>
        )}
      </View>
    </View>
  );
}
