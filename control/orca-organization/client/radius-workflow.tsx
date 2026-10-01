import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { WorkButton } from "./work-button";
import {
  planRadiusChange,
  validateRadiusPlan,
  radiusScratchFiles,
  type RadiusPlan,
  type RadiusValidation,
} from "../shared/cc/radius-workflow.mjs";

interface ScratchInput {
  attemptId: string;
  plan: RadiusPlan;
  expectedRevision: string;
}
interface ScratchOutput {
  attemptId: string;
  kind: "local-scratch-simulation";
  target: "0.61.x";
  outputs: { file: string; bytes: number; sha256: string }[];
  nativeCompilation: "not_run";
  environmentDeployment: "held";
  externalEffects: false;
}
function assertScratchResult(output: ScratchOutput, attemptId: string): void {
  if (
    output.attemptId !== attemptId ||
    output.kind !== "local-scratch-simulation" ||
    output.target !== "0.61.x" ||
    output.nativeCompilation !== "not_run" ||
    output.environmentDeployment !== "held" ||
    output.externalEffects !== false
  )
    throw Error("unavailable");
}
export interface RadiusWorkflowProps {
  theme: PluginSurfaceProps["theme"];
  simulate?: (input: ScratchInput, signal: AbortSignal) => Promise<ScratchOutput>;
  pruneAndSimulate?: (
    input: ScratchInput & { confirmDestructive: true },
    signal: AbortSignal,
  ) => Promise<ScratchOutput>;
  checkOriginalLifetime?: () => void;
}
const GROUP = { gap: 4 };
const FILES = { gap: 8 };
const initial = {
  application: "scratch-demo",
  requirements: '[{"id":"web-port","resourceId":"web","port":8080}]',
  current: "[]",
  proposed: '[{"id":"web","image":"nginx:1.27.5","port":8080}]',
};

export function RadiusWorkflow({
  theme,
  simulate,
  pruneAndSimulate,
  checkOriginalLifetime,
}: RadiusWorkflowProps) {
  const [fields, setFields] = useState(initial);
  const [plan, setPlan] = useState<RadiusPlan | null>(null);
  const [validation, setValidation] = useState<RadiusValidation | null>(null);
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [confirmDestructive, setConfirmDestructive] = useState(false);
  const submitting = useRef(false);
  const epoch = useRef(0),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setNotice(null);
    setBusy(false);
    setConfirmDestructive(false);
    return () => {
      epoch.current += 1;
      controller.current?.abort();
    };
  }, [simulate, pruneAndSimulate, checkOriginalLifetime]);
  const c = theme.colors;
  const styles = useMemo(
    () => ({
      text: { color: c.foreground },
      muted: { color: c.foregroundMuted },
      root: { padding: 16, borderWidth: 1, borderColor: c.border, borderRadius: 14, gap: 12 },
      header: { color: c.foreground, fontSize: 20, fontWeight: "600" as const },
      input: {
        color: c.foreground,
        padding: 10,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 8,
      },
    }),
    [c],
  );
  const edit = useCallback((key: keyof typeof fields, value: string) => {
    epoch.current += 1;
    controller.current?.abort();
    setFields((previous) => ({ ...previous, [key]: value }));
    setPlan(null);
    setValidation(null);
    setFiles(null);
    setNotice(null);
    setBusy(false);
    setAttempted(false);
    setConfirmDestructive(false);
    submitting.current = false;
  }, []);
  const changes = useMemo(
    () => ({
      application: (value: string) => edit("application", value),
      requirements: (value: string) => edit("requirements", value),
      current: (value: string) => edit("current", value),
      proposed: (value: string) => edit("proposed", value),
    }),
    [edit],
  );
  const prepare = useCallback(() => {
    setValidation(null);
    setFiles(null);
    try {
      const value = planRadiusChange({
        application: fields.application,
        requirements: JSON.parse(fields.requirements),
        current: JSON.parse(fields.current),
        proposed: JSON.parse(fields.proposed),
      });
      setPlan(value);
      setNotice("Infrastructure change planned. Validate this exact plan before simulation.");
    } catch {
      setPlan(null);
      setNotice(
        "Use bounded application, requirement and container definitions. Paths, commands, credentials and live targets are not accepted.",
      );
    }
  }, [fields]);
  const validate = useCallback(() => {
    if (!plan) return;
    const result = validateRadiusPlan(plan, plan.revision);
    setValidation(result);
    setNotice(
      result.kind === "valid"
        ? "Local structural checks passed. Native Radius compilation has not run."
        : "Requirements are unmet. Simulation is blocked.",
    );
  }, [plan]);
  const localSimulation = useCallback(() => {
    if (!plan || validation?.kind !== "valid") return;
    setFiles(radiusScratchFiles(plan, plan.revision));
    setNotice(
      "Local deployment simulation complete in this panel. No host files or environment were changed.",
    );
  }, [plan, validation]);
  const privateSimulation = useCallback(async () => {
    const effect = confirmDestructive
      ? pruneAndSimulate &&
        ((input: ScratchInput, signal: AbortSignal) =>
          pruneAndSimulate({ ...input, confirmDestructive: true }, signal))
      : simulate;
    if (
      !plan ||
      validation?.kind !== "valid" ||
      !effect ||
      !checkOriginalLifetime ||
      busy ||
      attempted ||
      submitting.current
    )
      return;
    const captured = epoch.current,
      abort = new AbortController();
    controller.current = abort;
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      setNotice("Private scratch simulation is unavailable on this client.");
      return;
    }
    const input = {
      attemptId: globalThis.crypto.randomUUID(),
      plan: structuredClone(plan),
      expectedRevision: plan.revision,
    };
    const current = () => {
      if (captured !== epoch.current || abort.signal.aborted) throw Error("unavailable");
      checkOriginalLifetime();
    };
    setAttempted(true);
    submitting.current = true;
    setBusy(true);
    setNotice("Writing a private scratch simulation…");
    try {
      current();
      const output = await effect(input, abort.signal);
      current();
      assertScratchResult(output, input.attemptId);
      setNotice(
        "Private scratch files written and read back. Native compilation has not run; real deployment remains held.",
      );
    } catch {
      if (captured === epoch.current && !abort.signal.aborted)
        setNotice(
          "Private scratch simulation was refused or its outcome is unknown. This attempt will not be retried.",
        );
    } finally {
      if (captured === epoch.current) setBusy(false);
    }
  }, [
    plan,
    validation,
    simulate,
    pruneAndSimulate,
    confirmDestructive,
    checkOriginalLifetime,
    busy,
    attempted,
  ]);
  const selectDestructive = useCallback(() => {
    if (!busy && !attempted && !submitting.current) setConfirmDestructive((value) => !value);
  }, [busy, attempted]);
  const writePrivate = useCallback(() => {
    void privateSimulation();
  }, [privateSimulation]);
  return (
    <View testID="radius-workflow" style={styles.root}>
      <Text accessibilityRole="header" style={styles.header}>
        Radius requirements and infrastructure
      </Text>
      <Text style={styles.muted}>
        Radius 0.61 · local/scratch only. Plan changes, validate declared requirements, then
        simulate deployment. Real environments remain held.
      </Text>
      <Text style={styles.muted}>
        Current infrastructure below is your local input, not an observed live environment. Each
        requirement checks a declared container and port, not service health.
      </Text>
      {(["application", "requirements", "current", "proposed"] as const).map((key) => (
        <View key={key} style={GROUP}>
          <Text style={styles.text}>
            {
              {
                application: "Application name",
                requirements: "Requirements (container and port)",
                current: "Current container definitions",
                proposed: "Proposed container definitions",
              }[key]
            }
          </Text>
          <TextInput
            accessibilityLabel={`Radius ${key}`}
            value={fields[key]}
            multiline={key !== "application"}
            maxLength={key === "application" ? 40 : 8192}
            editable={!busy}
            onChangeText={changes[key]}
            style={styles.input}
          />
        </View>
      ))}
      <WorkButton
        theme={theme}
        label="Plan infrastructure change"
        disabled={busy}
        onPress={prepare}
      />
      {plan && (
        <View testID="radius-change-plan" style={GROUP}>
          {!plan.changes.length && (
            <Text style={styles.text}>No declared infrastructure changes.</Text>
          )}
          {plan.changes.map((change) => (
            <Text key={change.id} style={styles.text}>{`${change.kind}: ${change.id}`}</Text>
          ))}
          <WorkButton
            theme={theme}
            label="Allow pruning known retained scratch attempts"
            selected={confirmDestructive}
            disabled={busy || attempted || !pruneAndSimulate || !checkOriginalLifetime}
            onPress={selectDestructive}
          />
          <Text style={styles.muted}>
            This separate choice permits owner-confirmed removal of eligible known attempts at
            capacity, from 64 toward 48. Unknown files are preserved. Eviction ends retained UUID
            replay protection; interrupted pruning can strand a slot. It does not deploy an
            environment.
          </Text>
          <WorkButton
            theme={theme}
            label="Validate local requirements"
            disabled={busy}
            onPress={validate}
          />
        </View>
      )}
      {validation && (
        <View testID="radius-validation" style={GROUP}>
          {validation.requirements.map((row) => (
            <Text key={row.id} style={styles.text}>{`${row.id}: ${row.state}`}</Text>
          ))}
          <Text style={styles.muted}>
            Native Radius/Bicep compilation: not run. Real environment deployment: held.
          </Text>
          <WorkButton
            theme={theme}
            label="Simulate deployment in this panel"
            disabled={validation.kind !== "valid" || busy}
            onPress={localSimulation}
          />
          <WorkButton
            theme={theme}
            label="Write private scratch simulation"
            disabled={
              validation.kind !== "valid" ||
              busy ||
              attempted ||
              !(confirmDestructive ? pruneAndSimulate : simulate) ||
              !checkOriginalLifetime
            }
            onPress={writePrivate}
          />
          {(!simulate || !checkOriginalLifetime) && (
            <Text style={styles.muted}>Authenticated host scratch writing is unavailable.</Text>
          )}
        </View>
      )}
      {notice && (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          {notice}
        </Text>
      )}
      {files && (
        <View testID="radius-simulation-files" style={FILES}>
          <Text style={styles.muted}>
            Definitions and simulation stay in this panel and are cleared when the host or project
            changes. Generated source has not been compiled by Radius.
          </Text>
          {Object.entries(files).map(([file, source]) => (
            <View key={file} style={GROUP}>
              <Text style={styles.text}>{file}</Text>
              <Text selectable style={styles.muted}>
                {source}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
