import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { WorkButton } from "./work-button";
import { Details } from "./details";
import { agoText, lastGood } from "./last-good";
import { openTrackerUrl } from "./tracker-link";
import {
  trackerDirectoryRpc,
  trackerLinkRpc,
  trackerMapRpc,
  trackerResolveRpc,
  trackerUnlinkRpc,
  trackerUnmapRpc,
  trackersRpc,
} from "../shared/trackers";
// J3 tracker panel (J3-DESIGN.md §6). Tracker text — titles, labels — is untrusted and rendered ONLY as
// plain <Text>: never markdown, never a link. The one way out to the tracker is the explicit
// "Open in tracker" button with the URL the server constructed from the pinned mapping.
type Theme = PluginSurfaceProps["theme"];
type Directory = RpcOutput<typeof trackerDirectoryRpc>;
export type TrackerProject = Directory["projects"][number];
type Tracker = "github" | "jira" | "bitbucket";
const TRACKER_LABEL: Record<Tracker, string> = {
  github: "GitHub",
  jira: "Jira",
  bitbucket: "Bitbucket",
};
// The CLI stores the token where the plugin reads it (its manifest id). Jira accounts are per site, so the
// command needs the mapped site or it is refused.
export function setupCommand(tracker: string | null, site: string | null = null): string {
  const target =
    tracker === "jira"
      ? `jira ${site || "<site>.atlassian.net"}`
      : (tracker ?? "<github|jira|bitbucket>");
  return `node src/control/trackers-credential.mjs set ${target}`;
}
export function statusText(
  status: string,
  tracker: string | null,
  retryAt: string | null,
  observedAt: string | null,
  site: string | null = null,
): string {
  switch (status) {
    case "ok":
      return observedAt
        ? `Up to date · checked ${agoText(Date.now() - Date.parse(observedAt))}`
        : "Up to date";
    case "stale":
      return `STALE · last observed ${observedAt ?? "never"}; the tracker is unreachable`;
    case "auth-required":
      return `The sign-in is missing or has expired. On the host, in the Fulcra controller folder, run: ${setupCommand(tracker, site)}`;
    case "forbidden":
      return "The credential cannot read this repository or project. Add it to the token's access list.";
    case "not-found":
      return "Not found with the configured credential.";
    case "rate-limited":
      return `Rate limited · next check after ${retryAt ?? "a short wait"}`;
    case "offline":
      return `Tracker unreachable · next check after ${retryAt ?? "a short wait"}`;
    case "unmapped":
      return "No tracker mapped to this project.";
    case "invalid-response":
      return "The tracker returned data that did not match the mapping; nothing from it is shown.";
    default:
      return "Tracker read failed.";
  }
}
const outcomeText = (r: { ok: boolean; failure: string | null; message: string | null }) =>
  r.ok
    ? "Done."
    : r.failure === "refused"
      ? (r.message ?? "Refused.")
      : statusText(r.failure ?? "error", null, null, null);

export function TrackersSurface({
  theme,
  layout,
  host,
}: Pick<PluginSurfaceProps, "theme" | "layout"> & { host?: PluginSurfaceProps["host"] }) {
  const read = useRpc(trackerDirectoryRpc),
    c = theme.colors;
  const query = useQuery({
    queryKey: ["orca-trackers-directory", host?.id],
    queryFn: () => read({}),
    retry: false,
    staleTime: 30000,
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
  });
  const [chosen, choose] = useState<string | null>(null);
  // J0: a stalled read keeps the last good result (memory only) and says so in one plain notice.
  const directory = lastGood(query, ["orca-trackers-directory", host?.id]);
  const projects = directory.data?.projects ?? [],
    project = projects.find((p) => p.id === chosen) ?? projects[0];
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}
    >
      <Text style={{ color: c.foreground, fontSize: 26, fontWeight: "600" }}>Issue trackers</Text>
      <Text style={{ color: c.foregroundMuted }}>
        One tracker per project. Fulcra reads tracker items and records links locally; it never
        writes to the tracker.
      </Text>
      {directory.notice ? (
        <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>
          {directory.notice}
        </Text>
      ) : (
        query.isError && (
          <Text style={{ color: c.foreground }}>Fulcra is not answering yet; retrying.</Text>
        )
      )}
      {directory.data && !directory.data.available && (
        <Text style={{ color: c.foreground }}>{directory.data.note}</Text>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {projects.map((p) => (
          <WorkButton
            key={p.id}
            theme={theme}
            label={p.name}
            selected={p.id === project?.id}
            onPress={() => choose(p.id)}
          />
        ))}
      </View>
      {project && (
        <TrackerProjectPanel
          key={project.id}
          project={project}
          theme={theme}
          onChanged={() => {
            void query.refetch();
          }}
        />
      )}
    </ScrollView>
  );
}

export function TrackerProjectPanel({
  project,
  theme,
  onChanged,
}: {
  project: TrackerProject;
  theme: Theme;
  onChanged: () => void;
}) {
  const read = useRpc(trackersRpc),
    link = useRpc(trackerLinkRpc),
    unlink = useRpc(trackerUnlinkRpc),
    unmap = useRpc(trackerUnmapRpc);
  const query = useQuery({
    queryKey: ["orca-trackers-project", project.id],
    queryFn: () => read({ projectId: project.id }),
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const [linking, setLinking] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [confirmUnmap, setConfirmUnmap] = useState(false),
    [busy, setBusy] = useState(false);
  const c = theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  const last = lastGood(query, ["orca-trackers-project", project.id]);
  const view = last.data,
    status = view?.projects[0],
    mapping = project.mapping?.state === "mapped" ? project.mapping : null;
  const act = async (
    run: () => Promise<{ ok: boolean; failure: string | null; message: string | null }>,
  ) => {
    setBusy(true);
    try {
      const r = await run();
      setNotice(outcomeText(r));
      if (r.ok) {
        onChanged();
        void query.refetch();
      }
    } catch {
      setNotice("The request failed; nothing was assumed to have changed.");
    } finally {
      setBusy(false);
    }
  };
  const subjects = [
    ...project.tasks.map((id) => ({
      kind: "task" as const,
      id,
      label: `Workstream ${id.slice(0, 8)}`,
    })),
    ...project.sessions.map((s) => ({
      kind: "session" as const,
      id: s.id,
      label: `Session ${s.id.slice(0, 8)}`,
    })),
  ];
  return (
    <View style={{ gap: 12, padding: 16, borderWidth: 1, borderColor: c.border, borderRadius: 12 }}>
      <Text style={{ ...text, fontSize: 20, fontWeight: "600" }}>Tracker · {project.name}</Text>
      {mapping ? (
        <>
          <Text style={text}>
            {TRACKER_LABEL[mapping.tracker]} · {mapping.remoteName}
            {mapping.auth === "gh-cli" ? " · GitHub CLI login (broad access)" : ""}
          </Text>
          <Details theme={theme}>
            <Text selectable style={muted}>
              {TRACKER_LABEL[mapping.tracker]} id {mapping.remoteId}
            </Text>
          </Details>
        </>
      ) : (
        <MapForm
          project={project}
          theme={theme}
          onMapped={() => {
            onChanged();
            void query.refetch();
          }}
        />
      )}
      {status && (
        <Text accessibilityLiveRegion="polite" style={muted}>
          {statusText(
            status.status,
            status.tracker,
            status.retryAt,
            status.observedAt,
            mapping?.site ?? null,
          )}
        </Text>
      )}
      {last.notice ? (
        <Text accessibilityLiveRegion="polite" style={text}>
          {last.notice}
        </Text>
      ) : (
        query.isError && <Text style={text}>Fulcra is not answering yet; retrying.</Text>
      )}
      {notice && <Text style={text}>{notice}</Text>}
      {view?.items.map((item) => {
        const links = view.links.filter((l) => l.itemKey === item.key);
        const ref = item.key.split(":")[2];
        return (
          <View
            key={item.key}
            style={{ gap: 6, paddingTop: 10, borderTopWidth: 1, borderColor: c.border }}
          >
            <Text style={{ ...text, fontWeight: "600" }}>
              {item.ref} · {item.title ?? "not yet observed"}
            </Text>
            <Text style={muted}>
              {item.state}
              {item.labels.length ? " · " + item.labels.join(", ") : ""}
              {item.stale ? " · STALE" : ""}
              {item.fromPreviousMapping ? " · from a previous mapping" : ""}
            </Text>
            {links.map((l) => (
              <View
                key={l.id}
                style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}
              >
                <Text style={muted}>
                  Linked to {l.subject.kind === "task" ? "workstream" : "session"}{" "}
                  {l.subject.id.slice(0, 8)}
                </Text>
                <WorkButton
                  theme={theme}
                  label={`Unlink ${item.ref} from ${l.subject.id.slice(0, 8)}`}
                  disabled={busy}
                  onPress={() => {
                    void act(() => unlink({ linkId: l.id, expectedRevision: l.revision }));
                  }}
                >
                  Unlink
                </WorkButton>
              </View>
            ))}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <WorkButton
                theme={theme}
                label={`Open ${item.ref} in tracker`}
                onPress={() => {
                  openTrackerUrl(item.url);
                }}
              >
                Open in tracker ↗
              </WorkButton>
              {mapping && !item.fromPreviousMapping && (
                <WorkButton
                  theme={theme}
                  label={`Link ${item.ref}`}
                  expanded={linking === item.key}
                  onPress={() => setLinking(linking === item.key ? null : item.key)}
                >
                  Link to work…
                </WorkButton>
              )}
            </View>
            {linking === item.key && mapping && (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {subjects.length === 0 && (
                  <Text style={muted}>
                    This project has no member workstreams or sessions to link.
                  </Text>
                )}
                {subjects.map((s) => (
                  <WorkButton
                    key={s.kind + s.id}
                    theme={theme}
                    label={`Link ${item.ref} to ${s.label}`}
                    disabled={busy}
                    onPress={() => {
                      setLinking(null);
                      void act(() =>
                        link({
                          projectId: project.id,
                          subject: { kind: s.kind, id: s.id },
                          itemRef: ref,
                          expectedMappingRevision: mapping.revision,
                        }),
                      );
                    }}
                  >
                    {s.label}
                  </WorkButton>
                ))}
              </View>
            )}
          </View>
        );
      })}
      {mapping &&
        (confirmUnmap ? (
          <View style={{ gap: 8 }}>
            <Text style={text}>
              Unmap {mapping.remoteName}? Existing links stay, shown as from a previous mapping.
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <WorkButton
                theme={theme}
                label="Confirm unmap"
                disabled={busy}
                onPress={() => {
                  setConfirmUnmap(false);
                  void act(() =>
                    unmap({ projectId: project.id, expectedRevision: mapping.revision, note: "" }),
                  );
                }}
              />
              <WorkButton
                theme={theme}
                label="Cancel unmap"
                onPress={() => setConfirmUnmap(false)}
              />
            </View>
          </View>
        ) : (
          <WorkButton theme={theme} label="Unmap tracker" onPress={() => setConfirmUnmap(true)} />
        ))}
    </View>
  );
}

function MapForm({
  project,
  theme,
  onMapped,
}: {
  project: TrackerProject;
  theme: Theme;
  onMapped: () => void;
}) {
  const resolve = useRpc(trackerResolveRpc),
    map = useRpc(trackerMapRpc);
  const [tracker, setTracker] = useState<Tracker>("github"),
    [auth, setAuth] = useState<"keychain" | "gh-cli">("keychain");
  const [name, setName] = useState(""),
    [site, setSite] = useState(""),
    [pending, setPending] = useState<{ remoteId: string; remoteName: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const c = theme.colors,
    text = { color: c.foreground },
    field = {
      color: c.foreground,
      padding: 12,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
    };
  const target = {
    tracker,
    auth: tracker === "github" ? auth : ("keychain" as const),
    site: tracker === "jira" ? site.trim() : "",
    remoteName: name.trim(),
  };
  const check = async () => {
    setBusy(true);
    setPending(null);
    try {
      const r = await resolve(target);
      if (r.ok && r.remoteId && r.remoteName)
        setPending({ remoteId: r.remoteId, remoteName: r.remoteName });
      else setNotice(outcomeText(r));
    } catch {
      setNotice("The check failed.");
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await map({
        projectId: project.id,
        ...target,
        remoteName: pending.remoteName,
        confirmRemoteId: pending.remoteId,
        expectedRevision: project.mapping?.revision ?? 0,
        note: "",
      });
      setNotice(outcomeText(r));
      setPending(null);
      if (r.ok) onMapped();
    } catch {
      setNotice("Mapping failed; nothing was recorded.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 10 }}>
      <Text style={text}>Map a tracker to this project</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(["github", "jira", "bitbucket"] as const).map((t) => (
          <WorkButton
            key={t}
            theme={theme}
            label={TRACKER_LABEL[t]}
            selected={t === tracker}
            onPress={() => {
              setTracker(t);
              setPending(null);
            }}
          />
        ))}
      </View>
      {tracker === "github" && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <WorkButton
            theme={theme}
            label="Read-only token in the keychain (recommended)"
            selected={auth === "keychain"}
            onPress={() => {
              setAuth("keychain");
              setPending(null);
            }}
          />
          <WorkButton
            theme={theme}
            label="GitHub CLI login — broad access (repo, workflow); Fulcra only reads"
            selected={auth === "gh-cli"}
            onPress={() => {
              setAuth("gh-cli");
              setPending(null);
            }}
          />
        </View>
      )}
      {tracker === "jira" && (
        <TextInput
          accessibilityLabel="Jira site"
          placeholder="yourcompany.atlassian.net"
          value={site}
          onChangeText={(v) => {
            setSite(v);
            setPending(null);
          }}
          maxLength={253}
          style={field}
        />
      )}
      <TextInput
        accessibilityLabel={tracker === "jira" ? "Jira project key" : "Repository"}
        placeholder={
          tracker === "jira"
            ? "PROJ"
            : tracker === "github"
              ? "owner/repository"
              : "workspace/repository"
        }
        value={name}
        onChangeText={(v) => {
          setName(v);
          setPending(null);
        }}
        maxLength={200}
        style={field}
      />
      <WorkButton
        theme={theme}
        label="Check tracker"
        disabled={busy || !name.trim()}
        onPress={() => {
          void check();
        }}
      />
      {pending && (
        <View style={{ gap: 8 }}>
          <Text style={text}>
            Map {project.name} to {TRACKER_LABEL[tracker]} {pending.remoteName} (id{" "}
            {pending.remoteId})?
          </Text>
          <WorkButton
            theme={theme}
            label={`Confirm mapping to ${pending.remoteName}`}
            disabled={busy}
            onPress={() => {
              void confirm();
            }}
          />
        </View>
      )}
      {notice && <Text style={text}>{notice}</Text>}
    </View>
  );
}
