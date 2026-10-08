import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { z } from "zod";
import { NativeQueuedMessageReceiptSchema } from "@getpaseo/protocol/native-intercom";
import { operatorInvokeRpc } from "../shared/operator-invoke";
import { useContract } from "./use-contract";

const inputSchema = z
  .object({
    sessionId: z.string().uuid(),
    messageId: z.string().uuid(),
    text: z
      .string()
      .trim()
      .min(1)
      .max(16384)
      .refine(
        (text) => new TextEncoder().encode(text).byteLength <= 16384 && !text.startsWith("/"),
      ),
    expectedGeneration: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();
const deliverySchema = z.object({
  id: z.string().uuid(),
  session: z.string().uuid(),
  kind: z.literal("send"),
  state: z.string(),
  result: z.object({ nativeReceipt: NativeQueuedMessageReceiptSchema.optional() }),
});
interface Props {
  target: { id: string; generation: number; mode: "human" | "delegated" } | null;
  /** Observed protected management snapshot; availability never grants action authority. */
  fresh: boolean;
  hostId?: string;
  colors: {
    foreground: string;
    foregroundMuted: string;
    accent: string;
    accentForeground: string;
    border: string;
  };
}

/** One deliberate installed operator operation; never a bare human nativeQueue flag. */
export function NativeQueuedInstruction({ target, fresh, hostId, colors }: Props) {
  const invoke = useContract(operatorInvokeRpc);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<{ message: string; epoch: number } | null>(null);
  const [sent, setSent] = useState(false);
  const draft = useRef<z.infer<typeof inputSchema> | null>(null);
  const active = useRef(true);
  const epoch = useRef(0);
  const observed = JSON.stringify([hostId, target?.id, target?.generation, target?.mode, fresh]);
  const prior = useRef(observed);
  if (prior.current !== observed) {
    prior.current = observed;
    epoch.current++;
  }
  const current = useRef({ target, fresh, hostId, invoke });
  current.current = { target, fresh, hostId, invoke };
  useEffect(() => {
    const lifetime = epoch;
    active.current = true;
    return () => {
      active.current = false;
      lifetime.current++;
    };
  }, []);
  const send = useCallback(async () => {
    if (draft.current || !target || !fresh || target.mode !== "delegated") return;
    const captured = epoch.current;
    const check = () => {
      const now = current.current;
      if (
        !active.current ||
        epoch.current !== captured ||
        !now.fresh ||
        now.invoke !== invoke ||
        now.hostId !== hostId ||
        now.target?.id !== target.id ||
        now.target.generation !== target.generation ||
        now.target.mode !== "delegated"
      )
        throw new Error("The original lead control is not available");
    };
    try {
      check();
      const input = inputSchema.parse({
        sessionId: target.id,
        expectedGeneration: target.generation,
        messageId: globalThis.crypto.randomUUID(),
        text,
      });
      draft.current = input;
      setSent(true);
      setNotice({
        message: "Sending… Your draft is kept in case it does not go through.",
        epoch: captured,
      });
      check();
      const output = operatorInvokeRpc.output.parse(
        await invoke({ method: "operator-native-queue", input }),
      );
      check();
      if (!output.ok) {
        setNotice({
          message: output.dispatched
            ? "We cannot tell whether this was delivered. Check the original message; nothing was sent again."
            : "This computer refused the request. Your draft is kept and nothing was sent again.",
          epoch: captured,
        });
        return;
      }
      const delivery = deliverySchema.parse(output.result);
      if (delivery.id !== input.messageId || delivery.session !== input.sessionId)
        throw new Error("Uncorrelated delivery");
      const receipt = delivery.result.nativeReceipt;
      if (
        !receipt ||
        receipt.messageId !== "orca-control:" + input.messageId ||
        (receipt.state === "delivered" && !receipt.providerTurnId)
      )
        throw new Error("Unconfirmed native outcome");
      check();
      setNotice({
        message: `Message ${receipt.state}. Queued means waiting its turn, not yet delivered, and delivered does not mean the work is done. Your draft is kept.`,
        epoch: captured,
      });
    } catch {
      if (active.current && epoch.current === captured)
        setNotice({
          message: draft.current
            ? "Outcome unconfirmed. Inspect the original delivery; no resend was made."
            : "Native operator request unavailable.",
          epoch: captured,
        });
    }
  }, [target, fresh, hostId, invoke, text]);
  const update = useCallback((value: string) => {
    if (!draft.current) setText(value);
  }, []);
  const styles = useMemo(
    () => ({
      group: { gap: 8 },
      text: { color: colors.foreground },
      detail: { color: colors.foregroundMuted },
      input: {
        color: colors.foreground,
        borderColor: colors.border,
        borderWidth: 1,
        padding: 12,
        minHeight: 80,
        borderRadius: 8,
      },
      button: { backgroundColor: colors.accent, padding: 12, borderRadius: 8 },
      buttonText: { color: colors.accentForeground },
    }),
    [colors],
  );
  const disabled = sent || !fresh || target?.mode !== "delegated" || !text.trim();
  return (
    <View style={styles.group}>
      <Text style={styles.text}>
        Explicit installed native queue · separate from Send instruction
      </Text>
      <TextInput
        accessibilityLabel="Native queued instruction"
        multiline
        editable={!sent}
        value={text}
        onChangeText={update}
        maxLength={16384}
        style={styles.input}
      />
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={send}
        style={styles.button}
      >
        <Text style={styles.buttonText}>Queue native instruction once</Text>
      </Pressable>
      <Text style={styles.detail}>
        This protected operator route works only while the lead controls the session and the host gives native authority.
        It never creates authority from a feature, label or client flag.
      </Text>
      {notice && notice.epoch === epoch.current ? (
        <Text style={styles.detail}>{notice.message}</Text>
      ) : null}
    </View>
  );
}
