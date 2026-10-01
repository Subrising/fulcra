import { expect, test, vi } from "vitest";
import { ManagementAuthority } from "./management.js";
import { registerNativeRadiusScratch } from "./native-radius-scratch.js";
import { bundledTarget } from "./test-utils/management.js";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import type { ManagementPrincipalV11 } from "@getpaseo/protocol/controller-management";
import type { ControllerDistribution } from "./controller-distribution.js";
import type { RadiusScratchInput } from "@getpaseo/protocol/radius-scratch";

async function fixture() {
  const { parseControllerCommand } = await import(
    new URL("../../../../../control/orca-organization/shared/command-parser.mjs", import.meta.url)
      .href
  );
  const { planRadiusChange } = await import(
    new URL(
      "../../../../../control/orca-organization/shared/cc/radius-workflow.mjs",
      import.meta.url,
    ).href
  );
  const plan = planRadiusChange({
    application: "example",
    requirements: [{ id: "web-port", resourceId: "web", port: 8080 }],
    current: [],
    proposed: [{ id: "web", image: "nginx:1.27.5", port: 8080 }],
  });
  const input: RadiusScratchInput = {
    attemptId: "11111111-1111-4111-8111-111111111111",
    plan,
    expectedRevision: plan.revision,
  };
  const output = {
    attemptId: input.attemptId,
    kind: "local-scratch-simulation",
    target: "0.61.x",
    outputs: [
      "app.bicep",
      "requirements.json",
      "infra-change.json",
      "deployment-simulation.json",
    ].map((file) => ({ file, bytes: 1, sha256: "a".repeat(64) })),
    nativeCompilation: "not_run",
    environmentDeployment: "held",
    externalEffects: false,
  };
  let principal: ManagementPrincipalV11 = {
    id: "owner",
    authentication: "daemon-password",
    deviceId: null,
    permissions: OWNER_PERMISSIONS,
  };
  let before: (() => void) | undefined;
  const effect = vi.fn();
  const simulate = vi.fn((value: RadiusScratchInput, owner: () => void, prune?: () => void) => {
    owner();
    before?.();
    owner();
    prune?.();
    effect(value);
    owner();
    return output;
  });
  const distribution: ControllerDistribution = {
    setup: () => undefined,
    validate: parseControllerCommand,
    ready: true,
    start: () => undefined,
    stop: async () => undefined,
    simulateRadiusScratch: simulate,
  };
  const authority = new ManagementAuthority({
    enabled: () => true,
    validate: parseControllerCommand,
  });
  const bridge = vi.fn(async () => null);
  authority.register("orca-organization-next", bridge);
  registerNativeRadiusScratch(authority, distribution);
  const open = () => authority.open(bundledTarget, () => principal)!;
  const run = (method: string, value: unknown = input) => {
    const invocation = open();
    return authority
      .invoke(invocation.id, "orca-organization-next", "one-call", { method, input: value })
      .finally(() => invocation.close());
  };
  return {
    authority,
    input,
    output,
    simulate,
    effect,
    bridge,
    run,
    paired: () => {
      principal = { ...principal, authentication: "paired-device", deviceId: "device" };
    },
    revokeDuring: () => {
      before = () => {
        principal = { ...principal, permissions: [] };
      };
    },
  };
}
test("Radius owner mapping uses actual parser and supplies no destructive closure for ordinary simulation", async () => {
  const f = await fixture();
  expect(await f.run("radius-scratch-simulate")).toEqual(f.output);
  expect(f.simulate).toHaveBeenCalledExactlyOnceWith(f.input, expect.any(Function), undefined);
  expect(f.effect).toHaveBeenCalledTimes(1);
  expect(f.bridge).not.toHaveBeenCalled();
});
test("Radius separate prune purpose requires literal confirmation and original current owner", async () => {
  const f = await fixture();
  await expect(f.run("radius-scratch-prune-and-simulate")).rejects.toThrow();
  expect(f.effect).not.toHaveBeenCalled();
  await f.run("radius-scratch-prune-and-simulate", { ...f.input, confirmDestructive: true });
  expect(f.simulate).toHaveBeenCalledExactlyOnceWith(
    f.input,
    expect.any(Function),
    expect.any(Function),
  );
  expect(f.bridge).not.toHaveBeenCalled();
});
test("Radius ordinary parser rejects caller paths and destructive confirmation before an effect", async () => {
  const f = await fixture();
  await expect(
    f.run("radius-scratch-simulate", { ...f.input, root: "/caller/path" }),
  ).rejects.toThrow();
  await expect(
    f.run("radius-scratch-simulate", { ...f.input, confirmDestructive: true }),
  ).rejects.toThrow();
  expect(f.simulate).not.toHaveBeenCalled();
});
test("Radius paired account manager cannot promote an owner scratch or prune purpose", async () => {
  const f = await fixture();
  f.paired();
  await expect(
    f.run("radius-scratch-prune-and-simulate", { ...f.input, confirmDestructive: true }),
  ).rejects.toThrow();
  expect(f.effect).not.toHaveBeenCalled();
  expect(f.bridge).not.toHaveBeenCalled();
});
test("Radius canonical management keys never permit a changed model fact or revision", async () => {
  const f = await fixture();
  await expect(
    f.run("radius-scratch-simulate", {
      ...f.input,
      plan: { ...f.input.plan, changes: [] },
    }),
  ).rejects.toThrow();
  await expect(
    f.run("radius-scratch-simulate", {
      ...f.input,
      expectedRevision: "changed",
    }),
  ).rejects.toThrow();
  expect(f.simulate).not.toHaveBeenCalled();
});
test("Radius original owner revoke during captured operation refuses before remaining effect", async () => {
  const f = await fixture();
  f.revokeDuring();
  await expect(f.run("radius-scratch-simulate")).rejects.toThrow();
  expect(f.effect).not.toHaveBeenCalled();
  expect(f.simulate).toHaveBeenCalledTimes(1);
});
