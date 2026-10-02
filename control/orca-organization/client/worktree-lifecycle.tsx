import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import {
  cleanupPreviewRpc,
  cleanupApplyRpc,
  cleanupRetentionRpc,
} from "../shared/worktree-lifecycle";
import type { CleanupPreview } from "../shared/worktree-lifecycle";
const pause = () => new Promise((resolve) => setTimeout(resolve, 1500));
const size = (n: number) =>
  n < 1048576
    ? `${Math.round(n / 1024)} KB`
    : n >= 1073741824
      ? `${(n / 1073741824).toFixed(1)} GB`
      : `${(n / 1048576).toFixed(1)} MB`;
export function CleanupSurface({ theme, layout }: Pick<PluginSurfaceProps, "theme" | "layout">) {
  const preview = useContract(cleanupPreviewRpc),
    apply = useContract(cleanupApplyRpc),
    setting = useContract(cleanupRetentionRpc);
  const [plan, setPlan] = useState<CleanupPreview | null>(null);
  const [days, setDays] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const c = theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch {
      setMessage("Could not finish. Refresh the preview and try again.");
    } finally {
      setBusy(false);
    }
  };
  const button = (label: string, action: () => Promise<void>) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={busy}
      onPress={() => void run(action)}
      style={{ padding: 12, borderRadius: 8, backgroundColor: c.accent, opacity: busy ? 0.5 : 1 }}
    >
      <Text style={{ color: c.accentForeground }}>{label}</Text>
    </Pressable>
  );
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}
    >
      <Text style={{ ...text, fontSize: 26, fontWeight: "600" }}>Clean finished jobs</Text>
      <Text style={muted}>
        Free space after work is finished. Branches, pull requests, reports and evidence are kept.
        Running sessions and unsaved work are protected.
      </Text>
      <View
        style={{ padding: 16, gap: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border }}
      >
        <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>Keep finished files for</Text>
        <Text style={muted}>
          Days after a pull request is merged or a session is archived. Use 0 for immediate
          clean-up, or “never” to turn automatic clean-up off.
        </Text>
        <TextInput
          accessibilityLabel="Retention days or never"
          placeholder="Preview to load current retention"
          placeholderTextColor={c.foregroundMuted}
          value={days}
          onChangeText={setDays}
          style={{
            ...text,
            backgroundColor: c.surface0,
            borderWidth: 1,
            borderColor: c.border,
            padding: 12,
            borderRadius: 8,
          }}
        />
        {button("Save retention", async () => {
          const value =
            days.trim().toLowerCase() === "never"
              ? "never"
              : /^\d+$/.test(days.trim())
                ? Number(days)
                : NaN;
          await setting({ retentionDays: value });
          setPlan(null);
          setMessage("Retention saved.");
        })}
      </View>
      {button(busy ? "Checking…" : "Preview clean-up", async () => {
        let r = await preview({});
        while (r.pending) {
          await pause();
          r = await preview({ operationId: r.operationId });
        }
        setPlan(r.value);
        setDays(String(r.value.retentionDays));
      })}
      {!!message && (
        <Text accessibilityRole="alert" style={text}>
          {message}
        </Text>
      )}
      {plan && (
        <>
          <Text style={{ ...text, fontSize: 20, fontWeight: "600" }}>
            {size(plan.jobs.reduce((n, j) => n + j.bytes, 0))} can be freed
          </Text>
          <Text style={muted}>
            Preview only. Confirm below to remove the listed eligible files. Each job is checked
            again before anything is removed.
          </Text>
          {plan.jobs.map((j) => (
            <View
              key={j.id}
              style={{
                gap: 8,
                padding: 16,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 12,
              }}
            >
              <Text style={{ ...text, fontWeight: "600", fontSize: 18 }}>
                {j.label} · {j.eligible ? "Ready to clean" : "Kept"} · {size(j.bytes)}
              </Text>
              <Text style={muted}>
                Session {j.state} · Pull request {j.pr}
              </Text>
              {j.blockers.map((b) => (
                <Text key={b} style={text}>
                  Needs attention: {b}
                </Text>
              ))}
              <Text style={text}>
                {j.eligible ? "Remove" : "Retain"}: {j.remove.join(", ") || "No disposable files"}
              </Text>
              <Text style={muted}>
                Keep: branches, pull requests, inputs, reports and evidence
                {j.keep.length
                  ? ` (${j.keep.length} ${j.keep.length === 1 ? "file" : "files"})`
                  : ""}
              </Text>
              <Text style={muted}>
                Working copies {size(j.sizes.worktrees)} · Dependencies {size(j.sizes.nodeModules)}{" "}
                · Build output {size(j.sizes.buildOutput)} · Kept files {size(j.sizes.kept)}
              </Text>
            </View>
          ))}
          {!plan.jobs.length && <Text style={text}>No job folders to clean.</Text>}
          {plan.candidates.map((ca) => (
            <Text key={ca.name} style={muted}>
              Release candidate · {size(ca.bytes)} · {ca.ageDays} days old · Kept for release review
            </Text>
          ))}
          {plan.jobs.some((j) => j.eligible) &&
            button("Confirm clean-up", async () => {
              let r = await apply({ planId: plan.planId, confirm: true });
              while (r.pending) {
                await pause();
                r = await apply({ planId: plan.planId, confirm: true });
              }
              const result = r.value;
              setPlan(null);
              setMessage(
                `${size(result.results.reduce((n, r) => n + r.bytes, 0))} freed. ${result.results.filter((r) => r.state === "complete").length} jobs cleaned. ${result.results.filter((r) => r.state !== "complete").length} kept for attention.`,
              );
            })}
        </>
      )}
    </ScrollView>
  );
}
