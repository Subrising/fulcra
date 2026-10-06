import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as pluginClient from "@getpaseo/plugin/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { useTrackerRefresh } from "./tracker-refresh";
import { trackerDirectoryRpc } from "../shared/trackers";
import { trackerViewRpc } from "../shared/cc/connectors";
import {
  recentPullRequests,
  changeTarget,
  checkoutFolder,
  addFolderProblem,
  readChangeWorkspaces,
  type ChangeWorkspace,
} from "./changes-model.mjs";
import { WorkButton } from "./work-button";
import { lastGood } from "./last-good";

type Props = PluginSurfaceProps;
interface Directory {
  available: boolean;
  partial: boolean;
  projects: { id: string; name: string }[];
}
export const UNAVAILABLE =
  "This host cannot open the change view from the Command Centre. Open the project's workspace in Fulcra, open Architecture map, then choose the change view.";

/** Feature detection happens before mounting readers, so older apps need no newer API. */
export function ChangesSurface(props: Props) {
  const c = props.theme.colors;
  return (
    <ScrollView
      testID="changes-entry"
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: props.layout.compact ? 16 : 24, gap: 16 }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: c.foreground, fontSize: 26, fontWeight: "700" }}
      >
        Changes & impact
      </Text>
      <Text style={{ color: c.foregroundMuted, lineHeight: 22 }}>
        See what changed and which parts of the product are affected.
      </Text>
      <Text style={{ color: c.foregroundMuted, lineHeight: 22 }}>
        Inspect code changes and their architecture impact in the original project workspace. Team
        workflow is the separate view of people, leads and working sessions.
      </Text>
      {typeof props.navigation?.openArchitectureChange === "function" ? (
        <ChangesProjects {...props} />
      ) : (
        <Text
          testID="changes-navigation-unavailable"
          style={{ color: c.foregroundMuted, lineHeight: 22 }}
        >
          {UNAVAILABLE}
        </Text>
      )}
    </ScrollView>
  );
}
interface Checkouts {
  status: "loading" | "error" | "ready";
  entries: readonly ChangeWorkspace[];
  chosen: ReadonlyMap<string, string>;
  choose: (repo: string, workspaceId: string) => void;
  reload: () => void;
}
function ChangesProjects(props: Props) {
  const read = useContract(trackerDirectoryRpc) as unknown as (
    input: Record<string, never>,
  ) => Promise<Directory>;
  const paseo = pluginClient.usePaseo();
  const query = useQuery({
    queryKey: ["orca-trackers-directory", props.host.id],
    queryFn: () => read({}),
    retry: false,
    staleTime: 30000,
  });
  const workspaces = useQuery({
    queryKey: ["changes-workspaces", props.host.id],
    queryFn: () => readChangeWorkspaces((input) => paseo.workspaces.list(input)),
    retry: false,
    staleTime: 30000,
  });
  const [chosen, setChosen] = useState<ReadonlyMap<string, string>>(new Map());
  const checkouts: Checkouts = {
    status: workspaces.isError ? "error" : workspaces.data ? "ready" : "loading",
    entries: workspaces.data?.entries ?? [],
    chosen,
    choose: (repo, workspaceId) => setChosen((map) => new Map(map).set(repo, workspaceId)),
    reload: () => {
      void workspaces.refetch();
    },
  };
  const last = lastGood(query, ["orca-trackers-directory", props.host.id]);
  const c = props.theme.colors;
  return (
    <View style={{ gap: 16 }}>
      {query.isLoading && <Text style={{ color: c.foregroundMuted }}>Loading projects…</Text>}
      {workspaces.isError && (
        <Text style={{ color: c.foregroundMuted }}>
          This host's workspaces could not be listed, so changes cannot be opened yet. Try again in
          a moment.
        </Text>
      )}
      {last.notice && <Text style={{ color: c.foregroundMuted }}>{last.notice}</Text>}
      {query.isError && !last.data && (
        <Text style={{ color: c.foreground }}>
          The project list could not be loaded. Try again in a moment.
        </Text>
      )}
      {last.data?.partial && (
        <Text style={{ color: c.foregroundMuted }}>Some projects could not be read.</Text>
      )}
      {last.data && !last.data.available && (
        <Text style={{ color: c.foregroundMuted }}>Projects are unavailable right now.</Text>
      )}
      {last.data?.available && last.data.projects.length === 0 && (
        <Text style={{ color: c.foregroundMuted }}>No open or recent pull requests</Text>
      )}
      {last.data?.projects.map((project) => (
        <ProjectChanges
          key={`${props.host.id}:${project.id}`}
          {...props}
          project={project}
          checkouts={checkouts}
        />
      ))}
    </View>
  );
}
function ProjectChanges({
  project,
  checkouts,
  ...props
}: Props & { project: { id: string; name: string }; checkouts: Checkouts }) {
  const read = useContract(trackerViewRpc),
    c = props.theme.colors;
  const query = useQuery({
    queryKey: ["fulcra-tracker-view", props.host.id, project.id],
    queryFn: () => read({ projectId: project.id }),
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  useTrackerRefresh(props.host.id, project.id);
  const last = lastGood(query, ["fulcra-tracker-view", props.host.id, project.id]);
  const [notice, setNotice] = useState<string | null>(null);
  const entries = recentPullRequests(last.data?.items ?? []).map((entry) => ({
    entry,
    target: changeTarget(entry.item, checkouts.entries, checkouts.chosen),
  }));
  const open = (workspaceId: string, pullRequest: number) => {
    try {
      props.navigation!.openArchitectureChange!({
        workspaceId,
        pullRequest,
        serverId: props.host.id,
      });
      setNotice(null);
    } catch {
      setNotice(
        "The change view could not be opened. Check that the project's workspace is available, then try again.",
      );
    }
  };
  const missing =
    checkouts.status === "ready"
      ? [
          ...new Set(
            entries.flatMap(({ target }) => (target.state === "no-checkout" ? [target.repo] : [])),
          ),
        ]
      : [];
  return (
    <View
      style={{
        gap: 12,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 14,
        backgroundColor: c.surface1,
        padding: 16,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: c.foreground, fontSize: 19, fontWeight: "600" }}
      >
        {project.name}
      </Text>
      {last.notice && <Text style={{ color: c.foregroundMuted }}>{last.notice}</Text>}
      {query.isLoading && <Text style={{ color: c.foregroundMuted }}>Loading pull requests…</Text>}
      {query.isError && !last.data && (
        <Text style={{ color: c.foreground }}>
          This project's pull requests could not be read. Try again in a moment.
        </Text>
      )}
      {last.data?.partial && (
        <Text style={{ color: c.foregroundMuted }}>Some pull requests could not be read.</Text>
      )}
      {last.data && entries.length === 0 && (
        <Text style={{ color: c.foregroundMuted }}>No open or recent pull requests</Text>
      )}
      {entries.map(({ entry, target }) => (
        <View key={entry.item.key} style={{ gap: 8, paddingVertical: 8 }}>
          <Text style={{ color: c.foreground, fontSize: 16 }}>
            {entry.item.title || "Untitled pull request"}
          </Text>
          <Text style={{ color: c.foregroundMuted }}>
            {entry.item.state === "merged" ? "Merged" : "Open"}
            {entry.stale ? " · Last copy" : ""}
          </Text>
          {checkouts.status === "loading" && (
            <Text style={{ color: c.foregroundMuted }}>Checking this host's workspaces…</Text>
          )}
          {checkouts.status === "ready" && target.state === "ready" && (
            <View style={{ alignItems: "flex-start" }}>
              <WorkButton
                theme={props.theme}
                label={`Open change view for ${entry.item.title || "this pull request"}`}
                onPress={() => open(target.workspaceId, target.pullRequest)}
              >
                Open change view
              </WorkButton>
            </View>
          )}
          {checkouts.status === "ready" && target.state === "no-checkout" && (
            <Text
              style={{ color: c.foregroundMuted }}
            >{`No workspace on this host is a checkout of ${target.repo}. Add its folder below to open this change.`}</Text>
          )}
          {target.state === "unreadable" && (
            <Text style={{ color: c.foregroundMuted }}>
              This pull request's link does not match its repository, so it cannot be opened here.
            </Text>
          )}
        </View>
      ))}
      {missing.map((repo) => (
        <AddCheckout
          key={repo}
          {...props}
          repo={repo}
          onAdded={(workspaceId) => {
            checkouts.choose(repo, workspaceId);
            checkouts.reload();
            const first = entries.find(
              ({ target }) => target.state === "no-checkout" && target.repo === repo,
            );
            if (first && first.target.state === "no-checkout")
              open(workspaceId, first.target.pullRequest);
          }}
        />
      ))}
      {notice && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>
          {notice}
        </Text>
      )}
    </View>
  );
}
// U5-D12: a checkout the host does not serve yet is added the way Add project adds it (the host's open-project call,
// which returns the existing workspace for a folder it already serves). The folder may use any name for its GitHub
// remote; the host resolves the forge remote by URL (D07). A device without workspace.manage gets a plain refusal.
function AddCheckout({
  repo,
  onAdded,
  ...props
}: Props & { repo: string; onAdded: (workspaceId: string) => void }) {
  const paseo = pluginClient.usePaseo(),
    c = props.theme.colors;
  const [folder, setFolder] = useState(""),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState<string | null>(null);
  const add = async () => {
    const path = checkoutFolder(folder);
    if (!path) {
      setProblem(
        "Enter the full path of the checkout's folder on this host, for example ~/code/project.",
      );
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const workspace = await paseo.workspaces.open(path);
      setFolder("");
      onAdded(workspace.id);
    } catch (error) {
      setProblem(addFolderProblem(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 8, paddingTop: 8 }}>
      <Text style={{ color: c.foreground, fontWeight: "600" }}>{`Add the ${repo} checkout`}</Text>
      <Text style={{ color: c.foregroundMuted, lineHeight: 20 }}>
        Enter the folder on this host that holds a checkout of this repository. Its GitHub remote
        can have any name. Or add the folder in Fulcra with Add project; it appears here within a
        minute.
      </Text>
      <TextInput
        accessibilityLabel={`Folder of the ${repo} checkout`}
        placeholder="~/code/project"
        value={folder}
        onChangeText={setFolder}
        maxLength={1024}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          color: c.foreground,
          minHeight: 48,
          padding: 12,
          fontSize: 15,
          backgroundColor: c.surface0,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 12,
        }}
      />
      <View style={{ alignItems: "flex-start" }}>
        <WorkButton
          theme={props.theme}
          label={`Add folder and open the change for ${repo}`}
          disabled={busy}
          onPress={() => {
            void add();
          }}
        >
          {busy ? "Adding…" : "Add folder and open"}
        </WorkButton>
      </View>
      {problem && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>
          {problem}
        </Text>
      )}
    </View>
  );
}
