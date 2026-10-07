// The top of Settings → Clean-up: the automatic clean-up choices and "Clean up now" (preview, then confirm).
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { randomId } from "./random-id";
import { cleanupNowRpc, cleanupSettingsRpc } from "../shared/worktree-lifecycle";
import {
  IDLE_CHOICES,
  cleanupErrorWords,
  doneSummary,
  groupPlanned,
  keepTimeNote,
  settle,
  type CleanupItem,
  type CleanupSettingsValue,
} from "./cleanup-now";

const pause = () => new Promise((resolve) => setTimeout(resolve, 1000));

type Phase =
  | { kind: "idle" }
  | { kind: "preview"; previewId: string; items: CleanupItem[]; partial: boolean }
  | { kind: "done"; items: CleanupItem[] };

export function CleanupNowSection({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const settingsRpc = useContract(cleanupSettingsRpc),
    nowRpc = useContract(cleanupNowRpc);
  const [settings, setSettings] = useState<CleanupSettingsValue | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const c = theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted },
    card = { padding: 16, gap: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border },
    heading = { ...text, fontSize: 18, fontWeight: "600" as const };

  useEffect(() => {
    let live = true;
    settingsRpc({})
      .then((value) => live && setSettings(value))
      .catch(() => live && setMessage("Could not read the clean-up settings."));
    return () => {
      live = false;
    };
    // Read once when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (error) {
      setMessage(cleanupErrorWords(error));
    } finally {
      setBusy(false);
    }
  };
  const save = (patch: Partial<CleanupSettingsValue>) =>
    run(async () => setSettings(await settingsRpc(patch)));
  const cleanup = (input: { requestId: string; previewId?: string }) =>
    settle(
      () => nowRpc(input),
      (operationId) => nowRpc({ operationId }),
      pause,
    );
  const preview = () =>
    run(async () => {
      const value = await cleanup({ requestId: randomId() });
      if (!value.previewId) throw Error("Preview expired; start again");
      setPhase({
        kind: "preview",
        previewId: value.previewId,
        items: value.results,
        partial: value.partial,
      });
    });
  const confirm = (previewId: string) =>
    run(async () => {
      try {
        const value = await cleanup({ requestId: randomId(), previewId });
        setPhase({ kind: "done", items: value.results });
      } catch (error) {
        setPhase({ kind: "idle" });
        throw error;
      }
    });

  const button = (label: string, onPress: () => void, quiet = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={busy}
      onPress={onPress}
      style={{
        padding: 12,
        borderRadius: 8,
        borderWidth: quiet ? 1 : 0,
        borderColor: c.border,
        backgroundColor: quiet ? "transparent" : c.accent,
        opacity: busy ? 0.5 : 1,
        alignSelf: "flex-start",
      }}
    >
      <Text style={{ color: quiet ? c.foreground : c.accentForeground }}>{label}</Text>
    </Pressable>
  );
  const choice = (label: string, selected: boolean, onPress: () => void) => (
    <Pressable
      key={label}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={{
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: selected ? c.accent : c.border,
        backgroundColor: selected ? c.accent : "transparent",
      }}
    >
      <Text style={{ color: selected ? c.accentForeground : c.foreground }}>{label}</Text>
    </Pressable>
  );
  const itemLine = (item: CleanupItem) => (
    <Text key={`${item.action}:${item.id}`} style={muted}>
      {item.reason}
    </Text>
  );
  const note = settings ? keepTimeNote(settings.retentionDays) : null;

  return (
    <View style={{ gap: 16 }}>
      <View style={card} testID="cleanup-automatic">
        <Text style={heading}>Automatic clean-up</Text>
        <Text style={text}>Archive finished jobs</Text>
        <Text style={muted}>
          Moves a job to the archive when its work is done. Nothing is deleted.
        </Text>
        {settings ? (
          <View style={{ flexDirection: "row", gap: 8 }}>
            {choice("On", settings.archiveFinished, () => void save({ archiveFinished: true }))}
            {choice("Off", !settings.archiveFinished, () => void save({ archiveFinished: false }))}
          </View>
        ) : (
          <Text style={muted}>Loading…</Text>
        )}
        <Text style={text}>Close idle sessions after</Text>
        <Text style={muted}>
          Stops a session nobody is using. Its history stays, and it keeps owning its job.
        </Text>
        {settings && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {IDLE_CHOICES.map((option) =>
              choice(
                option.label,
                settings.idleMinutes === option.value,
                () => void save({ idleMinutes: option.value }),
              ),
            )}
          </View>
        )}
        {note && <Text style={text}>{note}</Text>}
      </View>

      <View style={card} testID="cleanup-now">
        <Text style={heading}>Clean up now</Text>
        <Text style={muted}>
          See what would be cleaned first. Nothing changes until you confirm, and each item is
          checked again before it is touched.
        </Text>
        {phase.kind === "preview" ? (
          <>
            {phase.partial && (
              <Text style={text}>Some work could not be checked, so this list may be short.</Text>
            )}
            {phase.items.length === 0 && <Text style={text}>Nothing to clean up right now.</Text>}
            {groupPlanned(phase.items).map((group) => (
              <View key={group.action} style={{ gap: 4 }}>
                <Text style={{ ...text, fontWeight: "600" }}>{group.title}</Text>
                {group.items.map(itemLine)}
              </View>
            ))}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {phase.items.length > 0 &&
                button(
                  busy
                    ? "Cleaning…"
                    : `Clean up ${phase.items.length === 1 ? "this item" : `these ${phase.items.length} items`}`,
                  () => void confirm(phase.previewId),
                )}
              {button(
                phase.items.length ? "Cancel" : "Close",
                () => setPhase({ kind: "idle" }),
                true,
              )}
            </View>
          </>
        ) : (
          button(busy ? "Checking…" : "Preview clean-up now", () => void preview())
        )}
        {phase.kind === "done" && (
          <View style={{ gap: 4 }}>
            <Text style={text}>{doneSummary(phase.items)}</Text>
            {phase.items.filter((item) => item.state !== "complete").map(itemLine)}
          </View>
        )}
        {!!message && (
          <Text accessibilityRole="alert" style={text}>
            {message}
          </Text>
        )}
      </View>
    </View>
  );
}
