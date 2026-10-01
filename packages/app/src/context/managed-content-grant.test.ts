import { expect, test, vi } from "vitest";
import { selectManagedArtifactContentGrant } from "./managed-content-grant";
const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
function selection() {
  return {
    identity: { agentId: id, instanceId: id, sessionId: "native", boot: id },
    expectedEpoch: id,
    scope: { projectId: id, taskId: id },
  };
}
function grant() {
  return {
    ...selection(),
    grantId: id,
    revision: id,
    artifactIds: [id],
    byteBudget: 64,
    expiresAt: Date.now() + 10000,
  };
}
const choice = { grantId: id, artifactId: id };
test("managed content selector uses the protected exact current list and explicit grant choice", async () => {
  const invoke = vi.fn(async () => ({ grants: [grant()] }));
  const check = vi.fn();
  await expect(
    selectManagedArtifactContentGrant({ invoke }, selection(), choice, check),
  ).resolves.toMatchObject({ grantId: id, artifactIds: [id] });
  expect(invoke).toHaveBeenCalledWith("organization.intercom.artifacts.content.list", selection());
  expect(check).toHaveBeenCalled();
});
test.each(["epoch", "native", "scope", "artifact", "expired", "duplicate"])(
  "managed content selector refuses %s without an alternate grant",
  async (kind) => {
    const row = grant();
    if (kind === "epoch") row.expectedEpoch = other;
    if (kind === "native") row.identity.instanceId = other;
    if (kind === "scope") row.scope.taskId = other;
    if (kind === "artifact") row.artifactIds = [other];
    if (kind === "expired") row.expiresAt = Date.now() - 1;
    const rows = kind === "duplicate" ? [row, row] : [row];
    await expect(
      selectManagedArtifactContentGrant(
        { invoke: async () => ({ grants: rows }) },
        selection(),
        choice,
        () => {},
      ),
    ).rejects.toThrow("unavailable");
  },
);
test("managed content selector preserves host refusal without fallback", async () => {
  const invoke = vi.fn(async () => {
    throw new Error("Owner required");
  });
  await expect(
    selectManagedArtifactContentGrant({ invoke }, selection(), choice, () => {}),
  ).rejects.toThrow("Owner required");
  expect(invoke).toHaveBeenCalledTimes(1);
});
test("managed content selector retains the original input and refuses revoked held publication", async () => {
  let resolve!: (value: unknown) => void;
  const held = new Promise<unknown>((done) => {
    resolve = done;
  });
  const input = selection();
  let revoked = false;
  const invoke = vi.fn(() => held);
  const pending = selectManagedArtifactContentGrant({ invoke }, input, { ...choice }, () => {
    if (revoked) throw new Error("Revoked");
  });
  input.scope.taskId = other;
  expect(invoke.mock.calls[0]).toEqual([
    "organization.intercom.artifacts.content.list",
    selection(),
  ]);
  revoked = true;
  resolve({ grants: [grant()] });
  await expect(pending).rejects.toThrow("Revoked");
});
