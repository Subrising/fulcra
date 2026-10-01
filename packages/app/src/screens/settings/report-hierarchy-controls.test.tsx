import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ReportHierarchyControls } from "./report-hierarchy-controls";
import {
  prepareHierarchyRequest,
  snapshotReportRole,
  unchangedReportRole,
  type ReportRoleSnapshot,
} from "./report-hierarchy-model";
const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../../../../../control/orca-organization/client/use-contract", () => ({
  useContract: (contract: { name: string }) =>
    React.useMemo(() => (input: unknown) => rpc.call(contract.name, input), [contract.name]),
}));
vi.mock("react-native", () => ({
  View: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Text: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: React.PropsWithChildren<{ onPress: () => void; disabled?: boolean }>) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/text-input", () => ({
  EditingTextInput: ({
    initialValue,
    onChangeText,
    accessibilityLabel,
    editable,
  }: {
    initialValue: string;
    onChangeText: (value: string) => void;
    accessibilityLabel: string;
    editable: boolean;
  }) => {
    const change = React.useCallback(
      (event: React.FormEvent<HTMLInputElement>) => onChangeText(event.currentTarget.value),
      [onChangeText],
    );
    return (
      <input
        aria-label={accessibilityLabel}
        defaultValue={initialValue}
        disabled={!editable}
        onInput={change}
      />
    );
  },
}));
const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const project = "00000000-0000-4000-8000-000000000003";
const colors = { foreground: "black", foregroundMuted: "gray", border: "gray" };
const status = (agentId = a): ReportRoleSnapshot => ({
  version: 1,
  identity: { agentId, instanceId: agentId, sessionId: "native", boot: a },
  registration: {
    epoch: a,
    parent: null,
    scopes: [{ projectId: project, taskId: a }],
    primeRole: true,
    owningProjects: agentId === a ? [{ projectId: project, epoch: b }] : [],
  },
  queueAvailable: false,
  reportLinked: true,
  settingsInitialized: true,
  supportedProviders: ["codex"],
});
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  rpc.call.mockReset();
  rpc.call.mockImplementation(
    async (name: string, input: { agentId?: string; messageId?: string }) =>
      name.endsWith("status")
        ? status(input.agentId)
        : {
            messageId: input.messageId,
            epoch: b,
            duplicate: false,
            current: true,
            pendingDisposition: "fenced-retained-no-retarget",
          },
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => root.render(<ReportHierarchyControls hostId="host" colors={colors} />));
}
async function enter(label: string, value: string) {
  await act(async () => {
    const input = container.querySelector(`input[aria-label="${label}"]`)!;
    input.setAttribute("value", value);
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function press(text: string) {
  await act(async () => {
    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes(text),
    );
    expect(button).toBeDefined();
    button!.click();
  });
}
async function inspect(recipient = false) {
  await enter("Registered session to change", a);
  if (recipient) await enter("Registered upward parent or receiving prime", b);
  await press("Read current registrations");
}
test("role controls make no effects on mount and disclose upward children and retained old read scope", async () => {
  await mount();
  expect(rpc.call).not.toHaveBeenCalled();
  expect(container.textContent).toContain("re-parents children");
  expect(container.textContent).toContain("preserves the old owner’s read scope");
});
test("explicit promotion binds actual observed scopes and ownership epochs, rereads before one effect", async () => {
  await mount();
  await inspect();
  await press("Confirm promotion");
  expect(
    [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Read current registrations"),
    )?.disabled,
  ).toBe(true);
  const effects = rpc.call.mock.calls.filter(([name]) => name.endsWith("promote"));
  expect(effects).toHaveLength(1);
  expect(effects[0]![1]).toMatchObject({
    identity: status().identity,
    expectedEpoch: a,
    scopes: status().registration!.scopes,
    projects: [{ projectId: project, expectedOwnerEpoch: b }],
  });
  expect(rpc.call.mock.calls.filter(([name]) => name.endsWith("status"))).toHaveLength(2);
  expect(container.textContent).toContain("remain fenced");
});
test("explicit demotion retains exact upward parent and complete owned-project disposition", async () => {
  await mount();
  await inspect(true);
  await press("Confirm demotion");
  expect(rpc.call.mock.calls.find(([name]) => name.endsWith("demote"))?.[1]).toMatchObject({
    parent: status(b).identity,
    expectedParentEpoch: a,
    projects: [{ projectId: project, expectedOwnerEpoch: b }],
  });
});
test("explicit transfer uses only a selected observed owned project and registered recipient", async () => {
  await mount();
  await inspect(true);
  await press("Select owned project");
  await press("Confirm selected project transfer");
  expect(rpc.call.mock.calls.find(([name]) => name.endsWith("transfer"))?.[1]).toMatchObject({
    projectId: project,
    from: status().identity,
    expectedFromEpoch: a,
    to: status(b).identity,
    expectedToEpoch: a,
    expectedOwnerEpoch: b,
  });
});
test("registration replacement on awaited reread refuses effect and never retries", async () => {
  await mount();
  await inspect();
  rpc.call.mockResolvedValue({
    ...status(),
    registration: { ...status().registration!, epoch: b },
  });
  await press("Confirm promotion");
  expect(rpc.call.mock.calls.every(([name]) => name.endsWith("status"))).toBe(true);
  expect(container.textContent).toContain("not submitted");
});
test("owner refusal exposes no role controls or private detail", async () => {
  rpc.call.mockRejectedValue(new Error("private owner details"));
  await mount();
  await inspect();
  expect(container.textContent).toContain("Owner status unavailable");
  expect(container.textContent).not.toContain("private owner details");
  expect(
    [...container.querySelectorAll("button")].some((item) =>
      item.textContent?.includes("Confirm promotion"),
    ),
  ).toBe(false);
});
test("lost acknowledgement retains original attempt and prevents repeated action or auto read", async () => {
  await mount();
  await inspect();
  rpc.call.mockImplementation(async (name: string, input: { agentId?: string }) => {
    if (name.endsWith("status")) return status(input.agentId);
    throw new Error("private error");
  });
  await press("Confirm promotion");
  await press("Confirm promotion");
  expect(rpc.call.mock.calls.filter(([name]) => name.endsWith("promote"))).toHaveLength(1);
  expect(container.textContent).toContain("unconfirmed");
  expect(container.textContent).not.toContain("private error");
});
test("model refuses foreign current identity and unobserved project; changed epoch cannot stand in for original", () => {
  expect(() => snapshotReportRole(status(b), a)).toThrow();
  expect(() => prepareHierarchyRequest("transfer", status(), status(b), b, a)).toThrow();
  expect(() =>
    unchangedReportRole(status(), {
      ...status(),
      registration: { ...status().registration!, epoch: b },
    }),
  ).toThrow();
});

test("R25-5 promotion uses explicitly selected current owner project epoch without guessing unknown ownership", () => {
  const source = status(b);
  const owner = status(a);
  const input = prepareHierarchyRequest("promote", source, owner, "", b).input;
  expect(input).toMatchObject({
    identity: source.identity,
    expectedEpoch: a,
    projects: [{ projectId: project, expectedOwnerEpoch: b }],
  });
  expect(prepareHierarchyRequest("promote", source, null, "", b).input).toMatchObject({
    projects: [{ projectId: project, expectedOwnerEpoch: null }],
  });
});
