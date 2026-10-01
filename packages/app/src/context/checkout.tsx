import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import Svg, { Circle, Line } from "react-native-svg";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { buildCommitTopology } from "@/git/commit-topology";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { useContextObservation } from "./observation";

interface CheckoutContextProps {
  serverId: string;
  workspaceId: string;
  active: boolean;
  onOpenTarget: (target: WorkspaceTabTarget) => void;
}
// The parent remounts on permission/client/selected-runtime changes. These reads
// use only local observation state, never a shared checkout query cache.
export function ContextCheckout(props: CheckoutContextProps) {
  const client = useHostRuntimeClient(props.serverId);
  const features = client?.getLastServerInfoMessage()?.features;
  return (
    <>
      {features?.commitTopology === true ? (
        <ContextCommitGraph {...props} />
      ) : (
        <Text style={styles.detail}>Update the host to view commit topology.</Text>
      )}
      {features?.stashApplyBySha === true ? (
        <ContextStashes {...props} />
      ) : (
        <Text style={styles.detail}>Update the host to view and apply retained stashes.</Text>
      )}
    </>
  );
}

function useCheckoutScope(serverId: string, workspaceId: string) {
  const client = useHostRuntimeClient(serverId);
  const session = useSessionStore((state) => state.sessions[serverId]);
  const cwd = session?.workspaces.get(workspaceId)?.workspaceDirectory ?? "";
  const generation = session?.clientGeneration;
  const admittedPermissions = JSON.stringify(
    client?.getLastServerInfoMessage()?.permissions ?? null,
  );
  const current = useCallback(() => {
    const now = useSessionStore.getState().sessions[serverId];
    return Boolean(
      client?.isConnected &&
      now?.client === client &&
      now.clientGeneration === generation &&
      now.workspaces.get(workspaceId)?.workspaceDirectory === cwd &&
      client.getLastServerInfoMessage()?.permissions?.includes("workspace.read") &&
      JSON.stringify(client.getLastServerInfoMessage()?.permissions ?? null) ===
        admittedPermissions,
    );
  }, [admittedPermissions, client, cwd, generation, serverId, workspaceId]);
  return {
    client,
    cwd,
    current,
    key: JSON.stringify([serverId, workspaceId, cwd, generation, admittedPermissions]),
  };
}

function ContextCommitGraph({ serverId, workspaceId, active, onOpenTarget }: CheckoutContextProps) {
  const { client, cwd, current, key } = useCheckoutScope(serverId, workspaceId);
  const [refresh, setRefresh] = useState(0);
  const refreshRows = useCallback(() => setRefresh((value) => value + 1), []);
  const observe = useCallback(
    (
      publish: (
        value: Awaited<ReturnType<NonNullable<typeof client>["listCheckoutCommits"]>>,
      ) => void,
      fail: () => void,
    ) => {
      let cancelled = false;
      const invalidate = () => {
        if (!current()) cancelled = true;
      };
      const stopEvents = client?.subscribe(invalidate);
      const stopConnection = client?.subscribeConnectionStatus(invalidate);
      const stopStore = useSessionStore.subscribe(invalidate);
      if (client && current())
        void client
          .listCheckoutCommits(cwd)
          .then((value) => {
            if (!cancelled && current()) publish(value);
            return null;
          })
          .catch(() => {
            if (!cancelled && current()) fail();
          });
      return () => {
        cancelled = true;
        stopEvents?.();
        stopConnection?.();
        stopStore();
      };
    },
    [client, current, cwd],
  );
  const result = useContextObservation(
    JSON.stringify([key, refresh]),
    active && Boolean(cwd),
    observe,
  );
  if (result.status !== "loaded")
    return (
      <Text style={styles.detail}>
        {result.status === "error" ? "Commit history unavailable" : "Loading commit history…"}
      </Text>
    );
  const commits = result.data.commits.slice(0, 60);
  // Capability promises parent lists. Malformed data cannot fabricate a graph.
  if (commits.some((commit) => !Array.isArray(commit.parentShas)))
    return <Text style={styles.detail}>Commit topology unavailable</Text>;
  const topology = buildCommitTopology(
    commits.map((commit) => ({ sha: commit.sha, parentShas: commit.parentShas! })),
  );
  const width = Math.max(24, topology.lanes * 20);
  return (
    <View style={styles.group}>
      <Text style={styles.detail}>
        Commits — workspace · {result.data.baseRef ?? "base not available"}
      </Text>
      <Text style={styles.detail}>
        Actual parent links; parents outside this history window are marked.
      </Text>
      <ScrollView horizontal>
        <View style={styles.graphRows}>
          <Svg width={width} height={commits.length * 80} accessible={false}>
            {topology.edges.map(({ from, to }) => (
              <Line
                key={`${from}:${to}`}
                x1={12 + topology.nodes[from]!.lane * 20}
                y1={from * 80 + 40}
                x2={12 + topology.nodes[to]!.lane * 20}
                y2={to * 80 + 40}
                stroke={styles.edge.color}
                strokeWidth={2}
              />
            ))}
            {topology.nodes.map((node) => (
              <Circle
                key={node.sha}
                cx={12 + node.lane * 20}
                cy={node.row * 80 + 40}
                r={4}
                fill={styles.edge.color}
              />
            ))}
          </Svg>
          <View>
            {commits.map((commit, row) => (
              <View key={commit.sha} style={styles.commitRow}>
                <CommitButton sha={commit.sha} onOpenTarget={onOpenTarget}>
                  {commit.shortSha} · {commit.subject}
                </CommitButton>
                <Text style={styles.detail}>
                  {commit.isOnBase ? "Base" : "Workspace"} ·{" "}
                  {commit.isOnRemote ? "On remote" : "Local only"}
                  {topology.nodes[row]!.outsideParents.length
                    ? ` · ${topology.nodes[row]!.outsideParents.length} parents outside window`
                    : ""}
                </Text>
                <Text style={styles.parentDetail}>
                  Parents: {commit.parentShas!.map((sha) => sha.slice(0, 7)).join(", ") || "root"}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
      {result.data.commits.length > commits.length ? (
        <Text style={styles.detail}>
          Showing the first 60 commits; this is a bounded history window.
        </Text>
      ) : null}
      {commits.length === 0 ? <Text style={styles.detail}>No observed commits</Text> : null}
      <Button variant="ghost" onPress={refreshRows}>
        Refresh commits
      </Button>
    </View>
  );
}

function ContextStashes({ serverId, workspaceId, active }: CheckoutContextProps) {
  const { client, cwd, current, key } = useCheckoutScope(serverId, workspaceId);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const applying = useRef(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const lifetime = useRef({ key, active });
  const epoch = useRef(0);
  if (lifetime.current.key !== key || lifetime.current.active !== active) {
    lifetime.current = { key, active };
    epoch.current += 1;
  }
  useEffect(() => {
    const invalidate = () => {
      if (!current()) epoch.current += 1;
    };
    const stopEvents = client?.subscribe(invalidate);
    const stopConnection = client?.subscribeConnectionStatus(invalidate);
    const stopStore = useSessionStore.subscribe(invalidate);
    return () => {
      epoch.current += 1;
      stopEvents?.();
      stopConnection?.();
      stopStore();
    };
  }, [client, current]);
  const observe = useCallback(
    (
      publish: (value: Awaited<ReturnType<NonNullable<typeof client>["stashList"]>>) => void,
      fail: () => void,
    ) => {
      let cancelled = false;
      const invalidate = () => {
        if (!current()) cancelled = true;
      };
      const stopEvents = client?.subscribe(invalidate);
      const stopConnection = client?.subscribeConnectionStatus(invalidate);
      const stopStore = useSessionStore.subscribe(invalidate);
      if (client && current())
        void client
          .stashList(cwd, { paseoOnly: false })
          .then((value) => {
            if (!cancelled && current()) {
              if (value.error) fail();
              else publish(value);
            }
            return null;
          })
          .catch(() => {
            if (!cancelled && current()) fail();
          });
      return () => {
        cancelled = true;
        stopEvents?.();
        stopConnection?.();
        stopStore();
      };
    },
    [client, current, cwd],
  );
  const result = useContextObservation(
    JSON.stringify([key, refresh]),
    active && Boolean(cwd),
    observe,
  );
  const canWrite =
    client?.getLastServerInfoMessage()?.permissions?.includes("workspace.write") === true;
  const apply = useCallback(async () => {
    const capturedEpoch = epoch.current;
    if (
      applying.current ||
      !selected ||
      !client ||
      !active ||
      !current() ||
      !client.getLastServerInfoMessage()?.permissions?.includes("workspace.write")
    )
      return;
    applying.current = true;
    setBusy(true);
    setOutcome(null);
    try {
      const response = await client.stashApply(cwd, selected);
      if (capturedEpoch !== epoch.current || !current()) return;
      setOutcome(
        response.success
          ? "Stash applied; the stash was retained."
          : "Stash could not be applied. Check workspace changes for conflicts; the stash was retained.",
      );
      setSelected(null);
      setRefresh((value) => value + 1);
    } catch {
      if (capturedEpoch === epoch.current && current())
        setOutcome(
          "Stash application status unavailable. Refresh workspace changes before another action.",
        );
    } finally {
      applying.current = false;
      if (capturedEpoch === epoch.current && current()) setBusy(false);
    }
  }, [active, client, current, cwd, selected]);
  const selectStash = useCallback((sha: string) => {
    setSelected(sha);
    setOutcome(null);
  }, []);
  const confirmApply = useCallback(() => {
    void apply();
  }, [apply]);
  const cancelApply = useCallback(() => setSelected(null), []);
  const refreshStashes = useCallback(() => {
    setSelected(null);
    setRefresh((value) => value + 1);
  }, []);
  if (result.status !== "loaded")
    return (
      <Text style={styles.detail}>
        {result.status === "error" ? "Stashes unavailable" : "Loading stashes…"}
      </Text>
    );
  return (
    <View style={styles.group}>
      <Text style={styles.detail}>
        Stashes — workspace · application retains the selected stash.
      </Text>
      {result.data.entries.length === 0 ? (
        <Text style={styles.detail}>No observed stashes</Text>
      ) : null}
      {result.data.entries.slice(0, 40).map((entry) => (
        <View key={entry.sha ?? `unavailable-${entry.index}`}>
          <Text style={styles.detail}>{entry.message}</Text>
          {entry.sha && canWrite ? (
            <SelectStashButton sha={entry.sha} disabled={busy} onSelect={selectStash} />
          ) : (
            <Text style={styles.detail}>Stash application unavailable</Text>
          )}
        </View>
      ))}
      {result.data.entries.length > 40 ? (
        <Text style={styles.detail}>Showing the first 40 stashes.</Text>
      ) : null}
      {selected ? (
        <View style={styles.group}>
          <Text style={styles.detail}>
            Apply {selected.slice(0, 7)} to this workspace? This changes working files and can
            produce conflicts. The stash stays available.
          </Text>
          <Button disabled={busy || !canWrite} onPress={confirmApply}>
            Confirm apply
          </Button>
          <Button variant="ghost" disabled={busy} onPress={cancelApply}>
            Cancel
          </Button>
        </View>
      ) : null}
      {outcome ? <Text style={styles.detail}>{outcome}</Text> : null}
      <Button variant="ghost" disabled={busy} onPress={refreshStashes}>
        Refresh stashes
      </Button>
    </View>
  );
}

function CommitButton({
  sha,
  onOpenTarget,
  children,
}: {
  sha: string;
  onOpenTarget: CheckoutContextProps["onOpenTarget"];
  children: import("react").ReactNode;
}) {
  const open = useCallback(() => onOpenTarget({ kind: "commit_diff", sha }), [onOpenTarget, sha]);
  return (
    <Button variant="ghost" size="sm" onPress={open}>
      {children}
    </Button>
  );
}
function SelectStashButton({
  sha,
  disabled,
  onSelect,
}: {
  sha: string;
  disabled: boolean;
  onSelect: (sha: string) => void;
}) {
  const select = useCallback(() => onSelect(sha), [onSelect, sha]);
  return (
    <Button variant="ghost" disabled={disabled} onPress={select}>
      Apply retained stash {sha.slice(0, 7)}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  group: { gap: theme.spacing[2] },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  graphRows: { flexDirection: "row" },
  commitRow: { height: 80, justifyContent: "center" },
  parentDetail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  edge: { color: theme.colors.foregroundMuted },
}));
