import { useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useContract } from "./use-contract";
import {
  remitAssignRpc,
  remitMoveRpc,
  remitEndRpc,
  type RemitsView,
  type Owner,
} from "../shared/cc/remit";
import { Button, Notice, SectionTitle, newId, type Theme } from "./organisation-ui";
import { historyLines, primeName, relativeTime } from "./organisation-model";

/**
 * Edit remit (CONTRACTS §5): move a project to another prime, with a reason, and see the history. A project with
 * its own remit is moved (one step, one history event); a project with no prime, or owned only through its area,
 * gets its own remit. The controller checks everything again, so a change made elsewhere since this sheet was
 * opened is refused with "Changed since you looked; refresh", shown here as it is.
 */
const MIN = 12,
  MAX = 500;
export function RemitSheet({
  project,
  remits,
  theme,
  onClose,
  onChanged,
}: {
  project: { projectId: string; name: string; owner: Owner };
  remits: RemitsView | undefined;
  theme: Theme;
  onClose: () => void;
  onChanged: () => void;
}) {
  const c = theme.colors,
    text = { color: c.foreground, lineHeight: 22 },
    muted = { color: c.foregroundMuted, lineHeight: 20 };
  const assign = useContract(remitAssignRpc),
    move = useContract(remitMoveRpc),
    end = useContract(remitEndRpc);
  const [prime, setPrime] = useState<string | null>(null),
    [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  // One identity per intended change: a retry of the same change reuses it, a different change gets a new one.
  const attempt = useRef({ key: "", id: newId() });
  const idFor = (key: string) => {
    if (attempt.current.key !== key) attempt.current = { key, id: newId() };
    return attempt.current.id;
  };
  const own =
    project.owner.kind === "project"
      ? (remits?.remits.find((r) => r.id === project.owner.remitId && r.state === "active") ?? null)
      : null;
  const trimmed = reason.trim(),
    reasonOk = trimmed.length >= MIN && reason.length <= MAX;
  const primes = remits?.primes ?? [];
  const lines = historyLines(remits?.history ?? [], project.projectId);
  const submit = async (kind: "save" | "end") => {
    if (!reasonOk || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const key = `${kind}:${prime}:${trimmed}`,
        messageId = idFor(key);
      const r =
        kind === "end" && own
          ? await end({ messageId, expectedRevision: own.revision, remitId: own.id, note: trimmed })
          : own
            ? await move({
                messageId,
                expectedRevision: own.revision,
                remitId: own.id,
                toPrimeSeat: prime!,
                note: trimmed,
              })
            : await assign({
                messageId,
                expectedRevision: 0,
                primeSeat: prime!,
                scope: { kind: "project", projectId: project.projectId },
                note: trimmed,
              });
      if (r.ok) {
        setResult({
          ok: true,
          text:
            kind === "end"
              ? `${project.name} no longer has its own main assistant.`
              : `${project.name} now belongs to the ${primeName(prime!)}.`,
        });
        setReason("");
        setPrime(null);
        attempt.current = { key: "", id: newId() };
        onChanged();
      } else setResult({ ok: false, text: r.message ?? "That change was not made." });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : "That change was not made." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <View
      testID="org-remit-edit"
      style={{
        gap: 14,
        padding: 16,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: c.accent,
        backgroundColor: c.surface1,
      }}
    >
      <View style={{ gap: 4 }}>
        <Text
          accessibilityRole="header"
          style={{ color: c.foreground, fontSize: 20, fontWeight: "700" }}
        >
          Who owns {project.name}?
        </Text>
        <Text style={muted}>
          {project.owner.primeSeat
            ? `Now: the ${primeName(project.owner.primeSeat)}${project.owner.kind === "domain" ? ", through its area" : ""}.`
            : "Now: no main assistant yet."}{" "}
          The owning main assistant can write this project's update and sees it in its list. It
          gains no other control.
        </Text>
      </View>
      {remits?.stale && (
        <Notice colors={c} tone="warning">
          The list of primes may be out of date. {remits.error}
        </Notice>
      )}
      <SectionTitle colors={c}>Move to</SectionTitle>
      {!primes.length ? (
        <Text style={text}>No main assistant is recorded yet. Record one in Leadership first.</Text>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {primes.map((p) => {
            const current = p.seat === project.owner.primeSeat && project.owner.kind === "project";
            return (
              <Button
                key={p.seat}
                theme={theme}
                testID={`org-remit-prime-${p.seat}`}
                label={current ? `${primeName(p.seat)}, owns it now` : primeName(p.seat)}
                selected={prime === p.seat}
                disabled={current}
                onPress={() => setPrime(p.seat)}
              >
                <Text style={{ color: c.foreground, fontWeight: prime === p.seat ? "700" : "600" }}>
                  {primeName(p.seat)}
                  {current ? " · now" : ""}
                  {p.state === "vacant" ? " · role empty" : ""}
                </Text>
              </Button>
            );
          })}
        </View>
      )}
      <SectionTitle colors={c}>Why</SectionTitle>
      <TextInput
        testID="org-remit-reason"
        accessibilityLabel="Reason for the change"
        multiline
        maxLength={MAX}
        value={reason}
        onChangeText={setReason}
        placeholder="For example: the delivery assistant is taking over all launch work this month"
        placeholderTextColor={c.foregroundMuted}
        style={{
          minHeight: 72,
          color: c.foreground,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 10,
          padding: 10,
          backgroundColor: c.surface0,
          textAlignVertical: "top",
        }}
      />
      <Text style={muted}>
        {reason.length && !reasonOk
          ? `Write at least ${MIN} characters so the history makes sense later.`
          : "Shown in the history below."}
      </Text>
      {result && (
        <Notice colors={c} tone={result.ok ? "success" : "danger"} testID="org-remit-result">
          {result.text}
        </Notice>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          theme={theme}
          primary
          testID="org-remit-save"
          label={
            prime
              ? `Move ${project.name} to the ${primeName(prime)}`
              : "Choose a main assistant first"
          }
          disabled={!prime || !reasonOk || busy}
          onPress={() => void submit("save")}
        >
          <Text style={{ color: c.accentForeground, fontWeight: "700" }}>
            {busy ? "Saving…" : "Save"}
          </Text>
        </Button>
        {own && (
          <Button
            theme={theme}
            testID="org-remit-end"
            label={`Stop the ${primeName(own.primeSeat)} owning ${project.name}`}
            disabled={!reasonOk || busy}
            onPress={() => void submit("end")}
          >
            <Text style={{ color: c.foreground, fontWeight: "600" }}>Remove main assistant</Text>
          </Button>
        )}
        <Button theme={theme} testID="org-remit-close" label="Close" onPress={onClose} />
      </View>
      <View testID="org-remit-history" style={{ gap: 8 }}>
        <SectionTitle colors={c}>History</SectionTitle>
        {!lines.length ? (
          <Text style={muted}>No changes yet.</Text>
        ) : (
          lines.map((l) => (
            <View
              key={l.id}
              style={{ gap: 2, borderLeftWidth: 2, borderLeftColor: c.border, paddingLeft: 10 }}
            >
              <Text style={text}>{l.what}</Text>
              <Text style={muted}>
                “{l.why}” · {relativeTime(l.at)}, by {l.by}
              </Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}
