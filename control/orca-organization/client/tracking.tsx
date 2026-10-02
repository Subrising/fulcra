import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { lastGood } from "./last-good";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { randomId } from "./random-id";
import { useContract } from "./use-contract";
import { useTrackerRefresh } from "./tracker-refresh";
import { WorkButton } from "./work-button";
import { openTrackerUrl, refSite } from "./tracker-link";
import { IntegrationsScreen } from "./integrations";
import { TrackerProjectPanel } from "./trackers";
import { trackerDirectoryRpc } from "../shared/trackers";
import {
  integrationsRpc,
  trackerMappingsRpc,
  trackerMappingResolveRpc,
  trackerMappingMapRpc,
  trackerMappingUnmapRpc,
  trackerViewRpc,
  type TrackerView,
} from "../shared/cc/connectors";
import { linkSetRpc, linkRemoveRpc } from "../shared/cc/links";
// Fulcra J4 Trackers tab: one project at a time, with every tracker mapped to it, its issues and pull requests,
// and who worked on each ("#42 → fixed in PR #17 → by session 'J4 Tracking' → merged 13:10"). Tracker text is
// untrusted and is only ever plain <Text>; the one way out to a tracker is "Open ↗" with the URL the server
// built. Fulcra only reads trackers. Links it worked out can be corrected by hand, and a hand-made correction wins.
type Theme = PluginSurfaceProps["theme"];
type Item = TrackerView["items"][number];
type Step = Item["trail"][number];
interface DirectoryProject {
  id: string;
  name: string;
  mapping: unknown;
  tasks: string[];
  sessions: { id: string; task: string }[];
}
interface Directory {
  available: boolean;
  partial: boolean;
  note: string;
  projects: DirectoryProject[];
}
const STATE_WORDS: Record<string, string> = {
  open: "Open",
  "in-progress": "In progress",
  closed: "Closed",
  merged: "Merged",
  unknown: "Unknown",
};
const STATUS_WORDS: Record<string, string> = {
  ok: "Up to date",
  stale: "Showing the last copy; the tracker cannot be reached right now",
  "auth-required": "The account needs reconnecting in Settings › Integrations",
  expired: "The sign-in has expired. Reconnect it in Settings › Integrations",
  forbidden: "The account cannot read this repository",
  "rate-limited": "Paused briefly at the tracker's request",
  offline: "The tracker cannot be reached right now",
  "not-found": "Not found with this account",
  "invalid-response": "The tracker answered with something unexpected",
  "needs-host-update": "This needs Fulcra host update P1",
  error: "Could not be read",
};
const PROVENANCE_WORDS: Record<string, string> = {
  manual: "set by hand",
  reported: "reported",
  inferred: "worked out by Fulcra",
};
export const hhmm = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
// One line a busy reader can scan: "#42 → fixed in PR #17 → by session 'J4 Tracking' → merged 13:10".
export function trailText(item: Item["item"], trail: Step[]): string {
  if (!trail.length) return "";
  return [item.ref, ...trail.map((s) => (s.at ? `${s.label} ${hhmm(s.at)}` : s.label))].join(" → ");
}

// J0-9 last-good wiring: every read is keyed by the host, so switching hosts never shows another host's copy, and a
// stalled read keeps the last good result (memory only) with one plain notice; its age comes from the payload's own
// observedAt, not the time it arrived.
export function TrackingSurface({
  theme,
  layout,
  host,
}: Pick<PluginSurfaceProps, "theme" | "layout"> & { host?: PluginSurfaceProps["host"] }) {
  // J3's directory contract predates defineContract, so its output is typed here (shared/trackers.ts).
  const read = useContract(trackerDirectoryRpc) as unknown as (
      input: Record<string, never>,
    ) => Promise<Directory>,
    c = theme.colors;
  const hostId = host?.id ?? null;
  const query = useQuery({
    queryKey: ["orca-trackers-directory", hostId],
    queryFn: () => read({}),
    retry: false,
    staleTime: 30000,
  });
  const last = lastGood(query, ["orca-trackers-directory", hostId]);
  const [chosen, choose] = useState<string | null>(null),
    [settings, setSettings] = useState(false);
  const projects = last.data?.projects ?? [],
    project = projects.find((p) => p.id === chosen) ?? projects[0];
  if (settings)
    return (
      <View style={{ flex: 1 }}>
        <View style={{ padding: 12 }}>
          <WorkButton theme={theme} label="Back to trackers" onPress={() => setSettings(false)}>
            ← Back to trackers
          </WorkButton>
        </View>
        <IntegrationsScreen theme={theme} layout={layout} />
      </View>
    );
  return (
    <ScrollView
      testID="tracking"
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{ color: c.foreground, fontSize: 26, fontWeight: "600" }}
        >
          Trackers
        </Text>
        <WorkButton
          theme={theme}
          label="Open Settings › Integrations"
          onPress={() => setSettings(true)}
        >
          Integrations
        </WorkButton>
      </View>
      <Text style={{ color: c.foregroundMuted }}>
        Issues and pull requests from your trackers, and who worked on each one. Fulcra only reads
        your trackers; it never changes them.
      </Text>
      {last.notice && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted }}>
          {last.notice}
        </Text>
      )}
      {query.isError && !last.data && (
        <Text style={{ color: c.foreground }}>
          The project list could not be loaded. Try again in a moment.
        </Text>
      )}
      {last.data && !last.data.available && (
        <Text style={{ color: c.foreground }}>{last.data.note}</Text>
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
        <ProjectTracking
          key={`${hostId}:${project.id}`}
          project={project}
          theme={theme}
          compact={!!layout.compact}
          hostId={hostId}
        />
      )}
    </ScrollView>
  );
}

function ProjectTracking({
  project,
  theme,
  compact,
  hostId,
}: {
  project: DirectoryProject;
  theme: Theme;
  compact: boolean;
  hostId: string | null;
}) {
  const readView = useContract(trackerViewRpc),
    readMappings = useContract(trackerMappingsRpc),
    unmap = useContract(trackerMappingUnmapRpc);
  const view = useQuery({
    queryKey: ["fulcra-tracker-view", hostId, project.id],
    queryFn: () => readView({ projectId: project.id }),
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const mappings = useQuery({
    queryKey: ["fulcra-tracker-mappings", hostId, project.id],
    queryFn: () => readMappings({ projectId: project.id }),
    retry: false,
    staleTime: 15000,
  });
  const fetched = useTrackerRefresh(hostId, project.id);
  const lastView = lastGood(view, ["fulcra-tracker-view", hostId, project.id]),
    lastMappings = lastGood(mappings, ["fulcra-tracker-mappings", hostId, project.id]);
  const [adding, setAdding] = useState(false),
    [earlier, setEarlier] = useState(false),
    [confirm, setConfirm] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const c = theme.colors,
    refresh = () => {
      void fetched.refetch();
      void view.refetch();
      void mappings.refetch();
    };
  const v = lastView.data,
    legacy = lastMappings.data?.legacy ?? null;
  const issues = v?.items.filter((i) => i.item.kind !== "pr") ?? [],
    prs = v?.items.filter((i) => i.item.kind === "pr") ?? [];
  const remove = async (id: string, revision: number) => {
    setConfirm(null);
    const r = await unmap({
      messageId: randomId(),
      id,
      expectedRevision: revision,
      note: "",
    }).catch(() => ({ ok: false, message: "That did not work. Nothing was changed." }));
    setNotice(r.ok ? "The tracker was removed from this project. Its links are kept." : r.message);
    refresh();
  };
  return (
    <View style={{ gap: 14 }}>
      <View
        style={{
          gap: 8,
          padding: 16,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 14,
          backgroundColor: c.surface1 ?? c.surface0,
        }}
      >
        <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "600" }}>
          Trackers for {project.name}
        </Text>
        {v?.trackers.length === 0 && !legacy && (
          <Text style={{ color: c.foregroundMuted }}>
            No tracker is connected to this project yet.
          </Text>
        )}
        {v?.trackers.map((t) => {
          const m = lastMappings.data?.mappings.find((x) => x.id === t.mappingId);
          const warn = t.status !== "ok";
          return (
            <View key={t.mappingId} testID={`tracker-${t.mappingId}`} style={{ gap: 6 }}>
              <View
                style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}
              >
                <Text style={{ color: c.foreground, fontWeight: "600" }}>
                  {t.label} · {t.remoteName}
                </Text>
                <Text
                  style={{ color: warn ? (c.statusWarning ?? c.foreground) : c.foregroundMuted }}
                >
                  {warn ? "⚠ " : ""}
                  {STATUS_WORDS[t.status] ?? STATUS_WORDS.error}
                  {t.status === "ok" && t.observedAt ? ` · checked ${hhmm(t.observedAt)}` : ""}
                </Text>
              </View>
              {t.commandLine && (
                <Text style={{ color: c.foregroundMuted }}>
                  Read through the command-line login on this computer (broad access; Fulcra only
                  reads).
                </Text>
              )}
              {m &&
                (confirm === m.id ? (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    <WorkButton
                      theme={theme}
                      label={`Confirm removing ${t.remoteName}`}
                      onPress={() => {
                        void remove(m.id, m.revision);
                      }}
                    >
                      Yes, remove it
                    </WorkButton>
                    <WorkButton theme={theme} label="Keep it" onPress={() => setConfirm(null)} />
                  </View>
                ) : (
                  <View style={{ flexDirection: "row" }}>
                    <WorkButton
                      theme={theme}
                      label={`Remove ${t.remoteName} from ${project.name}`}
                      onPress={() => setConfirm(m.id)}
                    >
                      Remove
                    </WorkButton>
                  </View>
                ))}
            </View>
          );
        })}
        {legacy && !legacy.copied && (
          <View style={{ gap: 6 }}>
            <Text style={{ color: c.foregroundMuted }}>
              {legacy.remoteName} still uses the earlier set-up (one tracker per project). It moves
              here by itself once Fulcra host update P1 is installed, and keeps working until then.
            </Text>
            <View style={{ flexDirection: "row" }}>
              <WorkButton
                theme={theme}
                label="Show the earlier set-up"
                expanded={earlier}
                onPress={() => setEarlier(!earlier)}
              >
                {earlier ? "Hide the earlier set-up" : "Show the earlier set-up"}
              </WorkButton>
            </View>
          </View>
        )}
        {adding ? (
          <AddTracker
            project={project}
            theme={theme}
            mappings={lastMappings.data?.mappings ?? []}
            onDone={(text) => {
              setAdding(false);
              setNotice(text);
              refresh();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <View style={{ flexDirection: "row" }}>
            <WorkButton
              theme={theme}
              label={`Add a tracker to ${project.name}`}
              onPress={() => {
                setNotice(null);
                setAdding(true);
              }}
            >
              Add a tracker
            </WorkButton>
          </View>
        )}
        {notice && (
          <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>
            {notice}
          </Text>
        )}
      </View>
      {earlier && legacy && !legacy.copied && (
        <TrackerProjectPanel project={project as never} theme={theme} onChanged={refresh} />
      )}
      {lastView.notice && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted }}>
          {lastView.notice}
        </Text>
      )}
      {view.isError && !v && (
        <Text style={{ color: c.foreground }}>
          This project's trackers could not be read. Nothing below is current.
        </Text>
      )}
      {v?.items.some((i) => i.stale) && (
        <Text style={{ color: c.foregroundMuted }}>
          Some of this may be out of date; items marked "last copy" are what Fulcra saw most
          recently.
        </Text>
      )}
      <ItemSection
        title="Issues"
        empty="No open or recently closed issues."
        items={issues}
        theme={theme}
        project={project}
        compact={compact}
        onChanged={refresh}
        show={!!v?.trackers.length}
      />
      <ItemSection
        title="Pull requests"
        empty="No open or recently merged pull requests."
        items={prs}
        theme={theme}
        project={project}
        compact={compact}
        onChanged={refresh}
        show={!!v?.trackers.length}
      />
    </View>
  );
}

function ItemSection({
  title,
  empty,
  items,
  theme,
  project,
  compact,
  onChanged,
  show,
}: {
  title: string;
  empty: string;
  items: Item[];
  theme: Theme;
  project: DirectoryProject;
  compact: boolean;
  onChanged: () => void;
  show: boolean;
}) {
  const c = theme.colors;
  if (!show) return null;
  return (
    <View style={{ gap: 8 }}>
      <Text
        accessibilityRole="header"
        style={{ color: c.foreground, fontSize: 18, fontWeight: "600" }}
      >
        {title}
      </Text>
      {!items.length && <Text style={{ color: c.foregroundMuted }}>{empty}</Text>}
      {items.map((i) => (
        <ItemRow
          key={i.item.key}
          entry={i}
          theme={theme}
          project={project}
          compact={compact}
          onChanged={onChanged}
        />
      ))}
    </View>
  );
}

function ItemRow({
  entry,
  theme,
  project,
  compact,
  onChanged,
}: {
  entry: Item;
  theme: Theme;
  project: DirectoryProject;
  compact: boolean;
  onChanged: () => void;
}) {
  const { item, trail, links, stale } = entry,
    c = theme.colors;
  const setLink = useContract(linkSetRpc),
    removeLink = useContract(linkRemoveRpc);
  const [open, setOpen] = useState(false),
    [notice, setNotice] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const workers = links.filter(
    (l) => l.from === item.key && l.relation === "worked-by" && l.state === "active",
  );
  // R-E-9: re-adding a link that was removed names the removed row's revision (the view carries removed links); only a
  // deliberate choice here restores one, never the automatic inference.
  const removedRevision = (to: string) =>
    links.find(
      (l) =>
        l.from === item.key && l.relation === "worked-by" && l.to === to && l.state === "removed",
    )?.revision ?? 0;
  const subjects = [
    ...project.tasks.map((id) => ({ ref: `task:${id}`, label: "This project's workstream", id })),
    ...project.sessions.map((s) => ({
      ref: `session:${s.id}`,
      label: "A session in this project",
      id: s.id,
    })),
  ]
    .filter((s) => !workers.some((w) => w.to === s.ref))
    .slice(0, 12);
  const act = async (run: () => Promise<{ ok: boolean; message: string | null }>, done: string) => {
    setBusy(true);
    try {
      const r = await run();
      setNotice(r.ok ? done : (r.message ?? "That did not work. Nothing was changed."));
      if (r.ok) onChanged();
    } catch {
      setNotice("That did not work. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  };
  const line = trailText(item, trail);
  return (
    <View
      testID={`tracker-item-${item.ref}`}
      style={{
        gap: 6,
        padding: 14,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 12,
        backgroundColor: c.surface1 ?? c.surface0,
      }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={{ color: c.foreground, fontWeight: "700" }}>{item.ref}</Text>
        <Text style={{ color: c.foreground, flexShrink: 1, fontWeight: "500" }}>
          {item.title || "Untitled"}
        </Text>
      </View>
      <Text
        style={{
          color:
            item.state === "merged" ? (c.statusSuccess ?? c.foregroundMuted) : c.foregroundMuted,
        }}
      >
        {STATE_WORDS[item.state] ?? "Unknown"}
        {item.labels.length ? ` · ${item.labels.join(", ")}` : ""}
        {stale ? " · last copy" : ""}
      </Text>
      {line ? (
        <Text testID={`tracker-trail-${item.ref}`} style={{ color: c.foreground }}>
          {line}
        </Text>
      ) : (
        <Text style={{ color: c.foregroundMuted }}>No work linked yet.</Text>
      )}
      {trail.some((s) => s.provenance) && (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {[
            ...new Set(
              trail.filter((s) => s.provenance).map((s) => PROVENANCE_WORDS[s.provenance!]),
            ),
          ].join(" · ")}
        </Text>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <WorkButton
          theme={theme}
          label={`Open ${item.ref} in the tracker`}
          onPress={() => {
            openTrackerUrl(item.url, undefined, refSite(item.key));
          }}
        >
          Open ↗
        </WorkButton>
        <WorkButton
          theme={theme}
          label={`Correct who worked on ${item.ref}`}
          expanded={open}
          onPress={() => setOpen(!open)}
        >
          {open ? "Done" : "Correct this"}
        </WorkButton>
      </View>
      {open && (
        <View style={{ gap: 8 }}>
          {workers.map((w) => (
            <View
              key={w.id}
              style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}
            >
              <Text style={{ color: c.foregroundMuted, flexShrink: 1 }}>
                {w.to.startsWith("task:") ? "A workstream" : "A session"} (
                {PROVENANCE_WORDS[w.provenance]}): {w.evidence}
              </Text>
              <WorkButton
                theme={theme}
                label={`Remove this link from ${item.ref}`}
                disabled={busy}
                onPress={() => {
                  void act(
                    () =>
                      removeLink({ messageId: randomId(), id: w.id, expectedRevision: w.revision }),
                    "Removed. Fulcra will not add it back by itself.",
                  );
                }}
              >
                Not right: remove
              </WorkButton>
            </View>
          ))}
          {subjects.map((s) => (
            <WorkButton
              key={s.ref}
              theme={theme}
              label={`Mark ${item.ref} as worked on by ${s.label.toLowerCase()} ${s.id.slice(0, 8)}`}
              disabled={busy}
              onPress={() => {
                void act(
                  () =>
                    setLink({
                      messageId: randomId(),
                      from: item.key,
                      relation: "worked-by",
                      to: s.ref,
                      evidence: "Set by hand in the Trackers view.",
                      expectedRevision: removedRevision(s.ref),
                    }),
                  "Linked.",
                );
              }}
            >{`Worked on by: ${s.label}`}</WorkButton>
          ))}
          {!subjects.length && !workers.length && (
            <Text style={{ color: c.foregroundMuted }}>
              This project has no workstreams or sessions to link.
            </Text>
          )}
        </View>
      )}
      {notice && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>
          {notice}
        </Text>
      )}
    </View>
  );
}

function AddTracker({
  project,
  theme,
  mappings,
  onDone,
  onCancel,
}: {
  project: DirectoryProject;
  theme: Theme;
  mappings: { connector: string; remoteId: string; revision: number }[];
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const readIntegrations = useContract(integrationsRpc),
    resolve = useContract(trackerMappingResolveRpc),
    map = useContract(trackerMappingMapRpc);
  const integrations = useQuery({
    queryKey: ["fulcra-integrations"],
    queryFn: () => readIntegrations({}),
    retry: false,
    staleTime: 15000,
  });
  const c = theme.colors,
    field = {
      color: c.foreground,
      padding: 12,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      backgroundColor: c.surface0,
    };
  const connectors = integrations.data?.connectors ?? [];
  const [connectorId, setConnector] = useState<string | null>(null),
    [account, setAccount] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState(""),
    [pending, setPending] = useState<{
      remoteId: string;
      remoteName: string;
      site: string | null;
    } | null>(null);
  const [message, setMessage] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const connector = connectors.find((x) => x.id === connectorId) ?? connectors[0];
  // This Mac's own GitHub sign-in (a `cli` account, U7 W4) only names you; it is read through the command-line choice below.
  const accounts = (integrations.data?.accounts ?? []).filter(
    (a) => a.connector === connector?.id && a.state === "connected" && a.method !== "cli",
  );
  // R-E-1: the site is the account's own (the server derives and checks it), so it is shown, never typed.
  const choices: { id: string | null; label: string }[] = [
    ...accounts.map((a) => ({
      id: a.id,
      label: a.site ? `${a.displayName} · ${a.site}` : a.displayName,
    })),
    ...(connector?.auth.includes("cli")
      ? [{ id: null, label: "Command-line login on this computer (broad access)" }]
      : []),
  ];
  const chosen = account === undefined ? choices[0]?.id : account;
  const target = () => ({
    connector: connector!.id,
    accountId: chosen ?? null,
    remoteName: name.trim(),
    site: null,
  });
  const check = async () => {
    setBusy(true);
    setPending(null);
    setMessage(null);
    try {
      const r = await resolve(target());
      if (r.ok && r.remote) setPending(r.remote);
      else setMessage(r.message ?? "That was not found.");
    } catch {
      setMessage("The check did not work. Nothing was recorded.");
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      // R-E-9: a tracker removed earlier keeps its row; adding it again continues that row's revision.
      const retained =
        mappings.find((m) => m.connector === connector!.id && m.remoteId === pending.remoteId)
          ?.revision ?? 0;
      const r = await map({
        messageId: randomId(),
        projectId: project.id,
        ...target(),
        remoteName: pending.remoteName,
        confirmRemoteId: pending.remoteId,
        expectedRevision: retained,
        note: "",
      });
      if (r.ok) onDone(`${pending.remoteName} is now tracked for ${project.name}.`);
      else {
        setMessage(r.message);
        setPending(null);
      }
    } catch {
      setMessage("That did not work. Nothing was recorded.");
    } finally {
      setBusy(false);
    }
  };
  if (!connector)
    return (
      <Text style={{ color: c.foregroundMuted }}>
        {integrations.isError ? "Trackers could not be listed." : "Loading trackers…"}
      </Text>
    );
  return (
    <View
      testID="tracker-add"
      style={{ gap: 10, paddingTop: 10, borderTopWidth: 1, borderColor: c.border }}
    >
      <Text style={{ color: c.foreground, fontWeight: "600" }}>Add a tracker</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {connectors.map((x) => (
          <WorkButton
            key={x.id}
            theme={theme}
            label={x.label}
            selected={x.id === connector.id}
            onPress={() => {
              setConnector(x.id);
              setAccount(undefined);
              setPending(null);
            }}
          />
        ))}
      </View>
      {choices.length ? (
        <>
          <Text style={{ color: c.foregroundMuted }}>Read it with:</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {choices.map((a) => (
              <WorkButton
                key={a.id ?? "cli"}
                theme={theme}
                label={a.label}
                selected={a.id === chosen}
                onPress={() => {
                  setAccount(a.id);
                  setPending(null);
                }}
              />
            ))}
          </View>
        </>
      ) : (
        <Text style={{ color: c.foregroundMuted }}>
          Connect a {connector.label} account in Settings › Integrations first.
        </Text>
      )}
      <TextInput
        placeholderTextColor={c.foregroundMuted}
        accessibilityLabel={`${connector.label} repository or project`}
        placeholder={connector.id === "github" ? "owner/repository" : "Project or repository"}
        autoCapitalize="none"
        autoCorrect={false}
        value={name}
        onChangeText={(v) => {
          setName(v);
          setPending(null);
        }}
        maxLength={200}
        style={field}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <WorkButton
          theme={theme}
          label="Check it"
          disabled={busy || !name.trim() || !choices.length}
          onPress={() => {
            void check();
          }}
        >
          {busy && !pending ? "Checking…" : "Check it"}
        </WorkButton>
        <WorkButton theme={theme} label="Cancel adding a tracker" onPress={onCancel}>
          Cancel
        </WorkButton>
      </View>
      {pending && (
        <View style={{ gap: 8 }}>
          <Text style={{ color: c.foreground }}>
            Track {connector.label} {pending.remoteName}
            {pending.site ? ` on ${pending.site}` : ""} for {project.name}?
          </Text>
          <WorkButton
            theme={theme}
            label={`Yes, track ${pending.remoteName}`}
            selected
            disabled={busy}
            onPress={() => {
              void confirm();
            }}
          >
            Yes, track it
          </WorkButton>
        </View>
      )}
      {message && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>
          {message}
        </Text>
      )}
    </View>
  );
}
