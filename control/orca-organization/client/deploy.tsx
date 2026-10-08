import { useEffect, useState, type ReactNode } from "react";
import { Linking, Pressable, Text, TextInput, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { WorkButton } from "./work-button";
import {
  deployOverviewRpc,
  deploySourcesRpc,
  deployConnectLocalRpc,
  deployConnectClusterRpc,
  deployPlanRpc,
  deployRollbackPlanRpc,
  deployPlanViewRpc,
  deployDiscardRpc,
  deployConfirmRpc,
  deployJobRpc,
  type DeployEnvironment,
  type DeployPlan,
  type DeployJob,
  type Deployment,
} from "../shared/cc/deploy";
import { kubeconfigContexts } from "../shared/cc/deploy-plan.mjs";

// Deploy from Fulcra: connect an environment once, pick a branch, pull request or commit, read what will change,
// then confirm. Nothing reaches an environment until a person presses Deploy on a preview; deleting anything also
// needs the environment's name typed. Technical output (Radius's own log) sits behind "Show log".
type Theme = PluginSurfaceProps["theme"];
type Colors = Theme["colors"];
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const STATE_COLOR = (c: Colors) => ({
  new: c.statusSuccess ?? c.accent,
  changed: c.statusWarning ?? c.foreground,
  removed: c.statusDanger ?? c.foreground,
  affected: c.foregroundMuted,
  same: c.border,
});
const STATE_WORD = {
  new: "New",
  changed: "Changes",
  removed: "Removed",
  affected: "Affected",
  same: "No change",
} as const;

function Card({
  theme,
  children,
  testID,
  tone,
}: {
  theme: Theme;
  children: ReactNode;
  testID?: string;
  tone?: "danger" | "accent";
}) {
  const c = theme.colors;
  return (
    <View
      testID={testID}
      style={{
        gap: 10,
        padding: 16,
        borderRadius: 14,
        borderWidth: 1,
        borderColor:
          tone === "danger"
            ? (c.statusDanger ?? c.border)
            : tone === "accent"
              ? (c.accent ?? c.border)
              : c.border,
        backgroundColor: c.surface1 ?? c.surface0,
      }}
    >
      {children}
    </View>
  );
}

function Link({ theme, label, url }: { theme: Theme; label: string; url: string }) {
  return (
    <Text
      accessibilityRole="link"
      onPress={() => void Linking.openURL(url)}
      style={{
        color: theme.colors.accent ?? theme.colors.foreground,
        textDecorationLine: "underline",
      }}
    >
      {label}
    </Text>
  );
}

function Toggle({ theme, label, children }: { theme: Theme; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? "Hide" : "Show"} ${label}`}
        onPress={() => setOpen(!open)}
        style={{ minHeight: 32, justifyContent: "center" }}
      >
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {open ? "▾ Hide" : "▸ Show"} {label}
        </Text>
      </Pressable>
      {open && children}
    </View>
  );
}

function RefLine({
  theme,
  plan,
}: {
  theme: Theme;
  plan: Pick<DeployPlan, "ref" | "source"> | Deployment;
}) {
  const c = theme.colors;
  const ref = plan.ref;
  const project = "source" in plan ? plan.source.project : plan.project;
  const what =
    ref.kind === "pr"
      ? `pull request ${ref.label}`
      : ref.kind === "branch"
        ? `branch ${ref.label}`
        : `commit ${ref.label}`;
  return (
    <Text style={{ color: c.foregroundMuted }}>
      From {project}, {ref.url ? <Link theme={theme} label={what} url={ref.url} /> : what} (
      {ref.commit.slice(0, 7)})
    </Text>
  );
}

/** The blast radius: every part of the app, coloured by what happens to it, and what is wired to what. */
export function ChangeMap({
  theme,
  change,
  compact,
}: {
  theme: Theme;
  change: DeployPlan["change"];
  compact: boolean;
}) {
  const c = theme.colors,
    colors = STATE_COLOR(c);
  const name = (id: string) =>
    change.map.parts.find((p) => p.id === id)?.name ?? id.split("/").pop();
  return (
    <View testID="deploy-map" style={{ gap: 10 }}>
      <View style={{ flexDirection: compact ? "column" : "row", flexWrap: "wrap", gap: 10 }}>
        {change.map.parts.map((p) => (
          <View
            key={p.id}
            accessibilityLabel={`${p.name}, ${p.label}: ${STATE_WORD[p.state]}`}
            style={{
              minWidth: 150,
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderRadius: 12,
              borderWidth: p.state === "same" ? 1 : 2,
              borderStyle: p.state === "removed" ? "dashed" : "solid",
              borderColor: colors[p.state],
              backgroundColor: c.surface0,
              opacity: p.state === "same" ? 0.7 : 1,
            }}
          >
            <Text style={{ color: c.foreground, fontWeight: "600" }}>{p.name}</Text>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{p.label}</Text>
            <Text style={{ color: colors[p.state], fontSize: 12, fontWeight: "600" }}>
              {STATE_WORD[p.state]}
            </Text>
          </View>
        ))}
      </View>
      {!!change.map.links.length && (
        <View style={{ gap: 2 }}>
          {change.map.links.map((l) => (
            <Text
              key={`${l.from}>${l.to}`}
              style={{
                color:
                  l.state === "same"
                    ? c.foregroundMuted
                    : colors[l.state === "new" ? "new" : "removed"],
              }}
            >
              {name(l.from)} → {name(l.to)}
              {l.state === "new"
                ? "  (new connection)"
                : l.state === "removed"
                  ? "  (connection removed)"
                  : ""}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

export function PlanPreview({
  theme,
  layout,
  plan,
  onDone,
}: Pick<PluginSurfaceProps, "theme" | "layout"> & {
  plan: DeployPlan;
  onDone: (jobId: string | null) => void;
}) {
  const c = theme.colors;
  const confirm = useContract(deployConfirmRpc),
    discard = useContract(deployDiscardRpc);
  const [typed, setTyped] = useState(""),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState<string | null>(null);
  const ch = plan.change;
  const groups = [
    [
      "New",
      ch.changes.filter((x) => x.kind === "add" && x.type !== "applications.core/applications"),
    ],
    ["Changes", ch.changes.filter((x) => x.kind === "update")],
    ["Removed", ch.changes.filter((x) => x.kind === "remove")],
  ] as const;
  const needsWord = ch.destructive && plan.confirmWord;
  const ready =
    plan.status === "ready" &&
    ch.changes.length > 0 &&
    (!needsWord || typed.trim() === plan.confirmWord);
  const verb = plan.rollbackOf ? "Roll back" : "Deploy";
  async function go() {
    setBusy(true);
    setProblem(null);
    try {
      const r = await confirm({
        planId: plan.id,
        digest: plan.digest,
        typed: needsWord ? typed : null,
      });
      onDone(r.jobId);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card theme={theme} testID="deploy-preview" tone={ch.destructive ? "danger" : "accent"}>
      <Text style={{ color: c.foregroundMuted }}>
        {plan.rollbackOf ? "Roll back" : "What will change"} on {plan.environmentName}
        {plan.preparedBy.kind === "session" ? ` · prepared by ${plan.preparedBy.label}` : ""}
      </Text>
      <Text
        accessibilityRole="header"
        testID="deploy-summary"
        style={{ color: c.foreground, fontSize: 22, fontWeight: "700", lineHeight: 28 }}
      >
        {ch.summary}
      </Text>
      <RefLine theme={theme} plan={plan} />
      {groups.map(([title, items]) =>
        items.length ? (
          <View key={title} style={{ gap: 6 }}>
            <Text style={{ color: c.foreground, fontWeight: "700" }}>
              {title} ({items.length})
            </Text>
            {items.map((x) => (
              <View key={x.key} style={{ gap: 2, paddingLeft: 8 }}>
                <Text style={{ color: c.foreground }}>
                  {x.name} <Text style={{ color: c.foregroundMuted }}>· {x.label}</Text>
                </Text>
                {x.details.map((d) => (
                  <Text key={d} style={{ color: c.foregroundMuted, paddingLeft: 8 }}>
                    {d}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        ) : null,
      )}
      {!!ch.map.parts.length && <ChangeMap theme={theme} change={ch} compact={layout.compact} />}
      {ch.risks.map((r) => (
        <Text
          key={r}
          style={{
            color: /cannot be undone|Deletes/.test(r)
              ? (c.statusDanger ?? c.foreground)
              : (c.statusWarning ?? c.foreground),
          }}
        >
          ⚠ {r}
        </Text>
      ))}
      {ch.notes.map((n) => (
        <Text key={n} style={{ color: c.foregroundMuted }}>
          {n}
        </Text>
      ))}
      {plan.status !== "ready" && (
        <Text style={{ color: c.statusWarning ?? c.foreground }}>
          {plan.status === "stale"
            ? (plan.statusNote ?? "This preview is out of date. Prepare a new one.")
            : `This plan is ${plan.status}.`}
        </Text>
      )}
      {plan.status === "ready" && !ch.changes.length && (
        <Text style={{ color: c.foregroundMuted }}>There is nothing to deploy.</Text>
      )}
      {plan.status === "ready" && needsWord && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: c.foreground }}>
            This deletes something. To confirm, type{" "}
            <Text style={{ fontWeight: "700" }}>{plan.confirmWord}</Text>
          </Text>
          <TextInput
            testID="deploy-confirm-word"
            accessibilityLabel={`Type ${plan.confirmWord} to confirm`}
            value={typed}
            onChangeText={setTyped}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={plan.confirmWord ?? ""}
            placeholderTextColor={c.foregroundMuted}
            style={{
              color: c.foreground,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 10,
              padding: 10,
              minHeight: 44,
              maxWidth: 320,
            }}
          />
        </View>
      )}
      {problem && <Text style={{ color: c.statusDanger ?? c.foreground }}>{problem}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {plan.status === "ready" && (
          <WorkButton
            theme={theme}
            label={`${verb} to ${plan.environmentName}`}
            selected={ready}
            disabled={!ready || busy}
            onPress={() => void go()}
          >
            {busy ? "Starting…" : `${verb} to ${plan.environmentName}`}
          </WorkButton>
        )}
        <WorkButton
          theme={theme}
          label={plan.status === "ready" ? "Discard this plan" : "Close"}
          onPress={() => {
            if (plan.status === "ready")
              void discard({ planId: plan.id }).finally(() => onDone(null));
            else onDone(null);
          }}
        />
      </View>
      <Toggle theme={theme} label="details">
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          Plan {plan.id.slice(0, 8)} · fingerprint {plan.digest.slice(0, 12)} · {plan.source.bicep}{" "}
          · prepared {when(plan.createdAt)}
        </Text>
      </Toggle>
    </Card>
  );
}

export function JobProgress({
  theme,
  jobId,
  onFinished,
}: {
  theme: Theme;
  jobId: string;
  onFinished?: (job: DeployJob) => void;
}) {
  const c = theme.colors;
  const read = useContract(deployJobRpc);
  const job = useQuery({
    queryKey: ["deploy-job", jobId],
    queryFn: () => read({ jobId }),
    refetchInterval: (q) => (q.state.data?.status === "running" || !q.state.data ? 1500 : false),
    retry: 2,
  });
  const j = job.data;
  useEffect(() => {
    if (j && j.status !== "running") onFinished?.(j);
    // onFinished is a fresh closure each render; the status change is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [j?.status]);
  if (!j) return <Text style={{ color: c.foregroundMuted }}>Starting…</Text>;
  const mark = { waiting: "○", running: "◐", done: "✓", failed: "✕", skipped: "–" } as const;
  const tone = {
    waiting: c.foregroundMuted,
    running: c.foreground,
    done: c.statusSuccess ?? c.foreground,
    failed: c.statusDanger ?? c.foreground,
    skipped: c.foregroundMuted,
  };
  return (
    <Card
      theme={theme}
      testID="deploy-progress"
      tone={j.status === "failed" ? "danger" : undefined}
    >
      <Text testID="deploy-progress-status" style={{ color: c.foreground, fontWeight: "700" }}>
        {j.status === "running"
          ? j.kind === "connect"
            ? "Connecting…"
            : j.kind === "rollback"
              ? "Rolling back…"
              : "Deploying…"
          : j.status === "succeeded"
            ? j.kind === "connect"
              ? "Connected"
              : j.kind === "rollback"
                ? "Rolled back"
                : "Deployed"
            : "Stopped"}
      </Text>
      {j.steps.map((s, i) => (
        <View key={i} style={{ gap: 2 }}>
          <Text style={{ color: tone[s.state] }}>
            {mark[s.state]} {s.label}
          </Text>
          {s.note && s.state !== "done" && (
            <Text
              style={{ color: c.foregroundMuted, paddingLeft: 18 }}
              numberOfLines={s.state === "failed" ? 6 : 2}
            >
              {s.note}
            </Text>
          )}
        </View>
      ))}
      {/* A failed step already shows its reason; repeat the job's message only when it says something new. */}
      {j.message && !j.steps.some((s) => s.note === j.message) && (
        <Text style={{ color: c.statusDanger ?? c.foreground }}>{j.message}</Text>
      )}
      <Toggle theme={theme} label="log">
        <Text
          selectable
          testID="deploy-log"
          style={{ color: c.foregroundMuted, fontFamily: "monospace", fontSize: 12 }}
        >
          {j.log.slice(-60).join("\n") || "Nothing logged yet."}
        </Text>
      </Toggle>
    </Card>
  );
}

function ConnectPanel({ theme, onStarted }: { theme: Theme; onStarted: (jobId: string) => void }) {
  const c = theme.colors;
  const local = useContract(deployConnectLocalRpc),
    cluster = useContract(deployConnectClusterRpc);
  const [mode, setMode] = useState<"local" | "cluster">("local"),
    [name, setName] = useState("Test"),
    [kubeconfig, setKubeconfig] = useState(""),
    [context, setContext] = useState(""),
    [problem, setProblem] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const contexts = kubeconfig ? kubeconfigContexts(kubeconfig).names : [];
  const input = {
    color: c.foreground,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    padding: 10,
    minHeight: 44,
  };
  async function start() {
    setBusy(true);
    setProblem(null);
    try {
      const r =
        mode === "local" ? await local({ name }) : await cluster({ name, kubeconfig, context });
      setKubeconfig("");
      onStarted(r.jobId);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card theme={theme} testID="deploy-connect">
      <Text style={{ color: c.foreground, fontWeight: "700", fontSize: 16 }}>
        Connect an environment
      </Text>
      <Text style={{ color: c.foregroundMuted }}>
        You do this once. Fulcra deploys to it only when you confirm a plan.
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <WorkButton
          theme={theme}
          label="Local test cluster on this Mac"
          selected={mode === "local"}
          onPress={() => setMode("local")}
        />
        <WorkButton
          theme={theme}
          label="A cluster you sign in to"
          selected={mode === "cluster"}
          onPress={() => setMode("cluster")}
        />
      </View>
      <Text style={{ color: c.foregroundMuted }}>
        {mode === "local"
          ? "Fulcra creates a small Kubernetes cluster in Docker on this Mac, installs Radius on it and keeps its sign-in with the cluster tool. It needs Docker running and about 2 GB of memory."
          : "Paste the cluster's sign-in file (kubeconfig). Fulcra keeps it in the Keychain, never in a file, and only reads the cluster while connecting."}
      </Text>
      <TextInput
        accessibilityLabel="Environment name"
        value={name}
        onChangeText={setName}
        placeholder="Name, for example Test"
        placeholderTextColor={c.foregroundMuted}
        style={{ ...input, maxWidth: 320 }}
      />
      {mode === "cluster" && (
        <>
          <TextInput
            accessibilityLabel="Cluster sign-in file"
            value={kubeconfig}
            onChangeText={setKubeconfig}
            multiline
            secureTextEntry={false}
            placeholder="Paste kubeconfig here"
            placeholderTextColor={c.foregroundMuted}
            style={{ ...input, minHeight: 120, fontFamily: "monospace", fontSize: 12 }}
          />
          {!!contexts.length && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {contexts.map((n) => (
                <WorkButton
                  key={n}
                  theme={theme}
                  label={n}
                  selected={context === n}
                  onPress={() => setContext(n)}
                />
              ))}
            </View>
          )}
        </>
      )}
      {problem && <Text style={{ color: c.statusDanger ?? c.foreground }}>{problem}</Text>}
      <View style={{ flexDirection: "row" }}>
        <WorkButton
          theme={theme}
          label="Connect"
          selected
          disabled={busy || !name.trim() || (mode === "cluster" && (!kubeconfig || !context))}
          onPress={() => void start()}
        >
          {busy ? "Starting…" : "Connect"}
        </WorkButton>
      </View>
    </Card>
  );
}

function PlanPicker({
  theme,
  environment,
  onPlanned,
  host,
  navigation,
}: {
  theme: Theme;
  environment: DeployEnvironment;
  onPlanned: (plan: DeployPlan) => void;
  host?: PluginSurfaceProps["host"];
  navigation?: PluginSurfaceProps["navigation"];
}) {
  const c = theme.colors;
  const readSources = useContract(deploySourcesRpc),
    makePlan = useContract(deployPlanRpc);
  const sources = useQuery({
    queryKey: ["deploy-sources"],
    queryFn: () => readSources({}),
    retry: false,
  });
  const list = sources.data?.sources ?? [];
  const [sourceId, setSourceId] = useState<string | null>(null),
    [kind, setKind] = useState<"branch" | "pr" | "commit">("branch"),
    [value, setValue] = useState(""),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState<string | null>(null);
  const source = list.find((s) => s.id === sourceId) ?? list[0];
  const projects = [...new Map(list.map((s) => [s.project, s])).values()];
  const ref = value.trim() || (kind === "branch" ? (source?.branch ?? "") : "");
  const openMap = navigation?.openArchitectureMap;
  function showMap() {
    if (!source || !openMap) return;
    try {
      openMap({ workspaceId: source.id, serverId: host?.id });
      setProblem(null);
    } catch {
      setProblem(
        "The architecture map could not be opened. Check that the project is open in Fulcra.",
      );
    }
  }
  async function plan() {
    if (!source) return;
    setBusy(true);
    setProblem(null);
    try {
      onPlanned(
        await makePlan({
          environmentId: environment.id,
          sourceId: source.id,
          ref: { kind, value: kind === "pr" ? Number(ref) : ref },
        }),
      );
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  const input = {
    color: c.foreground,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    padding: 10,
    minHeight: 44,
    maxWidth: 360,
  };
  return (
    <Card theme={theme} testID="deploy-picker">
      <Text style={{ color: c.foreground, fontWeight: "700" }}>
        What to deploy to {environment.name}
      </Text>
      {sources.isPending && (
        <Text style={{ color: c.foregroundMuted }}>Reading your projects…</Text>
      )}
      {!sources.isPending && !list.length && (
        <Text style={{ color: c.foregroundMuted }}>
          Open a project with a Radius app (app.bicep) in Fulcra first.
        </Text>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {projects.map((s) => (
          <WorkButton
            key={s.id}
            theme={theme}
            label={s.project}
            selected={s.project === source?.project}
            onPress={() => setSourceId(s.id)}
          />
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <WorkButton
          theme={theme}
          label="Branch"
          selected={kind === "branch"}
          onPress={() => (setKind("branch"), setValue(""))}
        />
        <WorkButton
          theme={theme}
          label="Pull request"
          selected={kind === "pr"}
          onPress={() => (setKind("pr"), setValue(""))}
        />
        <WorkButton
          theme={theme}
          label="Commit"
          selected={kind === "commit"}
          onPress={() => (setKind("commit"), setValue(""))}
        />
      </View>
      {kind === "pr" && !!source?.pullRequests.length && (
        <View style={{ gap: 6 }}>
          {source.pullRequests.slice(0, 8).map((p) => (
            <WorkButton
              key={p.number}
              theme={theme}
              label={`#${p.number} ${p.title}`}
              selected={value === String(p.number)}
              onPress={() => setValue(String(p.number))}
            />
          ))}
        </View>
      )}
      <TextInput
        accessibilityLabel={
          kind === "pr" ? "Pull request number" : kind === "branch" ? "Branch name" : "Commit"
        }
        value={value}
        onChangeText={setValue}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={
          kind === "branch"
            ? (source?.branch ?? "main")
            : kind === "pr"
              ? "Number, for example 42"
              : "Commit id"
        }
        placeholderTextColor={c.foregroundMuted}
        style={input}
      />
      {problem && <Text style={{ color: c.statusDanger ?? c.foreground }}>{problem}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <WorkButton
          theme={theme}
          label="Preview changes"
          selected
          disabled={busy || !source || !ref}
          onPress={() => void plan()}
        >
          {busy ? "Working out what changes…" : "Preview changes"}
        </WorkButton>
        {openMap && (
          <WorkButton
            theme={theme}
            label="Open architecture map"
            disabled={!source}
            onPress={showMap}
          />
        )}
      </View>
    </Card>
  );
}

function EnvironmentCard({
  theme,
  layout,
  environment: e,
  onDeploy,
  onRollBack,
  onJob,
}: Pick<PluginSurfaceProps, "theme" | "layout"> & {
  environment: DeployEnvironment;
  onDeploy: () => void;
  onRollBack: () => void;
  onJob: (id: string) => void;
}) {
  const c = theme.colors;
  const cur = e.current;
  return (
    <Card theme={theme} testID={`deploy-env-${e.name}`}>
      <View
        style={{ flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}
      >
        <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "700" }}>{e.name}</Text>
        <Text
          style={{
            color:
              e.state === "ready"
                ? (c.statusSuccess ?? c.foreground)
                : e.state === "failed"
                  ? (c.statusDanger ?? c.foreground)
                  : c.foregroundMuted,
          }}
        >
          {e.state === "ready"
            ? e.runningJobId
              ? "Busy"
              : "Ready"
            : e.state === "failed"
              ? "Could not connect"
              : "Connecting"}
        </Text>
      </View>
      <Text style={{ color: c.foregroundMuted }}>{e.where}</Text>
      {e.problem && e.state === "failed" && (
        <Text style={{ color: c.statusDanger ?? c.foreground }}>{e.problem}</Text>
      )}
      {cur ? (
        <View style={{ gap: 4 }}>
          <Text testID="deploy-running-now" style={{ color: c.foreground, fontWeight: "600" }}>
            Running now: {cur.project},{" "}
            {cur.ref.kind === "pr"
              ? `pull request ${cur.ref.label}`
              : cur.ref.kind === "branch"
                ? `branch ${cur.ref.label}`
                : `commit ${cur.ref.label}`}
          </Text>
          <Text style={{ color: c.foregroundMuted }}>
            {cur.kind === "rollback" ? "Rolled back" : "Last change"}: {cur.summary}
          </Text>
          <RefLine theme={theme} plan={cur} />
          <Text style={{ color: c.foregroundMuted }}>
            {cur.kind === "rollback" ? "Rolled back" : "Deployed"}{" "}
            {when(cur.finishedAt ?? cur.startedAt)}
            {cur.preparedBy.kind === "session" ? ` · prepared by ${cur.preparedBy.label}` : ""}
          </Text>
          {cur.endpoint && (
            <Link
              theme={theme}
              label={`Open ${cur.endpoint.replace(/^https?:\/\//, "")}`}
              url={cur.endpoint}
            />
          )}
          {!cur.endpoint && cur.endpointNote && (
            <Text style={{ color: c.foregroundMuted }}>{cur.endpointNote}</Text>
          )}
        </View>
      ) : (
        e.state === "ready" && (
          <Text style={{ color: c.foregroundMuted }}>Nothing deployed here yet.</Text>
        )
      )}
      <View style={{ flexDirection: layout.compact ? "column" : "row", flexWrap: "wrap", gap: 8 }}>
        {e.state === "ready" && !e.runningJobId && (
          <WorkButton theme={theme} label="Deploy a version" selected onPress={onDeploy} />
        )}
        {e.canRollBack && !e.runningJobId && (
          <WorkButton
            theme={theme}
            label="Roll back to the previous deployment"
            onPress={onRollBack}
          />
        )}
        {e.runningJobId && (
          <WorkButton theme={theme} label="Show progress" onPress={() => onJob(e.runningJobId!)} />
        )}
      </View>
      {!!e.history.length && (
        <Toggle theme={theme} label={`history (${e.history.length})`}>
          {e.history.map((d) => (
            <View key={d.id} style={{ gap: 2, paddingVertical: 4 }}>
              <Text
                style={{
                  color: d.status === "failed" ? (c.statusDanger ?? c.foreground) : c.foreground,
                }}
              >
                {d.status === "succeeded" ? "✓" : d.status === "failed" ? "✕" : "◐"}{" "}
                {d.kind === "rollback" ? "Roll back: " : ""}
                {d.summary}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                {when(d.startedAt)} · {d.ref.kind === "pr" ? "PR " : ""}
                {d.ref.label} ({d.ref.commit.slice(0, 7)}){d.message ? ` · ${d.message}` : ""}
              </Text>
            </View>
          ))}
        </Toggle>
      )}
    </Card>
  );
}

/** Deploy from Fulcra, at the top of Environments. `openPlanId` opens a plan a session prepared (from Home). */
export function DeploySection({
  theme,
  layout,
  host,
  navigation,
  openPlanId = null,
}: Pick<PluginSurfaceProps, "theme" | "layout" | "host" | "navigation"> & {
  openPlanId?: string | null;
}) {
  const c = theme.colors;
  const queryClient = useQueryClient();
  const readOverview = useContract(deployOverviewRpc),
    readPlan = useContract(deployPlanViewRpc),
    rollbackPlan = useContract(deployRollbackPlanRpc);
  const [job, setJob] = useState<string | null>(null),
    [picking, setPicking] = useState<string | null>(null),
    [plan, setPlan] = useState<DeployPlan | null>(null),
    [connecting, setConnecting] = useState(false),
    [problem, setProblem] = useState<string | null>(null);
  const overview = useQuery({
    queryKey: ["deploy-overview", host?.id],
    queryFn: () => readOverview({}),
    refetchInterval: (q) =>
      q.state.data?.environments.some((e) => e.runningJobId || e.state === "connecting")
        ? 3000
        : 30000,
    retry: false,
  });
  useEffect(() => {
    if (!openPlanId) return;
    void readPlan({ planId: openPlanId }).then(setPlan, (error) =>
      setProblem(String(error?.message ?? error)),
    );
    // Open each plan once; the RPC caller is a fresh function on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPlanId]);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["deploy-overview", host?.id] });
  const d = overview.data;
  const envs = d?.environments ?? [];
  const waiting = (d?.plans ?? []).filter(
    (p) => p.status === "ready" && p.preparedBy.kind === "session" && p.id !== plan?.id,
  );
  async function startRollback(e: DeployEnvironment) {
    setProblem(null);
    try {
      setPlan(await rollbackPlan({ environmentId: e.id }));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <View testID="deploy-section" style={{ gap: 12 }}>
      <Text
        accessibilityRole="header"
        style={{ color: c.foreground, fontSize: 20, fontWeight: "700" }}
      >
        Deploy
      </Text>
      <Text style={{ color: c.foregroundMuted }}>
        Pick a branch, pull request or commit, see exactly what will change, then confirm. Radius
        does the deploying.
      </Text>
      {d && !d.available && (
        <Text style={{ color: c.statusWarning ?? c.foreground }}>{d.message}</Text>
      )}
      {problem && <Text style={{ color: c.statusDanger ?? c.foreground }}>{problem}</Text>}
      {!!waiting.length && !plan && (
        <Card theme={theme} testID="deploy-waiting" tone="accent">
          <Text style={{ color: c.foreground, fontWeight: "700" }}>Waiting for you</Text>
          {waiting.map((p) => (
            <View key={p.id} style={{ gap: 4 }}>
              <Text style={{ color: c.foreground }}>
                {p.preparedBy.kind === "session" ? p.preparedBy.label : "Someone"} prepared a deploy
                to {p.environmentName}: {p.change.summary}
              </Text>
              <View style={{ flexDirection: "row" }}>
                <WorkButton theme={theme} label="Review" onPress={() => setPlan(p)} />
              </View>
            </View>
          ))}
        </Card>
      )}
      {plan && (
        <PlanPreview
          theme={theme}
          layout={layout}
          plan={plan}
          onDone={(jobId) => {
            setPlan(null);
            setPicking(null);
            if (jobId) setJob(jobId);
            refresh();
          }}
        />
      )}
      {job && (
        <View style={{ gap: 6 }}>
          <JobProgress theme={theme} jobId={job} onFinished={refresh} />
          <View style={{ flexDirection: "row" }}>
            <WorkButton theme={theme} label="Hide progress" onPress={() => setJob(null)} />
          </View>
        </View>
      )}
      {!plan &&
        envs.map((e) => (
          <View key={e.id} style={{ gap: 8 }}>
            <EnvironmentCard
              theme={theme}
              layout={layout}
              environment={e}
              onDeploy={() => setPicking(picking === e.id ? null : e.id)}
              onRollBack={() => void startRollback(e)}
              onJob={setJob}
            />
            {picking === e.id && (
              <PlanPicker
                theme={theme}
                environment={e}
                onPlanned={setPlan}
                host={host}
                navigation={navigation}
              />
            )}
          </View>
        ))}
      {d?.available && !plan && (!envs.length || connecting) && (
        <ConnectPanel
          theme={theme}
          onStarted={(jobId) => {
            setConnecting(false);
            setJob(jobId);
            refresh();
          }}
        />
      )}
      {d?.available && !!envs.length && !connecting && !plan && (
        <View style={{ flexDirection: "row" }}>
          <WorkButton
            theme={theme}
            label="Connect another environment"
            onPress={() => setConnecting(true)}
          />
        </View>
      )}
    </View>
  );
}

/** Plans a session prepared that only a person can deploy. Home counts them under "Needs you". */
export function useDeployWaiting(host: PluginSurfaceProps["host"]): DeployPlan[] {
  const readOverview = useContract(deployOverviewRpc);
  const overview = useQuery({
    queryKey: ["deploy-overview", host?.id],
    queryFn: () => readOverview({}),
    refetchInterval: 30000,
    retry: false,
  });
  return (overview.data?.plans ?? []).filter(
    (p) => p.status === "ready" && p.preparedBy.kind === "session",
  );
}

/** Home's "Needs you" cards for those plans. */
export function DeployNeedsYou({
  theme,
  plans,
  onReview,
}: Pick<PluginSurfaceProps, "theme"> & {
  plans: DeployPlan[];
  onReview: (planId: string) => void;
}) {
  const c = theme.colors;
  if (!plans.length) return null;
  return (
    <View testID="today-deploy-needs" style={{ gap: 8 }}>
      {plans.slice(0, 3).map((p) => (
        <Card key={p.id} theme={theme} tone={p.change.destructive ? "danger" : "accent"}>
          <Text style={{ color: c.foregroundMuted }}>
            Deploy to {p.environmentName} · prepared by{" "}
            {p.preparedBy.kind === "session" ? p.preparedBy.label : "a session"}
          </Text>
          <Text style={{ color: c.foreground, fontWeight: "600" }}>{p.change.summary}</Text>
          {p.change.destructive && (
            <Text style={{ color: c.statusDanger ?? c.foreground }}>
              It deletes something, so it asks you to type the environment's name.
            </Text>
          )}
          <View style={{ flexDirection: "row" }}>
            <WorkButton
              theme={theme}
              label="Review and deploy"
              selected
              onPress={() => onReview(p.id)}
            />
          </View>
        </Card>
      ))}
    </View>
  );
}
