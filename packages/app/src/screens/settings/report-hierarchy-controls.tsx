import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { useContract } from "../../../../../control/orca-organization/client/use-contract";
import {
  intercomStatusRpc,
  reportPrimePromoteRpc,
  reportPrimeDemoteRpc,
  reportProjectTransferRpc,
} from "../../../../../control/orca-organization/shared/intercom";
import {
  snapshotReportRole,
  prepareHierarchyRequest,
  unchangedReportRole,
  type ReportRoleSnapshot,
  type HierarchyAction,
} from "./report-hierarchy-model";

export function ReportHierarchyControls({
  hostId,
  colors,
}: {
  hostId: string;
  colors: { foreground: string; foregroundMuted: string; border: string };
}) {
  const read = useContract(intercomStatusRpc);
  const promote = useContract(reportPrimePromoteRpc);
  const demote = useContract(reportPrimeDemoteRpc);
  const transfer = useContract(reportProjectTransferRpc);
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [source, setSource] = useState<ReportRoleSnapshot | null>(null);
  const [target, setTarget] = useState<ReportRoleSnapshot | null>(null);
  const [project, setProject] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const attempt = useRef<ReturnType<typeof prepareHierarchyRequest> | null>(null);
  const epoch = useRef(0);
  const active = useRef(true);
  const key = JSON.stringify([hostId, sourceId, targetId]);
  const observed = useRef(key);
  if (observed.current !== key) {
    observed.current = key;
    epoch.current++;
  }
  const current = useRef({ hostId, read, promote, demote, transfer });
  current.current = { hostId, read, promote, demote, transfer };
  useEffect(() => {
    const lifetime = epoch;
    active.current = true;
    return () => {
      active.current = false;
      lifetime.current++;
    };
  }, []);
  const styles = useMemo(
    () => ({
      root: { gap: 8 },
      text: { color: colors.foreground },
      muted: { color: colors.foregroundMuted },
      input: { color: colors.foreground, borderWidth: 1, borderColor: colors.border, padding: 8 },
    }),
    [colors],
  );
  const changeSource = useCallback((value: string) => {
    epoch.current++;
    setSourceId(value);
    setSource(null);
    setTarget(null);
    setProject("");
    setNotice(null);
  }, []);
  const changeTarget = useCallback((value: string) => {
    epoch.current++;
    setTargetId(value);
    setTarget(null);
    setNotice(null);
  }, []);
  const originalCheck = useCallback(
    (captured: number) => {
      const now = current.current;
      if (
        !active.current ||
        epoch.current !== captured ||
        now.hostId !== hostId ||
        now.read !== read ||
        now.promote !== promote ||
        now.demote !== demote ||
        now.transfer !== transfer
      )
        throw new Error("Original owner connection unavailable");
    },
    [hostId, read, promote, demote, transfer],
  );
  const inspect = useCallback(async () => {
    if (attempt.current || busy) return;
    const captured = ++epoch.current;
    setBusy(true);
    setNotice(null);
    setSource(null);
    setTarget(null);
    setProject("");
    try {
      z.string().uuid().parse(sourceId);
      originalCheck(captured);
      const own = snapshotReportRole(await read({ agentId: sourceId }), sourceId);
      originalCheck(captured);
      const other = targetId
        ? snapshotReportRole(await read({ agentId: z.string().uuid().parse(targetId) }), targetId)
        : null;
      originalCheck(captured);
      setSource(own);
      setTarget(other);
      setNotice("Current registrations read. No role or ownership change was made.");
    } catch {
      if (epoch.current === captured && active.current)
        setNotice("Owner status unavailable. No changes were made.");
    } finally {
      if (epoch.current === captured && active.current) setBusy(false);
    }
  }, [busy, sourceId, targetId, originalCheck, read]);
  const submit = useCallback(
    async (action: HierarchyAction) => {
      if (!source || attempt.current || busy) return;
      const captured = epoch.current;
      let sent = false;
      setBusy(true);
      setNotice(null);
      try {
        originalCheck(captured);
        const draft = prepareHierarchyRequest(
          action,
          source,
          target,
          project,
          globalThis.crypto.randomUUID(),
        );
        attempt.current = draft;
        setAttempted(true);
        unchangedReportRole(
          source,
          snapshotReportRole(await read({ agentId: sourceId }), sourceId),
        );
        originalCheck(captured);
        if (target) {
          unchangedReportRole(
            target,
            snapshotReportRole(await read({ agentId: targetId }), targetId),
          );
          originalCheck(captured);
        }
        sent = true;
        let raw: unknown;
        if (action === "promote") {
          raw = await promote(reportPrimePromoteRpc.input.parse(draft.input));
        } else if (action === "demote") {
          raw = await demote(reportPrimeDemoteRpc.input.parse(draft.input));
        } else {
          raw = await transfer(reportProjectTransferRpc.input.parse(draft.input));
        }
        originalCheck(captured);
        const result = reportPrimePromoteRpc.output.parse(raw);
        if (
          result.messageId !== draft.input.messageId ||
          !result.current ||
          result.maintenanceRequired
        )
          throw new Error("Unconfirmed");
        setNotice(
          "Host confirmed the explicit change. Old pending reports remain fenced and are not retargeted or replayed.",
        );
        setSource(null);
        setTarget(null);
      } catch {
        if (epoch.current === captured && active.current)
          setNotice(
            sent
              ? "Change outcome unconfirmed. The original attempt is retained; no automatic or repeated submission is available."
              : "Change was not submitted. Refresh using a new owner view before another deliberate operation.",
          );
      } finally {
        if (epoch.current === captured && active.current) setBusy(false);
      }
    },
    [
      source,
      target,
      project,
      busy,
      originalCheck,
      read,
      sourceId,
      targetId,
      promote,
      demote,
      transfer,
    ],
  );
  const doPromote = useCallback(() => {
    void submit("promote");
  }, [submit]);
  const doDemote = useCallback(() => {
    void submit("demote");
  }, [submit]);
  const doTransfer = useCallback(() => {
    void submit("transfer");
  }, [submit]);
  const refresh = useCallback(() => {
    void inspect();
  }, [inspect]);
  const projects = useMemo(
    () =>
      (source?.registration?.owningProjects ?? []).map((item) => ({
        projectId: item.projectId,
        epoch: item.epoch,
        choose: () => setProject(item.projectId),
      })),
    [source],
  );
  const identityReady =
    z.string().uuid().safeParse(sourceId).success &&
    (!targetId || z.string().uuid().safeParse(targetId).success);
  return (
    <View style={styles.root}>
      <Text accessibilityRole="header" style={styles.text}>
        Prime roles and project ownership
      </Text>
      <Text style={styles.muted}>
        Explicit host-owner operations. Report registration, scopes and availability do not grant
        action authority.
      </Text>
      <Text style={styles.muted}>
        Demotion re-parents children to the selected upward parent. Transfer preserves the old
        owner’s read scope; scope narrowing is refused until the project has been transferred.
      </Text>
      <EditingTextInput
        accessibilityLabel="Registered session to change"
        initialValue=""
        onChangeText={changeSource}
        editable={!busy && !attempted}
        style={styles.input}
      />
      <EditingTextInput
        accessibilityLabel="Registered upward parent or receiving prime"
        initialValue=""
        onChangeText={changeTarget}
        editable={!busy && !attempted}
        style={styles.input}
      />
      <Button onPress={refresh} disabled={busy || attempted || !identityReady}>
        Read current registrations
      </Button>
      {source && (
        <>
          <Text style={styles.muted}>
            Promotion uses this session’s registered scopes and the observed project epoch of this
            session or the selected current owner. Unknown ownership is refused by the host.
          </Text>
          <Button onPress={doPromote} disabled={busy || attempted}>
            Confirm promotion with registered scopes
          </Button>
          <Button
            onPress={doDemote}
            disabled={busy || attempted || !target || !source.registration?.primeRole}
          >
            Confirm demotion and upward child disposition
          </Button>
          {projects.map((item) => (
            <Button
              key={item.projectId}
              variant="outline"
              onPress={item.choose}
              disabled={busy || attempted}
            >
              Select owned project {item.projectId}
              {project === item.projectId ? " · selected" : ""}
            </Button>
          ))}
          <Button
            onPress={doTransfer}
            disabled={busy || attempted || !project || !target?.registration?.primeRole}
          >
            Confirm selected project transfer
          </Button>
        </>
      )}
      {notice && (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          {notice}
        </Text>
      )}
    </View>
  );
}
