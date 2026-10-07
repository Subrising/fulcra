import { useEffect, useRef, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, TextInput, View } from "react-native";
import { recoveryRpc, recoveryActionRpc, type RecoveryActionInput } from "../shared/recovery";
import { lastGood } from "./last-good";
import { bannerSeen, markBannerSeen } from "./recovery-seen";
import {
  bannerSummary,
  orderItems,
  recoveryCard,
  recoverySections,
  resumePreview,
  teamItems,
  type RecoveryItem,
  type RecoveryStatus,
} from "../shared/recovery-view.mjs";
// DESIGN-R R2: the Recovery banner and panel. Mounted once at the top of the Orca surface; renders nothing when
// there is nothing to recover. All wording comes from shared/recovery-view.mjs so it is tested there.
function messageId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}
export function RecoveryBanner({
  theme,
  navigation,
  host,
  titles = {},
  once = false,
}: Pick<PluginSurfaceProps, "theme" | "navigation"> & {
  host?: PluginSurfaceProps["host"];
  titles?: Record<string, string>;
  /** Top-of-page placement: show a restart the first time only; Home's activity keeps it after that. */
  once?: boolean;
}) {
  const read = useRpc(recoveryRpc),
    act = useRpc(recoveryActionRpc),
    c = theme.colors;
  const query = useQuery({
    queryKey: ["orca-recovery", host?.id],
    queryFn: () => read({}),
    staleTime: 10000,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [confirm, setConfirm] = useState<string | null>(null);
  const [reason, setReason] = useState(""),
    [note, setNote] = useState(""),
    [details, setDetails] = useState<string | null>(null);
  const lock = useRef(false),
    ids = useRef(new Map<string, string>());
  // J0: a failed or late read (it arrives as { status: "error" }) keeps the last observed recovery status,
  // memory only, with one plain notice. Actions stay disabled until a fresh observation arrives.
  const last = lastGood(query, ["orca-recovery", host?.id], {
    failure: (d) => (d.status === "error" ? (d.message ?? "error") : null),
  });
  const status =
    last.data?.status === "observed" ? (last.data.recovery as RecoveryStatus) : undefined;
  const fresh =
    !last.fromMemory &&
    !!query.data &&
    !query.isError &&
    query.data.status === "observed" &&
    Date.now() - Date.parse(query.data.observedAt) < 60000;
  const banner = bannerSummary(status);
  // Decided once per mount, so the banner stays put while this page is open and is gone the next time.
  const seenAtMount = useRef<Map<string, boolean>>(new Map());
  const signature = banner?.text ?? "";
  const seenKey = host?.id ?? "local";
  if (once && signature && !seenAtMount.current.has(signature))
    seenAtMount.current.set(signature, bannerSeen(seenKey, signature));
  useEffect(() => {
    if (once && signature) markBannerSeen(seenKey, signature);
  }, [once, seenKey, signature]);
  if (once && banner && seenAtMount.current.get(signature) && !open) return null;
  if (!banner)
    return query.data?.status === "error" && !last.fromMemory ? (
      <Text style={{ color: c.foregroundMuted }}>
        Recovery status is not available yet: {query.data.message}
      </Text>
    ) : null;
  const text = { color: c.foreground },
    muted = { color: c.foregroundMuted },
    field = {
      color: c.foreground,
      padding: 12,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
    };
  const button = (enabled: boolean) => ({
    padding: 10,
    borderRadius: 8,
    backgroundColor: enabled ? c.accent : c.surface2,
    opacity: enabled ? 1 : 0.6,
  });
  // One identity per intended action, retained across retries so a retry is the same request, not a second one.
  const idFor = (key: string) => {
    if (!ids.current.has(key)) ids.current.set(key, messageId());
    return ids.current.get(key)!;
  };
  async function run(input: RecoveryActionInput, key: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const r = await act(input);
      setNotice(r.message);
      if (r.status !== "error") ids.current.delete(key);
      setConfirm(null);
      await query.refetch();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const items = orderItems(status?.items ?? []),
    team = teamItems(items),
    reasonOk = reason.trim().length >= 12;
  return (
    <View
      style={{
        gap: 10,
        padding: 14,
        borderWidth: 1,
        borderColor: banner.severity === "attention" ? c.accent : c.border,
        borderRadius: 10,
      }}
    >
      <Pressable
        testID="recovery-details-toggle"
        accessibilityRole="button"
        accessibilityLabel={`Recovery: ${banner.text}. ${open ? "Hide" : "Show"} details`}
        onPress={() => setOpen(!open)}
      >
        <Text style={{ ...text, fontWeight: "600" }}>{banner.text}</Text>
        <Text style={muted}>
          {open ? "Hide recovery details" : "Show recovery details"}
          {last.notice ? ` · ${last.notice}` : fresh ? "" : " · may be out of date"}
        </Text>
      </Pressable>
      {open && (
        <>
          <TextInput
            accessibilityLabel="Recovery reason"
            editable={!busy}
            value={reason}
            onChangeText={setReason}
            maxLength={2000}
            placeholder="Reason, recorded with every action (at least 12 characters)"
            placeholderTextColor={c.foregroundMuted}
            style={field}
          />
          {team.length > 1 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Resume all resumable sessions, leaders first"
              disabled={!fresh || busy || !reasonOk}
              style={button(fresh && !busy && reasonOk)}
              onPress={() =>
                void run(
                  {
                    action: "resume-team",
                    messageId: idFor("team"),
                    reason,
                    items: team.map((t) => ({
                      ...t,
                      expectedGeneration: t.expectedGeneration ?? 0,
                    })),
                  },
                  "team",
                )
              }
            >
              <Text style={{ color: c.accentForeground }}>
                Resume team ({team.length}), leaders first
              </Text>
            </Pressable>
          )}
          {recoverySections(items).map((section) => (
            <View key={section.key} testID={`recovery-section-${section.key}`} style={{ gap: 6 }}>
              {section.title && (
                <Text style={{ ...muted, fontWeight: "600", paddingTop: 8 }}>{section.title}</Text>
              )}
              {section.items.map((x: RecoveryItem) => {
                const card = recoveryCard(x, { fresh, busy, titles }),
                  key = "resume:" + x.interruptionId;
                const unsettledId =
                  (status?.unsettled ?? []).find((d) => d.session === x.sessionId)?.id ?? null;
                return (
                  <View
                    key={card.key}
                    style={{ gap: 6, padding: 10, borderTopWidth: 1, borderColor: c.border }}
                  >
                    <Text style={{ ...text, fontWeight: "600" }}>
                      {card.title}
                      {card.leader ? " · leads other sessions" : ""} · {card.chip}
                    </Text>
                    <Text testID={`recovery-headline-${card.key}`} style={text}>
                      {card.headline} {card.turn}
                    </Text>
                    <Text
                      testID={`recovery-next-${card.key}`}
                      style={{ ...text, fontWeight: "600" }}
                    >
                      Next: {card.nextStep}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${details === card.key ? "Hide" : "Show"} details for ${card.title}`}
                      onPress={() => setDetails(details === card.key ? null : card.key)}
                    >
                      <Text style={{ color: c.accent }}>
                        {details === card.key
                          ? "Hide details"
                          : "Show details (ids, last instruction, working tree)"}
                      </Text>
                    </Pressable>
                    {details === card.key && (
                      <View testID={`recovery-details-${card.key}`} style={{ gap: 4 }}>
                        {card.details.map((d) => (
                          <Text key={d} selectable style={muted}>
                            {d}
                          </Text>
                        ))}
                        <Text style={muted}>{card.doing.label}</Text>
                        {card.doing.text && (
                          <Text selectable style={text}>
                            {card.doing.text}
                          </Text>
                        )}
                        {card.work.map((w) => (
                          <Text key={w} selectable style={muted}>
                            {w}
                          </Text>
                        ))}
                        <Text style={muted}>{card.workNote}</Text>
                        <Text style={muted}>{card.why}</Text>
                      </View>
                    )}
                    {confirm === x.interruptionId && (
                      <View style={{ gap: 4 }}>
                        {resumePreview(x, note).map((line) => (
                          <Text key={line} style={muted}>
                            • {line}
                          </Text>
                        ))}
                        <TextInput
                          accessibilityLabel="Optional operator note for the continuation"
                          editable={!busy}
                          value={note}
                          onChangeText={setNote}
                          maxLength={4000}
                          multiline
                          placeholder="Optional note appended to the continuation"
                          placeholderTextColor={c.foregroundMuted}
                          style={field}
                        />
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Confirm resume of ${card.title}`}
                          disabled={!card.actions.resume.enabled || !reasonOk}
                          style={button(card.actions.resume.enabled && reasonOk)}
                          onPress={() =>
                            void run(
                              {
                                action: "resume",
                                messageId: idFor(key),
                                sessionId: x.sessionId,
                                interruptionId: x.interruptionId,
                                expectedGeneration: x.generation ?? 0,
                                reason,
                                ...(note.trim() ? { continuation: note } : {}),
                              },
                              key,
                            )
                          }
                        >
                          <Text style={{ color: c.accentForeground }}>Confirm resume</Text>
                        </Pressable>
                      </View>
                    )}
                    <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Resume ${card.title}`}
                        accessibilityHint={card.actions.resume.reason ?? undefined}
                        disabled={!card.actions.resume.enabled}
                        style={button(card.actions.resume.enabled)}
                        onPress={() =>
                          setConfirm(confirm === x.interruptionId ? null : x.interruptionId)
                        }
                      >
                        <Text style={{ color: c.accentForeground }}>Resume</Text>
                      </Pressable>
                      {x.state === "needs-reconcile" && unsettledId && (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Reconcile the unsettled delivery of ${card.title}`}
                          disabled={!card.actions.reconcile.enabled}
                          style={button(card.actions.reconcile.enabled)}
                          onPress={() =>
                            void run(
                              { action: "reconcile", messageId: unsettledId },
                              "reconcile:" + x.interruptionId,
                            )
                          }
                        >
                          <Text style={{ color: c.accentForeground }}>Reconcile</Text>
                        </Pressable>
                      )}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Dismiss the interruption of ${card.title}; the session stays under human control`}
                        disabled={!card.actions.dismiss.enabled || !reasonOk}
                        style={button(card.actions.dismiss.enabled && reasonOk)}
                        onPress={() =>
                          void run(
                            { action: "dismiss", interruptionId: x.interruptionId, reason },
                            "dismiss:" + x.interruptionId,
                          )
                        }
                      >
                        <Text style={{ color: c.accentForeground }}>Dismiss</Text>
                      </Pressable>
                      {navigation && (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Open conversation for ${card.title}`}
                          style={button(true)}
                          onPress={() => navigation.openAgent({ agentId: x.sessionId })}
                        >
                          <Text style={{ color: c.accentForeground }}>Open conversation</Text>
                        </Pressable>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          ))}
          {(status?.unsettled ?? [])
            .filter((d) => d.needsHuman)
            .map((d) => (
              <View
                key={d.id}
                style={{ gap: 4, padding: 10, borderTopWidth: 1, borderColor: c.border }}
              >
                <Text style={text}>
                  Delivery {d.id} is still {d.state}: the host has no completed receipt for it.
                </Text>
                <Text style={muted}>
                  It is never abandoned automatically. Reconcile it, or record an evidence-backed
                  disposition in Manage task, after checking the session.
                </Text>
              </View>
            ))}
          {!!notice && <Text style={text}>{notice}</Text>}
          <Text style={muted}>{status?.note}</Text>
        </>
      )}
    </View>
  );
}
