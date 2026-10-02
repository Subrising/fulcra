import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { Pressable, Text, TextInput, View } from "react-native";
import { taskCatalogRpc, usageRpc } from "../shared/tasks";
import { managementRpc, taskManagementRpc } from "../shared/management";
type Theme = Pick<PluginSurfaceProps, "theme">;
export function TaskControls({
  theme,
  selected,
  onSelect,
}: Theme & { selected: string; onSelect: (id: string) => void }) {
  const read = useContract(taskCatalogRpc),
    [cursor, setCursor] = useState(0),
    c = theme.colors;
  const manage = useContract(taskManagementRpc),
    [manual, setManual] = useState(""),
    [checking, setChecking] = useState(false),
    [notice, setNotice] = useState("");
  const controller = useContract(managementRpc),
    [retrying, setRetrying] = useState(false);
  const health = useQuery({
    queryKey: ["orca-controller-health"],
    queryFn: () => controller({ action: "health" }),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const controllerUnavailable = health.isError || health.data?.status === "error";
  const retryController = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await controller({ action: "retry-controller" });
      await health.refetch();
      await query.refetch();
    } catch {
      setNotice("Controller retry failed. Restart Command Centre in Settings.");
    } finally {
      setRetrying(false);
    }
  };
  const openTask = async () => {
    const id = manual.trim().toLowerCase();
    if (checking || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) return;
    setChecking(true);
    setNotice("");
    try {
      const result = await manage({ taskId: id, command: { action: "list" } });
      if (
        result.status === "observed" &&
        (result.taskAuthority?.allowed || result.sessions?.length || result.deliveries?.length)
      )
        onSelect(id);
      else
        setNotice("That task is not currently authorized and has no retained work available here.");
    } catch {
      setNotice("Task could not be checked. No work was started.");
    } finally {
      setChecking(false);
    }
  };
  const query = useQuery({
    queryKey: ["orca-tasks", cursor],
    queryFn: () => read({ cursor }),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const button = { padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8 };
  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "600" }}>Choose work</Text>
      {controllerUnavailable && (
        <View style={{ gap: 8 }}>
          <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>
            {health.data?.message ??
              "Controller connection unavailable. Retry or restart Command Centre in Settings."}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={retrying}
            onPress={() => void retryController()}
            style={button}
          >
            <Text style={{ color: c.foreground }}>
              {retrying ? "Retrying controller…" : "Retry controller"}
            </Text>
          </Pressable>
        </View>
      )}
      <Text style={{ color: c.foregroundMuted }}>
        Selecting a task does not start or delegate work. Return here through Menu → Fulcra or the
        Return to Fulcra command.
      </Text>
      {query.isError && (
        <Text style={{ color: c.foreground }}>
          Task list unavailable. Retained choices below may be stale.
        </Text>
      )}
      {query.isPending && (
        <Text style={{ color: c.foregroundMuted }}>Reading current and retained tasks…</Text>
      )}
      {query.data?.tasks.map((task) => (
        <Pressable
          key={task.id}
          disabled={checking}
          accessibilityRole="radio"
          accessibilityState={{ checked: selected === task.id }}
          accessibilityLabel={`Select ${task.identifier ?? task.id}: ${task.title}`}
          onPress={() => onSelect(task.id)}
          style={button}
        >
          <Text style={{ color: c.foreground }}>
            {selected === task.id ? "● " : "○ "}
            {task.identifier ?? "Retained task"} · {task.title}
          </Text>
          <Text style={{ color: c.foregroundMuted }}>
            {task.status ?? "Board status unavailable"}
            {task.retained ? " · Saved responsibility" : ""}
            {!task.eligibleHint ? " · Work authority needs checking" : ""}
          </Text>
        </Pressable>
      ))}
      {query.data && (
        <Text style={{ color: c.foregroundMuted }}>
          {query.data.note} {query.data.partial ? "Coverage is partial." : ""} Observed{" "}
          {query.data.observedAt}
        </Text>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {cursor > 0 && (
          <Pressable
            accessibilityRole="button"
            onPress={() => setCursor(Math.max(0, cursor - 32))}
            style={button}
          >
            <Text style={{ color: c.foreground }}>Previous tasks</Text>
          </Pressable>
        )}
        {query.data?.nextCursor != null && (
          <Pressable
            accessibilityRole="button"
            onPress={() => setCursor(query.data!.nextCursor!)}
            style={button}
          >
            <Text style={{ color: c.foreground }}>More tasks</Text>
          </Pressable>
        )}
      </View>
      <TextInput
        accessibilityLabel="Task UUID"
        placeholder="Task ID"
        placeholderTextColor={c.foregroundMuted}
        editable={!checking}
        value={manual}
        onChangeText={setManual}
        maxLength={36}
        autoCapitalize="none"
        style={{ ...button, color: c.foreground }}
      />
      <Pressable
        accessibilityRole="button"
        disabled={checking || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(manual.trim())}
        onPress={() => void openTask()}
        style={button}
      >
        <Text style={{ color: c.foreground }}>
          {checking ? "Checking task…" : "Open task by ID"}
        </Text>
      </Pressable>
      {notice && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>
          {notice}
        </Text>
      )}
    </View>
  );
}
export function UsagePanel({ theme }: Theme) {
  const read = useContract(usageRpc),
    c = theme.colors;
  const query = useQuery({
    queryKey: ["orca-provider-usage"],
    queryFn: () => read({}),
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return (
    <View style={{ gap: 8, padding: 14, borderWidth: 1, borderColor: c.border, borderRadius: 10 }}>
      <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "600" }}>Provider usage</Text>
      <Text style={{ color: c.foregroundMuted }}>
        Reported account limits, shared across your work. These are not costs for the selected task.
      </Text>
      {(query.isError || query.data?.available === false) && (
        <Text style={{ color: c.foreground }}>
          Usage unavailable. Missing figures do not mean zero usage.
        </Text>
      )}
      {query.isPending && (
        <Text style={{ color: c.foregroundMuted }}>Reading provider reports…</Text>
      )}
      {query.isError && query.data && (
        <Text style={{ color: c.foreground }}>The retained report is stale.</Text>
      )}
      {query.data?.providers.map((provider, index) => (
        <View key={`${provider.id}:${index}`} style={{ gap: 4 }}>
          <Text style={{ color: c.foreground, fontWeight: "600" }}>
            {provider.name} · {provider.status}
          </Text>
          <Text style={{ color: c.foregroundMuted }}>
            {provider.source ?? "Source not reported"} ·{" "}
            {provider.fetchedAt ?? "Source time unavailable"}
          </Text>
          {provider.windows.map((window, i) => (
            <Text key={i} style={{ color: c.foreground }}>
              {window.label}:{" "}
              {window.remaining === null
                ? "Remaining usage unavailable"
                : `${window.remaining}% remaining`}
              {window.used === null ? "" : ` · ${window.used}% used`}
              {window.resetsAt ? ` · resets ${window.resetsAt}` : ""}
            </Text>
          ))}
          {provider.balances.map((balance, i) => (
            <Text key={i} style={{ color: c.foreground }}>
              {balance.label}:{" "}
              {balance.remaining === null
                ? "Unavailable"
                : `${balance.remaining} ${balance.unit} remaining`}
            </Text>
          ))}
          {!provider.windows.length && !provider.balances.length && (
            <Text style={{ color: c.foregroundMuted }}>No usage window or balance reported.</Text>
          )}
          {provider.error && <Text style={{ color: c.foreground }}>{provider.error}</Text>}
        </View>
      ))}
      {query.data && (
        <Text style={{ color: c.foregroundMuted }}>
          Observed {query.data.observedAt}
          {query.data.truncated ? " · Report shortened to display limits" : ""}
        </Text>
      )}
    </View>
  );
}
