import React, { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { z } from "zod";
import {
  NativeArtifactContentSelectionSchema,
  type NativeArtifactContentGrant,
} from "@getpaseo/protocol/native-artifact-content";
import type { PluginSurfaceRuntime } from "@/plugins/surface-runtime";
import { Button } from "@/components/ui/button";
import {
  artifactContentGrantSetRpc,
  artifactToolSetRpc,
} from "../../../../control/orca-organization/shared/intercom";

export interface ManagedContentGrantActionsProps {
  runtime: Pick<PluginSurfaceRuntime, "invoke">;
  selection: z.infer<typeof NativeArtifactContentSelectionSchema>;
  /** Only an explicitly selected ID from the protected committed managed index. */
  artifactId: string | null;
  signal: AbortSignal;
  /** Parent captures its original protected selection and physical/native/permission lifetime. */
  checkOriginalLifetime: () => void;
  onGrantConfirmed?: () => void;
}

function confirmGrant(
  grants: NativeArtifactContentGrant[],
  input: z.infer<typeof artifactContentGrantSetRpc.input>,
) {
  const matches = grants.filter((row) => row.grantId === input.grantId);
  const grant = matches[0];
  if (
    matches.length !== 1 ||
    !grant ||
    JSON.stringify(grant.identity) !== JSON.stringify(input.identity) ||
    grant.expectedEpoch !== input.expectedEpoch ||
    JSON.stringify(grant.scope) !== JSON.stringify(input.scope) ||
    grant.artifactIds.length !== 1 ||
    grant.artifactIds[0] !== input.artifactIds[0] ||
    grant.byteBudget !== input.byteBudget ||
    grant.expiresAt !== input.expiresAt
  )
    throw new Error("Unconfirmed");
}

/**
 * Deliberate owner requests only. Availability and caller UUIDs never confer authority.
 * Parent must key this component by its original observed admission epoch and registered
 * selection; checkOriginalLifetime must not be a fresh guard over a replacement lifetime.
 */
export function ManagedContentGrantActions(props: ManagedContentGrantActionsProps) {
  const [phase, setPhase] = useState<"idle" | "pending" | "confirmed" | "uncertain" | "gone">(
    "idle",
  );
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    const lifetime = epoch;
    const abort = () => {
      epoch.current++;
      setNotice(null);
      setPhase("gone");
    };
    if (props.signal.aborted) abort();
    props.signal.addEventListener("abort", abort);
    return () => {
      lifetime.current++;
      props.signal.removeEventListener("abort", abort);
    };
  }, [props.signal, props.runtime, props.selection, props.artifactId]);
  const request = useCallback(
    async (kind: "tool" | "grant") => {
      if (pending.current || phase === "uncertain" || phase === "gone") return;
      pending.current = true;
      const capturedEpoch = epoch.current;
      const check = () => {
        props.checkOriginalLifetime();
        if (props.signal.aborted || epoch.current !== capturedEpoch) throw new Error("Unavailable");
      };
      let sent = false;
      try {
        check();
        const selection = NativeArtifactContentSelectionSchema.parse(props.selection);
        const expiresAt = Date.now() + 60 * 60 * 1000;
        const messageId = globalThis.crypto.randomUUID();
        setPhase("pending");
        setNotice(null);
        if (kind === "tool") {
          const input = artifactToolSetRpc.input.parse({
            ...selection,
            messageId,
            enabled: true,
            expiresAt,
          });
          check();
          sent = true;
          const output = artifactToolSetRpc.output.parse(
            await props.runtime.invoke(artifactToolSetRpc.name, input),
          );
          check();
          if (output.messageId !== messageId || !output.enabled || output.expiresAt !== expiresAt)
            throw new Error("Unconfirmed");
          setNotice("Host confirmed declared-output tool enabled for this scope for one hour.");
        } else {
          const artifactId = z.string().uuid().parse(props.artifactId);
          const grantId = globalThis.crypto.randomUUID();
          const input = artifactContentGrantSetRpc.input.parse({
            ...selection,
            messageId,
            grantId,
            expectedGrantRevision: null,
            artifactIds: [artifactId],
            byteBudget: 8192,
            expiresAt,
            enabled: true,
          });
          check();
          sent = true;
          const output = artifactContentGrantSetRpc.output.parse(
            await props.runtime.invoke(artifactContentGrantSetRpc.name, input),
          );
          check();
          confirmGrant(output.grants, input);
          setNotice(
            "Host confirmed a separate one-hour text grant with an 8 KiB aggregate budget. No content was read.",
          );
          props.onGrantConfirmed?.();
        }
        check();
        setPhase("confirmed");
      } catch {
        try {
          check();
          setPhase(sent ? "uncertain" : "idle");
          setNotice(
            sent
              ? "Action outcome unconfirmed. No retry was sent; owner recovery is required before another action."
              : "Owner action unavailable.",
          );
        } catch {
          /* Parent purges a superseded physical lifetime. */
        }
      } finally {
        pending.current = false;
      }
    },
    [props, phase],
  );
  const enable = useCallback(() => request("tool"), [request]);
  const grant = useCallback(() => request("grant"), [request]);
  const disabled = phase === "pending" || phase === "uncertain" || phase === "gone";
  return (
    <View style={styles.group}>
      <Button variant="outline" disabled={disabled} onPress={enable}>
        Enable declared outputs for one hour
      </Button>
      <Button variant="outline" disabled={disabled || !props.artifactId} onPress={grant}>
        Grant selected text artifact · 8 KiB
      </Button>
      <Text style={styles.detail}>
        Separate owner confirmation is required. Tool enablement is not a content grant; grant
        creation does not read content.
      </Text>
      {notice ? <Text style={styles.detail}>{notice}</Text> : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  group: { gap: theme.spacing[2] },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
