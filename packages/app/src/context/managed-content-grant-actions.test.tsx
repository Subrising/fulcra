import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import {
  ManagedContentGrantActions,
  type ManagedContentGrantActionsProps,
} from "./managed-content-grant-actions";
import {
  artifactToolSetRpc,
  artifactContentGrantSetRpc,
} from "../../../../control/orca-organization/shared/intercom";

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
const id = "00000000-0000-4000-8000-000000000001";
let root: Root;
let container: HTMLDivElement;
let controller: AbortController;
let props: ManagedContentGrantActionsProps;
let invoke: Mock<(name: string, raw: unknown) => Promise<unknown>>;
beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  controller = new AbortController();
  invoke = vi.fn(async (name: string, raw: unknown) => {
    if (name.endsWith("tool.set")) {
      const input = artifactToolSetRpc.input.parse(raw);
      return { messageId: input.messageId, enabled: true, expiresAt: input.expiresAt };
    }
    const input = artifactContentGrantSetRpc.input.parse(raw);
    return {
      grants: [
        {
          grantId: input.grantId,
          revision: id,
          identity: input.identity,
          expectedEpoch: input.expectedEpoch,
          scope: input.scope,
          artifactIds: input.artifactIds,
          byteBudget: input.byteBudget,
          expiresAt: input.expiresAt,
        },
      ],
    };
  });
  props = {
    runtime: { invoke },
    selection: {
      identity: { agentId: id, instanceId: id, sessionId: "native", boot: id },
      expectedEpoch: id,
      scope: { projectId: id, taskId: id },
    },
    artifactId: id,
    signal: controller.signal,
    checkOriginalLifetime: vi.fn(),
    onGrantConfirmed: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => root.render(<ManagedContentGrantActions {...props} />));
}
async function press(index: number) {
  await act(async () => container.querySelectorAll("button")[index]!.click());
}
test("owner controls have zero effects on mount and tool enable is a distinct explicit protected request", async () => {
  await mount();
  expect(invoke).not.toHaveBeenCalled();
  await press(0);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0]![0]).toBe("organization.intercom.artifacts.tool.set");
  expect(invoke.mock.calls[0]![1]).toMatchObject({ ...props.selection, enabled: true });
  expect(container.textContent).toContain("Host confirmed");
  expect(props.onGrantConfirmed).not.toHaveBeenCalled();
});
test("grant action enumerates only the explicitly selected artifact and never enables tools or reads", async () => {
  await mount();
  await press(1);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0]![0]).toBe("organization.intercom.artifacts.content.set");
  expect(invoke.mock.calls[0]![1]).toMatchObject({
    ...props.selection,
    artifactIds: [id],
    byteBudget: 8192,
    expectedGrantRevision: null,
    enabled: true,
  });
  expect(props.onGrantConfirmed).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("No content was read");
  expect(container.textContent).not.toContain(id);
});
test("missing committed selection cannot issue a grant", async () => {
  props.artifactId = null;
  await mount();
  await press(1);
  expect(invoke).not.toHaveBeenCalled();
});
test("lost acknowledgement and host refusal preserve uncertainty without automatic or explicit replay", async () => {
  invoke.mockRejectedValue(new Error("private path secret"));
  await mount();
  await press(1);
  await press(1);
  await press(0);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Action outcome unconfirmed");
  expect(container.textContent).not.toContain("private path secret");
});
test("held action abort purges and refuses late confirmation", async () => {
  let resolve!: (value: unknown) => void;
  invoke.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount();
  await press(0);
  await act(async () => controller.abort());
  const input = artifactToolSetRpc.input.parse(invoke.mock.calls[0]![1]);
  await act(async () =>
    resolve({ messageId: input.messageId, enabled: true, expiresAt: input.expiresAt }),
  );
  expect(container.textContent).not.toContain("Host confirmed");
  await press(0);
  expect(invoke).toHaveBeenCalledTimes(1);
});
test("original lifetime refusal prevents any owner effect", async () => {
  props.checkOriginalLifetime = () => {
    throw new Error("Revoked");
  };
  await mount();
  await press(0);
  expect(invoke).not.toHaveBeenCalled();
});
test("foreign confirmation cannot authorize or advertise a successful grant", async () => {
  invoke.mockResolvedValue({ grants: [] });
  await mount();
  await press(1);
  await press(1);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(props.onGrantConfirmed).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Action outcome unconfirmed");
});
