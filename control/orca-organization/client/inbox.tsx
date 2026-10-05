import { useEffect, useRef, useState, type ReactNode } from "react";
import { inboxHeadline, humanInboxItems } from "./inbox-model";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import {
  inboxRpc,
  decisionRpc,
  decisionChooseRpc,
  heldMessageRpc,
  heldReadRpc,
  heldReplyRpc,
  heldReleaseRpc,
  digestRpc,
  type InboxItem,
  type DecisionPacket,
} from "../shared/cc/decision";
import { outcomeRpc } from "../shared/outcomes";
import { answerSummary } from "../shared/cc/channel-text.mjs";

/**
 * Fulcra › Inbox (J3; CONTRACTS.md §3.4, CC-PLAN §5). One list, grouped Decisions, Approvals, Held messages
 * and Digest, written for someone with a minute between meetings.
 *
 * Everything here is a view. The controller decides whether a choice counts: this card sends the revision
 * it showed, and a packet that moved since is refused with "Changed since you looked; refresh", which the
 * card shows rather than retrying. A destructive option takes a second tap, and the server refuses it
 * without that confirmation anyway. Colours come from the theme only, so dark and light both work.
 */
type Theme = PluginSurfaceProps["theme"];
type Colors = Theme["colors"];
const GROUPS = [
  // v1.8 R2-4: device pairings and revocations are security alerts, shown first.
  {
    id: "security",
    title: "Security",
    match: (i: InboxItem) => i.key.startsWith("attention-device-"),
  },
  {
    id: "decisions",
    title: "Decisions",
    match: (i: InboxItem) =>
      (i.source === "decision" && !i.key.startsWith("approval-")) || i.source === "outcome",
  },
  { id: "approvals", title: "Approvals", match: (i: InboxItem) => i.key.startsWith("approval-") },
  { id: "held", title: "Held messages", match: (i: InboxItem) => i.source === "held" },
  {
    id: "digest",
    title: "Digest",
    match: (i: InboxItem) =>
      i.source === "digest" || (i.source === "attention" && !i.key.startsWith("attention-device-")),
  },
] as const;
const URGENCY = { now: "Now", today: "Today", fyi: "FYI" } as const;
// R-J3-12: idempotency keys from the platform CSPRNG (Hermes, browsers and Electron all provide it).
function newId() {
  return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
}
// CONTRACTS v1.2 §3.3: which app answered. The host reports ios, android or web; the desktop app is a web
// view inside Electron, told apart by its user agent, and its OS read from the same string. Unknown → app-mac.
export type AppVia =
  | "app-mac"
  | "app-ios"
  | "app-android"
  | "app-windows"
  | "app-linux"
  | "app-web";
export function viaFor(
  platform: string | undefined,
  userAgent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "",
): AppVia {
  if (platform === "ios") return "app-ios";
  if (platform === "android") return "app-android";
  if (platform !== "web") return "app-mac";
  if (!/Electron\//.test(userAgent)) return "app-web";
  return /Windows/.test(userAgent)
    ? "app-windows"
    : /Linux|X11/.test(userAgent) && !/Android/.test(userAgent)
      ? "app-linux"
      : "app-mac";
}
// v1.8 R2-3/R2-7: the same wording as the list, the digest and every chat ("You decided on iPhone at 09:14: …" or
// "Answered by the operator at 09:14, not confirmed on your device: …").
export function answeredBy(
  choice: { by: string; proven: boolean; via: string; at: string },
  optionTitle?: string,
) {
  return answerSummary(choice, optionTitle);
}
export function ago(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  return m < 1
    ? "just now"
    : m < 60
      ? `${m} min ago`
      : m < 48 * 60
        ? `${Math.round(m / 60)} h ago`
        : `${Math.round(m / 1440)} days ago`;
}
/** Elapsed time is presentation only; never reinterpret the controller's stored urgency. */
export function waitingTime(iso: string, now = Date.now()) {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return "Waiting time unavailable";
  const minutes = Math.max(0, Math.floor(elapsed / 60000));
  if (minutes < 1) return "Waiting less than 1 min";
  if (minutes < 60) return `Waiting ${minutes} min`;
  if (minutes < 1440) return `Waiting ${Math.floor(minutes / 60)} h`;
  const days = Math.floor(minutes / 1440);
  return `Waiting ${days} ${days === 1 ? "day" : "days"}`;
}
function itemLabel(item: InboxItem) {
  return item.source === "held" ? waitingTime(item.createdAt) : URGENCY[item.urgency];
}
function Button({
  theme,
  label,
  onPress,
  testID,
  primary,
  danger,
  disabled,
  children,
}: {
  theme: Theme;
  label: string;
  onPress: () => void;
  testID?: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const c = theme.colors,
    fill = danger ? c.statusDanger : primary ? c.accent : c.surface1;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 44,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 12,
        justifyContent: "center",
        alignItems: "center",
        opacity: disabled ? 0.5 : 1,
        backgroundColor: fill,
        borderWidth: primary || danger ? 0 : 1,
        borderColor: c.border,
      }}
    >
      {children ?? (
        <Text
          style={{
            color: primary || danger ? c.accentForeground : c.foreground,
            fontWeight: "600",
            fontSize: 15,
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}
function Badge({ colors, item }: { colors: Colors; item: InboxItem }) {
  const urgency = item.urgency;
  const tone =
    item.source === "held"
      ? colors.foregroundMuted
      : urgency === "now"
        ? colors.statusDanger
        : urgency === "today"
          ? colors.statusWarning
          : colors.foregroundMuted;
  return (
    <View
      style={{
        borderRadius: 999,
        borderWidth: 1,
        borderColor: tone,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <Text style={{ color: tone, fontSize: 12, fontWeight: "700" }}>{itemLabel(item)}</Text>
    </View>
  );
}
function Notice({
  colors,
  tone,
  children,
}: {
  colors: Colors;
  tone: "warning" | "danger" | "success";
  children: ReactNode;
}) {
  const c =
    tone === "danger"
      ? colors.statusDanger
      : tone === "warning"
        ? colors.statusWarning
        : colors.statusSuccess;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        borderLeftWidth: 3,
        borderLeftColor: c,
        backgroundColor: colors.surface2,
        padding: 10,
        borderRadius: 8,
      }}
    >
      <Text style={{ color: colors.foreground }}>{children}</Text>
    </View>
  );
}

export function heldSender(item: InboxItem): string {
  return item.ref ?? item.projectId ?? item.key.slice(5, 41);
}

export function InboxSurface({
  theme,
  layout,
  host,
}: Pick<PluginSurfaceProps, "theme" | "layout" | "host">) {
  const read = useContract(inboxRpc),
    c = theme.colors;
  const query = useQuery({
    queryKey: ["orca-organization", "inbox"],
    queryFn: () => read({}),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const [allActivity, setAllActivity] = useState(false);
  const [senders, setSenders] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);
  const d = query.data,
    items = d?.items ?? [];
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const attention = humanInboxItems(d, now, query.error);
  const pad = layout.compact ? 12 : 24;
  const head = inboxHeadline(d, query.isPending, query.error);
  const renderItem = (item: InboxItem) => (
    <View
      key={item.key}
      style={{
        borderWidth: 1,
        borderColor: open === item.key ? c.accent : c.border,
        borderRadius: 14,
        backgroundColor: c.surface1,
        overflow: "hidden",
      }}
    >
      <Pressable
        testID={`inbox-item-${item.key}`}
        accessibilityRole="button"
        accessibilityLabel={`${itemLabel(item)}: ${item.title}`}
        accessibilityState={{ expanded: open === item.key }}
        onPress={() => setOpen(open === item.key ? null : item.key)}
        style={{ padding: 14, gap: 6 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Badge colors={c} item={item} />
          {item.unread && (
            <View
              accessibilityLabel="Unread"
              style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.accent }}
            />
          )}
          <Text style={{ color: c.foregroundMuted, fontSize: 12, marginLeft: "auto" }}>
            {ago(item.createdAt)}
          </Text>
        </View>
        <Text
          style={{ color: c.foreground, fontSize: 17, fontWeight: item.unread ? "700" : "600" }}
        >
          {item.title}
        </Text>
        {open !== item.key && (
          <Text numberOfLines={2} style={{ color: c.foregroundMuted }}>
            {item.source === "held"
              ? `${item.summary.split(" Open it to")[0]} Open in Fulcra.`
              : item.summary}
          </Text>
        )}
      </Pressable>
      {open === item.key && (
        <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 12 }}>
          <ItemCard
            item={item}
            theme={theme}
            via={viaFor(layout.platform)}
            onChanged={() => {
              void query.refetch();
            }}
          />
        </View>
      )}
    </View>
  );
  return (
    <ScrollView
      testID="inbox-list"
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{
        padding: pad,
        gap: 16,
        maxWidth: 760,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <View style={{ gap: 4 }}>
        <Text
          accessibilityRole="header"
          style={{ color: c.foreground, fontSize: 26, fontWeight: "700" }}
        >
          Inbox
        </Text>
        <Text
          testID="inbox-headline"
          style={{
            color: head.failed ? c.foreground : c.foregroundMuted,
            fontWeight: head.failed ? "600" : "400",
          }}
        >
          {query.isPending || head.failed
            ? head.text
            : attention.confirmed.length
              ? `${attention.confirmed.length} open ${attention.confirmed.length === 1 ? "decision is" : "decisions are"} addressed to you`
              : "No confirmed unresolved decision is addressed to you in this observation."}
        </Text>
        <Text style={{ color: c.foregroundMuted }}>
          Source: {host?.label ?? "Selected company organisation"}. Inbox-only scope; Today also
          includes role and runtime needs.
          {d
            ? ` ${d.counts.held} held messages remain retained; reading them does not release or acknowledge them.`
            : ""}
        </Text>
      </View>
      {head.failed && (
        <Notice colors={c} tone="warning">
          {head.problem ? `${head.problem} ` : ""}
          {head.missing.length ? `Could not be read: ${head.missing.join(", ")}. ` : ""}
          {d && (d.stale || query.isError) ? `Last read ${ago(d.observedAt)}. ` : ""}
          {head.canRetry && (
            <Text
              testID="inbox-retry"
              accessibilityRole="button"
              onPress={() => {
                void query.refetch();
              }}
              style={{ color: c.accent, fontWeight: "700" }}
            >
              {query.isFetching ? "Trying again…" : "Try again"}
            </Text>
          )}
        </Notice>
      )}
      <View style={{ gap: 10 }} testID="inbox-personal-decisions">
        {query.isError && attention.confirmed.length > 0 && (
          <Text style={{ color: c.foregroundMuted }}>
            Last-known open decisions; current status could not be checked.
          </Text>
        )}
        {(allActivity ? attention.confirmed : attention.confirmed.slice(0, 3)).map(renderItem)}
        {!allActivity && attention.confirmed.length > 3 && (
          <Text style={{ color: c.foregroundMuted }}>
            More open decisions are available in All activity.
          </Text>
        )}
        {attention.unknown && (
          <Text style={{ color: c.foregroundMuted }}>
            Some sources are unavailable or incomplete; other personal actions cannot be ruled out.
          </Text>
        )}
      </View>
      <Button
        theme={theme}
        label={
          allActivity
            ? "Hide all activity and history"
            : `All activity and history (${attention.total} records)`
        }
        onPress={() => setAllActivity((value) => !value)}
      />
      <Text style={{ color: c.foregroundMuted }}>
        {attention.retained.length} held updates are retained separately. A held report is not
        automatically a decision for you.
      </Text>
      {allActivity &&
        GROUPS.map((g) => {
          const rows = attention.other.filter(g.match);
          if (g.id === "held")
            rows.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
          if (!rows.length) return null;
          return (
            <View key={g.id} style={{ gap: 8 }}>
              <Text
                accessibilityRole="header"
                style={{
                  color: c.foregroundMuted,
                  fontSize: 13,
                  fontWeight: "700",
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                }}
              >
                {g.title} · {rows.length}
              </Text>
              {g.id === "held"
                ? [...new Set(rows.map(heldSender))].map((sender) => {
                    const group = rows.filter((item) => heldSender(item) === sender),
                      expanded = !!senders[sender];
                    const name =
                      /^From (.+?)\. Sent /.exec(group[0].summary)?.[1] ?? "a project lead";
                    return (
                      <View key={sender} style={{ gap: 8 }}>
                        <Pressable
                          testID={`inbox-sender-${sender}`}
                          accessibilityRole="button"
                          accessibilityState={{ expanded }}
                          accessibilityLabel={`${expanded ? "Hide" : "Show"} ${group.length} held messages from ${name}`}
                          onPress={() => setSenders({ ...senders, [sender]: !expanded })}
                          style={{
                            minHeight: 44,
                            padding: 12,
                            borderWidth: 1,
                            borderColor: c.border,
                            borderRadius: 12,
                          }}
                        >
                          <Text style={{ color: c.foreground, fontWeight: "600" }}>
                            {expanded ? "▾" : "▸"} {name} · {group.length} held messages
                          </Text>
                        </Pressable>
                        {expanded && group.map(renderItem)}
                      </View>
                    );
                  })
                : rows.map(renderItem)}
            </View>
          );
        })}
      {d && !items.length && (
        <Text style={{ color: c.foregroundMuted }}>
          When a project needs a decision from you, it appears here.
        </Text>
      )}
    </ScrollView>
  );
}
function ItemCard({
  item,
  theme,
  via,
  onChanged,
}: {
  item: InboxItem;
  theme: Theme;
  via: AppVia;
  onChanged: () => void;
}) {
  const id = item.ref?.split(":")[1] ?? "";
  if (item.source === "decision")
    return <DecisionCard id={id} theme={theme} via={via} onChanged={onChanged} />;
  if (item.source === "outcome") return <OutcomeCard taskId={id} theme={theme} />;
  if (item.source === "held") {
    const [, channelId, messageId] = /^held-([0-9a-f-]{36})-([0-9a-f-]{36})$/.exec(item.key) ?? [];
    return (
      <HeldCard channelId={channelId} messageId={messageId} theme={theme} onChanged={onChanged} />
    );
  }
  if (item.source === "digest")
    return <DigestCard id={item.key.slice("digest-".length)} theme={theme} />;
  return <Text style={{ color: theme.colors.foreground }}>{item.summary}</Text>;
}

// The decision card: situation, the recommendation on top, 2–3 options each with its example, one tap to
// choose the recommendation, a second tap for anything destructive, and Details for the evidence and ids.
export function DecisionCard({
  id,
  theme,
  via = "app-mac",
  onChanged,
}: {
  id: string;
  theme: Theme;
  via?: AppVia;
  onChanged: () => void;
}) {
  const read = useContract(decisionRpc),
    choose = useContract(decisionChooseRpc),
    c = theme.colors;
  const query = useQuery({
    queryKey: ["orca-organization", "decision", id],
    queryFn: () => read({ id }),
    retry: false,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false),
    [details, setDetails] = useState(false);
  const [note, setNote] = useState(""),
    [result, setResult] = useState<{ ok: boolean; message: string | null } | null>(null);
  const identity = useRef<{ key: string; id: string } | null>(null);
  const p = query.data?.decision;
  if (!p)
    return (
      <Text style={{ color: c.foregroundMuted }}>
        {query.isPending ? "Opening…" : (query.data?.error ?? "This decision could not be read.")}
      </Text>
    );
  const recommended = p.options.find((o) => o.id === p.recommendation?.optionId) ?? null;
  const pick = selected ?? recommended?.id ?? p.options[0]?.id ?? "answer";
  const option = p.options.find((o) => o.id === pick) ?? null;
  const changed = result && !result.ok && /Changed since you looked/.test(result.message ?? "");
  const submit = async () => {
    if (option?.destructive && !confirming) {
      setConfirming(true);
      return;
    }
    const key = `${p.id}:${p.revision}:${pick}:${note}`;
    if (identity.current?.key !== key) identity.current = { key, id: newId() };
    setBusy(true);
    try {
      const r = await choose({
        messageId: identity.current.id,
        id: p.id,
        expectedRevision: p.revision,
        optionId: pick,
        note: note.trim(),
        confirmDestructive: confirming,
        via,
      });
      setResult({ ok: r.ok, message: r.message });
      setConfirming(false);
      if (r.ok) {
        onChanged();
        void query.refetch();
      }
    } catch {
      setResult({
        ok: false,
        message:
          "Connection unavailable; your choice may not have been recorded. Refresh to check.",
      });
    } finally {
      setBusy(false);
    }
  };
  const chosen = p.options.find((o) => o.id === p.choice?.optionId);
  // v1.6: an approval that starts work needs the owner's paired-device proof; this build cannot sign one yet (J5b).
  const bound = p.action.type !== "none";
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: c.foreground, fontSize: 15, lineHeight: 22 }}>{p.situation}</Text>
      {p.state === "chosen" && p.choice && (
        <Notice colors={c} tone={p.choice.proven ? "success" : "warning"}>
          {answeredBy(p.choice, chosen?.title ?? "your written answer")}
          {p.choice.note ? ` — “${p.choice.note}”` : ""}
        </Notice>
      )}
      {p.state !== "open" && p.state !== "chosen" && (
        <Notice colors={c} tone="warning">
          {p.state === "withdrawn"
            ? "The asker withdrew this question."
            : p.state === "superseded"
              ? "This was replaced by a newer question."
              : "This expired without an answer."}
        </Notice>
      )}
      {changed && (
        <Notice colors={c} tone="warning">
          Changed since you looked.{" "}
          <Text
            accessibilityRole="button"
            onPress={() => {
              setResult(null);
              setSelected(null);
              void query.refetch();
            }}
            style={{ color: c.accent, fontWeight: "700" }}
          >
            Refresh
          </Text>
        </Notice>
      )}
      {result && !result.ok && !changed && (
        <Notice colors={c} tone="danger">
          {result.message}
        </Notice>
      )}
      {result?.ok && result.message && (
        <Notice colors={c} tone="warning">
          {result.message}
        </Notice>
      )}
      {recommended && p.recommendation && (
        <View style={{ gap: 4, padding: 12, borderRadius: 12, backgroundColor: c.surface2 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "700" }}>
            RECOMMENDED · {p.recommendation.confidence} confidence
          </Text>
          <Text style={{ color: c.foreground, fontWeight: "700", fontSize: 16 }}>
            {recommended.title}
          </Text>
          <Text style={{ color: c.foreground }}>{p.recommendation.why}</Text>
        </View>
      )}
      {p.options.map((o) => {
        const on = pick === o.id;
        return (
          <Pressable
            key={o.id}
            testID={`decision-option-${o.id}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled: p.state !== "open" }}
            disabled={p.state !== "open"}
            accessibilityLabel={`${o.title}${o.id === recommended?.id ? ", recommended" : ""}${o.destructive ? ", hard to undo" : ""}`}
            onPress={() => {
              setSelected(o.id);
              setConfirming(false);
            }}
            style={{
              gap: 6,
              padding: 12,
              borderRadius: 12,
              borderWidth: on ? 2 : 1,
              borderColor: on ? c.accent : c.border,
              backgroundColor: c.surface0,
            }}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <Text style={{ color: c.foreground, fontWeight: "700", fontSize: 16, flexShrink: 1 }}>
                {o.title}
              </Text>
              {o.id === recommended?.id && (
                <Text style={{ color: c.statusSuccess, fontSize: 12, fontWeight: "700" }}>
                  Recommended
                </Text>
              )}
              {o.destructive && (
                <Text style={{ color: c.statusDanger, fontSize: 12, fontWeight: "700" }}>
                  Hard to undo
                </Text>
              )}
            </View>
            <Text style={{ color: c.foreground }}>{o.summary}</Text>
            {o.example && (
              <Text style={{ color: c.foregroundMuted, fontStyle: "italic" }}>{o.example}</Text>
            )}
          </Pressable>
        );
      })}
      {p.state === "open" && bound && (
        <Notice colors={c} tone="warning">
          Confirm this on your paired device. Pairing arrives with the next Fulcra update; until
          then this approval waits.
        </Notice>
      )}
      {p.state === "open" && !bound && (
        <>
          <TextInput
            accessibilityLabel="Add a note (optional)"
            placeholder={p.options.length ? "Add a note (optional)" : "Write your answer"}
            placeholderTextColor={c.foregroundMuted}
            value={note}
            onChangeText={setNote}
            maxLength={500}
            multiline
            style={{
              minHeight: 44,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 12,
              padding: 10,
              color: c.foreground,
              backgroundColor: c.surface0,
            }}
          />
          {confirming && (
            <Notice colors={c} tone="danger">
              “{option?.title}” is hard to undo. Tap again to confirm.
            </Notice>
          )}
          <Button
            testID="decision-choose"
            theme={theme}
            primary={!confirming}
            danger={confirming}
            disabled={busy || (!p.options.length && !note.trim())}
            label={
              busy
                ? "Sending…"
                : confirming
                  ? `Yes, choose ${option?.title}`
                  : option
                    ? `Choose ${option.title}`
                    : "Send answer"
            }
            onPress={() => {
              void submit();
            }}
          />
        </>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: details }}
        onPress={() => setDetails(!details)}
      >
        <Text style={{ color: c.accent, fontWeight: "600" }}>
          {details ? "Hide details" : "Details"}
        </Text>
      </Pressable>
      {details && <Details p={p} evidence={query.data?.evidence ?? []} colors={c} />}
    </View>
  );
}
function Details({
  p,
  evidence,
  colors: c,
}: {
  p: DecisionPacket;
  evidence: { ref: string; label: string; kind: string }[];
  colors: Colors;
}) {
  const line = (label: string, value: string) => (
    <Text key={label} selectable style={{ color: c.foregroundMuted, fontSize: 13 }}>
      <Text style={{ fontWeight: "700" }}>{label}: </Text>
      {value}
    </Text>
  );
  return (
    <View style={{ gap: 6, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border }}>
      {p.options.map((o) =>
        line(
          o.title,
          `Benefit: ${o.impacts.benefit}. Cost: ${o.impacts.cost}. Time: ${o.impacts.time}. Risk: ${o.impacts.risk}. ${o.impacts.reversibility === "irreversible" ? "Cannot be undone." : o.impacts.reversibility === "reversible-with-effort" ? "Can be undone with effort." : "Can be undone."}`,
        ),
      )}
      {p.recommendation && line("Would change if", p.recommendation.wouldChangeIf)}
      {evidence.map((e) => line(e.label, e.ref))}
      {line(
        "Asked by",
        p.askedBy.system
          ? `Fulcra (${p.askedBy.system})${p.askedBy.seat ? ` for seat ${p.askedBy.seat}` : ""}`
          : p.askedBy.seat
            ? `seat ${p.askedBy.seat}`
            : `session ${p.askedBy.sessionId}`,
      )}
      {line("Decision", `${p.id} · revision ${p.revision} · level ${p.level} · ${p.kind}`)}
      {p.action.type !== "none" &&
        line("Bound action", `${p.action.type} · digest ${p.action.digest}`)}
      {p.delivery &&
        line(
          "Answer delivered",
          `${p.delivery.state} after ${p.delivery.attempts} attempt${p.delivery.attempts === 1 ? "" : "s"}`,
        )}
    </View>
  );
}
// §3.3 legacy adapter: shown, never answerable here.
function OutcomeCard({ taskId, theme }: { taskId: string; theme: Theme }) {
  const read = useContract(outcomeRpc),
    c = theme.colors;
  const query = useQuery({
    queryKey: ["orca-organization", "outcome", taskId],
    queryFn: () => read({ taskId }),
    retry: false,
  });
  const r = query.data?.record;
  return (
    <View style={{ gap: 10 }}>
      <Notice colors={c} tone="warning">
        Answer in the conversation. This older kind of decision cannot be answered from the inbox.
      </Notice>
      {r?.coordination?.decisionNeeded && (
        <Text style={{ color: c.foreground }}>{r.coordination.decisionNeeded}</Text>
      )}
      {r?.alternatives.map((a) => (
        <View
          key={a.id}
          style={{ gap: 4, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border }}
        >
          <Text style={{ color: c.foreground, fontWeight: "700" }}>{a.title}</Text>
          <Text style={{ color: c.foreground }}>{a.change}</Text>
          <Text style={{ color: c.foregroundMuted, fontStyle: "italic" }}>{a.example}</Text>
        </View>
      ))}
      {!r && (
        <Text style={{ color: c.foregroundMuted }}>
          {query.isPending ? "Opening…" : "The published record could not be read."}
        </Text>
      )}
    </View>
  );
}
// A held message: the body only on open, as another seat's words. Read, reply once, or release the hold.
export function HeldCard({
  channelId,
  messageId,
  theme,
  onChanged,
}: {
  channelId?: string;
  messageId?: string;
  theme: Theme;
  onChanged: () => void;
}) {
  const read = useContract(heldMessageRpc),
    markRead = useContract(heldReadRpc),
    reply = useContract(heldReplyRpc),
    release = useContract(heldReleaseRpc),
    c = theme.colors;
  const query = useQuery({
    queryKey: ["orca-organization", "held", channelId, messageId],
    queryFn: () => read({ channelId: channelId!, messageId: messageId! }),
    enabled: !!channelId && !!messageId,
    retry: false,
  });
  const [text, setText] = useState(""),
    [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null),
    [busy, setBusy] = useState(false),
    [releasing, setReleasing] = useState(false);
  const replyId = useRef<{ text: string; id: string } | null>(null);
  const m = query.data?.message;
  if (!m)
    return (
      <Text style={{ color: c.foregroundMuted }}>
        {query.isPending ? "Opening…" : (query.data?.error ?? "This message could not be read.")}
      </Text>
    );
  const act = async (run: () => Promise<{ ok: boolean; message: string | null }>, done: string) => {
    setBusy(true);
    try {
      const r = await run();
      setNotice({ ok: r.ok, message: r.ok ? done : (r.message ?? "Refused") });
      if (r.ok) {
        onChanged();
        void query.refetch();
      }
    } catch {
      setNotice({
        ok: false,
        message: "Connection unavailable; nothing was confirmed. Refresh to check.",
      });
    } finally {
      setBusy(false);
    }
  };
  const send = () => {
    if (replyId.current?.text !== text) replyId.current = { text, id: newId() };
    void act(
      () =>
        reply({
          channelId: m.channelId,
          inReplyTo: m.messageId,
          messageId: replyId.current!.id,
          text: text.trim(),
          expectedSeatRevision: m.pins!.seatRevision,
          expectedHolderGeneration: m.pins!.holderGeneration,
        }),
      "Reply sent.",
    );
  };
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{m.note}</Text>
      <View
        style={{
          padding: 12,
          borderRadius: 12,
          backgroundColor: c.surface0,
          borderWidth: 1,
          borderColor: c.border,
        }}
      >
        <Text selectable style={{ color: c.foreground, lineHeight: 21 }}>
          {m.untrustedText}
        </Text>
      </View>
      {notice && (
        <Notice colors={c} tone={notice.ok ? "success" : "danger"}>
          {notice.message}
        </Notice>
      )}
      {m.reply && (
        <Notice colors={c} tone="success">
          You replied {ago(m.reply.at)} ({m.reply.state}).
        </Notice>
      )}
      {!m.read && (
        <Button
          theme={theme}
          label="Mark as read"
          disabled={busy}
          onPress={() => {
            void act(
              () => markRead({ channelId: m.channelId, messageId: m.messageId }),
              "Marked as read.",
            );
          }}
        />
      )}
      {m.canReply && m.pins ? (
        <>
          <TextInput
            accessibilityLabel="Reply"
            placeholder="Reply to this message"
            placeholderTextColor={c.foregroundMuted}
            value={text}
            onChangeText={setText}
            maxLength={4000}
            multiline
            style={{
              minHeight: 64,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 12,
              padding: 10,
              color: c.foreground,
              backgroundColor: c.surface0,
            }}
          />
          <Button
            theme={theme}
            primary
            label={busy ? "Sending…" : "Send reply"}
            disabled={busy || !text.trim()}
            onPress={send}
          />
        </>
      ) : (
        <Text style={{ color: c.foregroundMuted }}>Open in Fulcra</Text>
      )}
      {m.canRelease &&
        m.pins &&
        (releasing ? (
          <Button
            theme={theme}
            danger
            label="Yes, release the hold"
            disabled={busy}
            onPress={() => {
              void act(
                () =>
                  release({
                    channelId: m.channelId,
                    messageId: m.messageId,
                    expectedSeatRevision: m.pins!.seatRevision,
                  }),
                "Hold released. New messages go to the seat directly.",
              );
              setReleasing(false);
            }}
          />
        ) : (
          <Button
            theme={theme}
            label="Release hold"
            disabled={busy}
            onPress={() => setReleasing(true)}
          />
        ))}
    </View>
  );
}
export function DigestCard({ id, theme }: { id: string; theme: Theme }) {
  const read = useContract(digestRpc),
    c = theme.colors;
  const query = useQuery({
    queryKey: ["orca-organization", "digest", id],
    queryFn: () => read({ id }),
    retry: false,
  });
  const d = query.data?.digest;
  if (!d)
    return (
      <Text style={{ color: c.foregroundMuted }}>
        {query.isPending ? "Opening…" : (query.data?.error ?? "This digest could not be read.")}
      </Text>
    );
  const section = (title: string, lines: string[]) =>
    lines.length ? (
      <View key={title} style={{ gap: 4 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "700" }}>
          {title.toUpperCase()}
        </Text>
        {lines.map((l, i) => (
          <Text key={i} style={{ color: c.foreground }}>
            • {l}
          </Text>
        ))}
      </View>
    ) : null;
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>
        {d.brief?.headline ?? d.noUpdate}
      </Text>
      {d.healthChange && (
        <Text style={{ color: c.foreground }}>
          Health changed from {d.healthChange.from} to {d.healthChange.to}.
        </Text>
      )}
      {section(
        "Waiting for you",
        d.decisions.open.map((o) => o.title),
      )}
      {section(
        "You decided",
        d.decisions.chosen
          .filter((o) => o.by === "human" && o.proven)
          .map((o) => `${o.title}: ${o.optionTitle}`),
      )}
      {section(
        "Answered by the operator, not confirmed on your device",
        d.decisions.chosen
          .filter((o) => !(o.by === "human" && o.proven))
          .map((o) => `${o.title}: ${o.optionTitle}`),
      )}
      {section(
        "Shipped",
        d.shipped.map((s) => s.text),
      )}
      {d.held &&
        section("Held messages", [
          d.held.waiting ? `${d.held.waiting} waiting to be read` : "None waiting",
        ])}
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        Covers {new Date(d.periodStart).toLocaleString()} to{" "}
        {new Date(d.periodEnd).toLocaleString()}. Composed by Fulcra from its own records; nothing
        was sent anywhere.
      </Text>
    </View>
  );
}
