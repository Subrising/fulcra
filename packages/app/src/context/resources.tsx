import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { useContextRead } from "./read-scope";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

interface ResourceProps {
  serverId: string;
  workspaceId: string;
  active: boolean;
  onOpenTarget: (target: WorkspaceTabTarget) => void;
}
export function ContextProviderChildren(props: ResourceProps & { agentId: string }) {
  const client = useHostRuntimeClient(props.serverId);
  const nativeInstance = useSessionStore(
    (state) => state.sessions[props.serverId]?.agents.get(props.agentId)?.runtimeInstanceId,
  );
  if (client?.getLastServerInfoMessage()?.features?.providerSubagents !== true)
    return <Text style={styles.detail}>Update the host to view provider-owned subagents.</Text>;
  if (!nativeInstance)
    return <Text style={styles.detail}>Provider-owned subagent runtime identity unavailable</Text>;
  return <ProviderChildren {...props} />;
}
function ProviderChildren({
  serverId,
  workspaceId,
  agentId,
  active,
  onOpenTarget,
}: ResourceProps & { agentId: string }) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const read = useCallback(
    async (client: DaemonClient) => {
      const response = await client.listProviderSubagents(agentId);
      if (response.parentAgentId !== agentId) throw new Error("Subagent scope unavailable");
      return response.subagents.filter((row) => row.parentAgentId === agentId);
    },
    [agentId],
  );
  const result = useContextRead({ serverId, workspaceId, agentId, active, revision, read });
  const client = useHostRuntimeClient(serverId);
  const timeline = client?.getLastServerInfoMessage()?.features?.projectedSubagentTimeline === true;
  return (
    <View style={styles.group}>
      <Text style={styles.detail}>Provider-owned subagents · accounts unavailable</Text>
      {result.status === "loaded" ? (
        <>
          {result.data.length === 0 ? (
            <Text style={styles.detail}>No observed provider-owned subagents</Text>
          ) : null}
          {result.data.slice(0, 40).map((row) => (
            <View key={row.id}>
              <Text style={styles.detail}>
                {row.title ?? row.id} · {row.provider} · {row.status}
              </Text>
              {timeline ? (
                <ProviderChildButton
                  parentAgentId={agentId}
                  subagentId={row.id}
                  onOpenTarget={onOpenTarget}
                />
              ) : (
                <Text style={styles.detail}>Conversation unavailable on this host</Text>
              )}
            </View>
          ))}
          {result.data.length > 40 ? (
            <Text style={styles.detail}>Showing the first 40 provider-owned subagents</Text>
          ) : null}
        </>
      ) : (
        <Text style={styles.detail}>
          {result.status === "error"
            ? "Provider-owned subagents unavailable"
            : "Loading provider-owned subagents…"}
        </Text>
      )}
      <Button variant="ghost" onPress={refresh}>
        Refresh provider-owned subagents
      </Button>
    </View>
  );
}
function ProviderChildButton({
  parentAgentId,
  subagentId,
  onOpenTarget,
}: Pick<ResourceProps, "onOpenTarget"> & { parentAgentId: string; subagentId: string }) {
  const open = useCallback(
    () => onOpenTarget({ kind: "provider_subagent", parentAgentId, subagentId }),
    [onOpenTarget, parentAgentId, subagentId],
  );
  return (
    <Button variant="ghost" size="sm" onPress={open}>
      Open provider-owned conversation
    </Button>
  );
}

/** Explicit browsing only; filenames never classify artifacts or produced output. */
export function ContextContainedFiles(props: ResourceProps) {
  const client = useHostRuntimeClient(props.serverId);
  const [browse, setBrowse] = useState(false);
  const start = useCallback(() => setBrowse(true), []);
  if (client?.getLastServerInfoMessage()?.features?.containedFileIndex !== true)
    return <Text style={styles.detail}>Contained file index unavailable on this host</Text>;
  return browse ? (
    <ContainedFiles {...props} />
  ) : (
    <Button variant="ghost" onPress={start}>
      Browse contained workspace file index
    </Button>
  );
}
function ContainedFiles({ serverId, workspaceId, active, onOpenTarget }: ResourceProps) {
  const [path, setPath] = useState("");
  const [revision, setRevision] = useState(0);
  const reset = useCallback(() => setPath(""), []);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const read = useCallback(
    (client: DaemonClient, cwd: string) => client.listDirectory(cwd, path),
    [path],
  );
  const result = useContextRead({
    serverId,
    workspaceId,
    active,
    revision: JSON.stringify([path, revision]),
    read,
  });
  return (
    <View style={styles.group}>
      <Text style={styles.detail}>Files — workspace · {path || "root"}</Text>
      <Text style={styles.detail}>
        Host-contained index. File names do not identify produced artifacts.
      </Text>
      {result.status === "loaded" ? (
        <>
          {result.data.entries.slice(0, 40).map((entry) => (
            <ContainedEntry
              key={entry.path}
              path={entry.path}
              name={entry.name}
              directory={entry.kind === "directory"}
              onDirectory={setPath}
              onOpenTarget={onOpenTarget}
            />
          ))}
          {result.data.entries.length === 0 ? (
            <Text style={styles.detail}>No indexed entries</Text>
          ) : null}
          {result.data.entries.length > 40 ? (
            <Text style={styles.detail}>
              Showing the first 40 indexed entries; use workspace Files for the full directory.
            </Text>
          ) : null}
        </>
      ) : (
        <Text style={styles.detail}>
          {result.status === "error"
            ? "Contained file index unavailable"
            : "Loading contained file index…"}
        </Text>
      )}
      <Button variant="ghost" onPress={reset}>
        Workspace root
      </Button>
      <Button variant="ghost" onPress={refresh}>
        Refresh file index
      </Button>
    </View>
  );
}
function ContainedEntry({
  path,
  name,
  directory,
  onDirectory,
  onOpenTarget,
}: {
  path: string;
  name: string;
  directory: boolean;
  onDirectory: (path: string) => void;
  onOpenTarget: ResourceProps["onOpenTarget"];
}) {
  const open = useCallback(() => {
    if (directory) onDirectory(path);
    else onOpenTarget({ kind: "file", path });
  }, [directory, onDirectory, onOpenTarget, path]);
  return (
    <Button variant="ghost" size="sm" onPress={open}>
      {directory ? "Directory: " : "File: "}
      {name}
    </Button>
  );
}
const styles = StyleSheet.create((theme) => ({
  group: { gap: theme.spacing[2] },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
