import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as pluginClient from "@getpaseo/plugin/client";
import { EMPTY_NATIVE } from "./live-map-model";
import { freshness } from "./work-map-model";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { fleetRpc, type Fleet } from "../shared/fleet";
import { useContract } from "./use-contract";
import { Button } from "./organisation-ui";
import { OriginalConversation } from "./original-conversation";
import { WorkButton } from "./work-button";
import { StepThrough } from "./step-through";

// COMPAT(observedProjectWork): added in the next development build, remove after 2027-02-01 when the app floor includes cached native observation.
const nativeApi = pluginClient as Partial<Pick<typeof pluginClient, "useObservedAgents">>;
const nativeSupported = "useObservedAgents" in pluginClient;
const useNative = nativeApi.useObservedAgents ?? (() => EMPTY_NATIVE);

export function ProjectSessions({
  projectId,
  ...props
}: PluginSurfaceProps & { projectId: string }) {
  const read = useContract(fleetRpc),
    [offset, setOffset] = useState(0);
  const observed = useNative();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const [showSaved, setShowSaved] = useState(false);
  const [notice, setNotice] = useState("");
  const [selected, select] = useState<Fleet["nodes"][number] | null>(null);
  const q = useQuery({
    queryKey: ["orca-project-sessions", props.host?.id, projectId, offset],
    queryFn: () => read({ projectId, offset }),
    retry: false,
  });
  const all = q.data?.nodes ?? [];
  const current = nativeSupported
    ? all.filter((node) =>
        observed.entries.some(
          (entry) =>
            entry.serverId === node.serverId &&
            entry.agentId === node.agentId &&
            ["working", "permission", "error"].includes(entry.activity) &&
            freshness(entry.observedAt ?? undefined, now, false, false) === "live",
        ),
      )
    : [];
  const shown = showSaved ? all : current;
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
        Observed work and conversations
      </Text>
      <Text style={{ color: props.theme.colors.foregroundMuted }}>
        Current native activity is a cached observation; this controller page is bounded. History is
        read only when opened.
      </Text>
      <WorkButton
        theme={props.theme}
        label={
          showSaved
            ? "Show observed current work"
            : `Show saved conversations (${all.length} on this page)`
        }
        onPress={() => setShowSaved((value) => !value)}
      />
      {!showSaved && !current.length && q.data && (
        <Text style={{ color: props.theme.colors.foregroundMuted }}>
          No fresh active native work in this observed page. Saved conversations remain available
          below.
        </Text>
      )}
      {!q.data && (
        <Text style={{ color: props.theme.colors.foregroundMuted }}>
          {q.isPending ? "Reading sessions…" : "Sessions could not be read."}
        </Text>
      )}
      {!!notice && (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: props.theme.colors.foregroundMuted }}
        >
          {notice}
        </Text>
      )}
      {shown.map((n) => (
        <View
          key={`${n.serverId ?? "unknown"}:${n.id}`}
          style={{ gap: 6 }}
          testID={`org-session-${n.id}`}
        >
          <Text style={{ color: props.theme.colors.foreground }}>{n.title}</Text>
          <Text style={{ color: props.theme.colors.foregroundMuted }}>
            {n.host} · {n.status} (reported runtime) · {n.provider}
            {n.model ? ` / ${n.model}` : ""}
          </Text>
          <OriginalConversation
            {...props}
            targetHost={n.host}
            targetServerId={n.serverId}
            agentId={n.agentId}
            label={`Open conversation: ${n.title}`}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <WorkButton
              theme={props.theme}
              label={`Open Changes: ${n.title}`}
              disabled={!n.serverId || !n.agentId || !props.navigation?.openAgentChangesOnHost}
              onPress={() => {
                try {
                  const result = props.navigation!.openAgentChangesOnHost!({
                    serverId: n.serverId!,
                    agentId: n.agentId!,
                  });
                  setNotice(
                    result === "requested"
                      ? "Opening this conversation's native Changes…"
                      : "Changes are unavailable. Open the original conversation and reconnect its host, then retry.",
                  );
                } catch {
                  setNotice(
                    "Changes could not be opened. Use the original conversation's Changes control.",
                  );
                }
              }}
            />
            <WorkButton
              theme={props.theme}
              label={`Read activity history: ${n.title}`}
              onPress={() => select(n)}
            />
          </View>
        </View>
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
