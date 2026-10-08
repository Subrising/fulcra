import { useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { WorkButton } from "./work-button";
import { DeploySection } from "./deploy";
import type { RadiusScratchOwnerAdapter } from "../shared/radius-scratch";
import { projectsRpc } from "../shared/projects";
import {
  environmentsRpc,
  promotionCreateRpc,
  promotionCancelRpc,
  type EnvironmentView,
  type PromotionView,
} from "../shared/cc/environment";
// Fulcra J8 Environments (CONTRACTS §6). Per project: dev → next → prod with what is where, the setup checklist, and
// "Promote to next". Promoting only prepares; the owner approves once, on a paired device, in the Inbox. Nothing on
// this screen runs a promotion. Technical detail (commit ids, logs, hosts) sits behind "Details".
type Theme = PluginSurfaceProps["theme"];
const shortSha = (ref: string) => ref.slice(ref.lastIndexOf("@") + 1, ref.lastIndexOf("@") + 8);
const when = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};
const by = (actor: string) =>
  actor === "human" ? "you" : actor === "operator" ? "the operator" : "Fulcra";
const HEALTH = { good: "Working", attention: "Needs attention", unknown: "Not known yet" } as const;
const STATE: Record<string, string> = {
  proposed: "Ready for approval",
  "awaiting-approval": "Waiting for your approval",
  approved: "Starting",
  running: "Putting it in place",
  verifying: "Checking that it works",
  succeeded: "Done",
  failed: "Stopped: the undo step did not finish",
  "rolling-back": "Putting the previous version back",
  "rolled-back": "A check failed, so the previous version was put back",
  cancelled: "Cancelled; nothing ran",
};
const ACTIVE = new Set([
  "proposed",
  "awaiting-approval",
  "approved",
  "running",
  "verifying",
  "rolling-back",
]);
function messageId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

function Details({ theme, children }: { theme: Theme; children: ReactNode }) {
  const [open, setOpen] = useState(false),
    c = theme.colors;
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${open ? "Hide" : "Show"} details`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ minHeight: 32, justifyContent: "center" }}
      >
        <Text style={{ color: c.foregroundMuted }}>{open ? "▾" : "▸"} Details</Text>
      </Pressable>
      {open && <View style={{ gap: 4, paddingLeft: 12 }}>{children}</View>}
    </View>
  );
}

export function EnvironmentsSurface({
  theme,
  layout,
  host,
  navigation,
  openPlanId = null,
}: Pick<PluginSurfaceProps, "theme" | "layout" | "host" | "navigation"> & {
  // The local-only Radius scratch simulation is superseded by Deploy; the owner adapter is no longer read here.
  radiusScratchOwner?: RadiusScratchOwnerAdapter;
  openPlanId?: string | null;
}) {
  const c = theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  const readProjects = useContract(projectsRpc),
    read = useContract(environmentsRpc),
    create = useContract(promotionCreateRpc),
    cancel = useContract(promotionCancelRpc);
  const projects = useQuery({
    queryKey: ["orca-projects", host?.id],
    queryFn: () => readProjects({}),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const [chosen, choose] = useState<string | null>(null),
    [selected, select] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const ids = useRef(new Map<string, string>());
  const list = projects.data?.projects ?? [],
    projectId = chosen ?? list[0]?.id ?? null;
  const query = useQuery({
    queryKey: ["orca-environments", host?.id, projectId],
    enabled: !!projectId,
    queryFn: () => read({ projectId: projectId! }),
    retry: false,
    refetchInterval: (q) =>
      (q.state.data?.promotions ?? []).some((p) => ACTIVE.has(p.promotion.state)) ? 4000 : 30000,
    refetchIntervalInBackground: false,
  });
  const d = query.data,
    envs = d?.environments ?? [];
  const active = envs.filter((e) => e.environment?.state === "active");
  const focus =
    envs.find((e) => e.id === selected) ?? active.find((e) => e.key === "next") ?? active[0];
  const promotions = d?.promotions ?? [],
    ongoing = promotions.find((p) => ACTIVE.has(p.promotion.state)) ?? promotions[0];
  // "Promote to next": the version on an environment moves one step along the path.
  const pairs = active.slice(0, -1).map((from, i) => ({ from, to: active[i + 1] }));
  const idFor = (key: string) => {
    if (!ids.current.has(key)) ids.current.set(key, messageId());
    return ids.current.get(key)!;
  };
  async function promote(from: EnvironmentView, to: EnvironmentView) {
    if (!from.current || !to.environment || busy) return;
    const key = `promote:${to.id}:${from.current.version.commit}`;
    setBusy(true);
    try {
      const r = await create({
        messageId: idFor(key),
        projectId: projectId!,
        from: from.id,
        to: to.id,
        commit: from.current.version.commit,
        expectedRevision: to.environment.revision,
      });
      setNotice(
        r.ok
          ? (r.waiting ??
              `Preparing: Fulcra is running the setup checks for ${to.environment.label}.`)
          : (r.message ?? "That could not be prepared."),
      );
      if (r.ok) ids.current.delete(key);
      await query.refetch();
    } finally {
      setBusy(false);
    }
  }
  async function stop(p: PromotionView) {
    const key = `cancel:${p.promotion.id}`;
    setBusy(true);
    try {
      const r = await cancel({
        messageId: idFor(key),
        id: p.promotion.id,
        expectedRevision: p.promotion.revision,
        note: "",
      });
      setNotice(r.ok ? "Cancelled. Nothing ran." : r.message);
      await query.refetch();
    } finally {
      setBusy(false);
    }
  }
  const envLabel = (id: string) =>
    envs.find((e) => e.id === id)?.environment?.label ?? "that environment";

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 16 : 24,
        gap: 16,
        maxWidth: 1040,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <Text accessibilityRole="header" style={{ ...text, fontSize: 26, fontWeight: "600" }}>
        Environments
      </Text>
      <Text style={{ ...muted, fontSize: 16 }}>
        Where each version of your work is running. Changes move one step at a time, and only when
        you approve.
      </Text>
      <DeploySection
        theme={theme}
        layout={layout}
        host={host}
        navigation={navigation}
        openPlanId={openPlanId}
      />
      <Text accessibilityRole="header" style={{ ...text, fontSize: 20, fontWeight: "700" }}>
        Promotion paths
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {list.map((p) => (
          <WorkButton
            key={p.id}
            theme={theme}
            label={p.name}
            selected={p.id === projectId}
            onPress={() => {
              choose(p.id);
              select(null);
              setNotice(null);
            }}
          />
        ))}
      </View>
      {projects.isError && (
        <Text style={text}>Fulcra could not read your projects yet; retrying.</Text>
      )}
      {d?.stale && (
        <Text
          accessibilityLiveRegion="polite"
          style={text}
        >{`This view may be out of date. Fulcra is slow to answer; retrying.`}</Text>
      )}
      {projectId && !d && query.isPending && <Text style={muted}>Reading environments…</Text>}
      {d && !envs.length && (
        <Text style={text}>
          No environments are set up for this project yet. Ask its orchestrator to propose them; you
          approve each one.
        </Text>
      )}

      {!!envs.length && (
        <View
          style={{
            flexDirection: layout.compact ? "column" : "row",
            gap: 12,
            alignItems: layout.compact ? "stretch" : "flex-start",
          }}
        >
          {envs.map((e, i) => (
            <View
              key={e.id}
              style={{
                flexDirection: layout.compact ? "column" : "row",
                alignItems: "center",
                gap: 12,
                flex: layout.compact ? undefined : 1,
              }}
            >
              {i > 0 && (
                <Text
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                  style={{ ...muted, fontSize: 20 }}
                >
                  {layout.compact ? "↓" : "→"}
                </Text>
              )}
              <Pressable
                testID={`env-row-${e.key}`}
                accessibilityRole="button"
                accessibilityLabel={`${e.environment?.label ?? e.key}: ${HEALTH[e.health]}`}
                accessibilityState={{ selected: focus?.id === e.id }}
                onPress={() => select(e.id)}
                style={{
                  flex: layout.compact ? undefined : 1,
                  alignSelf: "stretch",
                  gap: 6,
                  padding: 14,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: focus?.id === e.id ? c.accent : c.border,
                  backgroundColor: c.surface1 ?? c.surface0,
                }}
              >
                <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>
                  {e.environment?.label ?? e.key}
                </Text>
                {e.meaning && (
                  <Text style={muted}>{e.meaning[0].toUpperCase() + e.meaning.slice(1)}</Text>
                )}
                <Text style={{ ...text, fontWeight: "500" }}>{HEALTH[e.health]}</Text>
                <Text style={text}>
                  {e.current
                    ? `Version from ${when(e.current.at)}, put there by ${by(e.current.by)}`
                    : "Nothing recorded here yet"}
                </Text>
                {e.latest && e.latest.status !== "succeeded" && (
                  <Text style={muted}>{e.latest.note}</Text>
                )}
                <Text style={muted}>
                  {e.environment?.target.kind === "external"
                    ? `Runs on ${e.environment.target.label}`
                    : "Runs on a Fulcra host"}
                </Text>
                {e.pending && (
                  <Text style={text}>
                    {e.environment
                      ? "A change to how this is updated is waiting for your approval."
                      : "Waiting for your approval before it can be used."}
                  </Text>
                )}
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {!!pairs.length && (
        <View testID="env-promote" style={{ gap: 12 }}>
          {pairs.map(({ from, to }) => (
            <View key={to.id} testID={`env-promote-${to.key}`} style={{ gap: 6 }}>
              <WorkButton
                theme={theme}
                label={`Promote to ${to.environment!.label}`}
                disabled={
                  busy ||
                  !from.current ||
                  promotions.some((p) => p.promotion.to === to.id && ACTIVE.has(p.promotion.state))
                }
                onPress={() => void promote(from, to)}
              />
              <Text style={muted}>
                {from.current
                  ? `Moves the version on ${from.environment!.label} to ${to.environment!.label}. You approve it once, on your paired device.`
                  : `Nothing is on ${from.environment!.label} yet, so there is nothing to move.`}
              </Text>
            </View>
          ))}
        </View>
      )}
      {notice && (
        <Text accessibilityLiveRegion="polite" style={text}>
          {notice}
        </Text>
      )}

      {ongoing && (
        <View
          style={{ gap: 8, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: c.border }}
        >
          <Text
            accessibilityRole="header"
            style={{ ...text, fontSize: 18, fontWeight: "600" }}
          >{`To ${envLabel(ongoing.promotion.to)}: ${ongoing.preparing ? "Running the setup checks" : STATE[ongoing.promotion.state]}`}</Text>
          <Text style={text}>
            {ongoing.changes?.files == null
              ? "This is the first version recorded there."
              : `What changes: ${ongoing.changes.files} file${ongoing.changes.files === 1 ? "" : "s"}.`}
          </Text>
          <Text
            style={text}
          >{`Setup checks: ${ongoing.promotion.readiness.filter((r) => r.state === "pass").length} of ${ongoing.promotion.readiness.length} passed${ongoing.promotion.readiness.some((r) => r.state === "fail") ? ", and one failed, so it cannot be approved yet" : ""}.`}</Text>
          <Text style={text}>{`How to undo: ${ongoing.promotion.rollbackPlan}`}</Text>
          {ongoing.promotion.state === "awaiting-approval" && (
            <Text style={{ ...text, fontWeight: "600" }}>
              Approve or decline it in your Inbox, on your paired device.
            </Text>
          )}
          {["proposed", "awaiting-approval"].includes(ongoing.promotion.state) &&
            !ongoing.preparing && (
              <WorkButton
                theme={theme}
                label="Cancel this promotion"
                disabled={busy}
                onPress={() => void stop(ongoing)}
              />
            )}
          <Details theme={theme}>
            <Text selectable style={muted}>{`Version ${shortSha(ongoing.promotion.commit)}`}</Text>
            {ongoing.changes?.sample.map((f) => (
              <Text key={f} selectable style={muted}>
                {f}
              </Text>
            ))}
            {ongoing.promotion.log.slice(-12).map((l, i) => (
              <Text key={`${l.at}-${i}`} selectable style={muted}>{`${l.step}: ${l.line}`}</Text>
            ))}
          </Details>
        </View>
      )}

      {focus?.environment && (
        <View testID="env-checklist" style={{ gap: 8 }}>
          <Text
            accessibilityRole="header"
            style={{ ...text, fontSize: 18, fontWeight: "600" }}
          >{`Setup checklist for ${focus.environment.label}`}</Text>
          {!focus.environment.requirements.length && (
            <Text style={muted}>No setup checks are defined for this environment.</Text>
          )}
          {focus.environment.requirements.map((r) => (
            <View
              key={r.id}
              accessibilityLabel={`${r.label}: ${r.last.state === "pass" ? "passed" : r.last.state === "fail" ? "failed" : "not checked yet"}`}
              style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}
            >
              <Text
                style={{
                  color:
                    r.last.state === "pass"
                      ? (c.statusSuccess ?? c.foreground)
                      : r.last.state === "fail"
                        ? (c.statusDanger ?? c.foreground)
                        : c.foregroundMuted,
                  fontSize: 16,
                }}
              >
                {r.last.state === "pass" ? "✓" : r.last.state === "fail" ? "✕" : "○"}
              </Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={text}>{r.label}</Text>
                <Text style={muted}>
                  {r.check.kind === "manual"
                    ? "A person confirms this"
                    : r.last.at
                      ? `${r.last.state === "pass" ? "Passed" : r.last.state === "fail" ? "Failed" : "Not checked"} ${when(r.last.at)}`
                      : "Not checked yet"}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
