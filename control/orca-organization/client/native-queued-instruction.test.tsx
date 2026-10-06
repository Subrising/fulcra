import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { NativeQueuedInstruction } from "./native-queued-instruction";
const rpc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./use-contract", () => ({ useContract: () => rpc.invoke }));
vi.mock("react-native", () => ({
  View: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Text: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    editable,
  }: {
    value: string;
    onChangeText: (v: string) => void;
    editable: boolean;
  }) => {
    const onInput = React.useCallback(
      (event: React.FormEvent<HTMLInputElement>) => onChangeText(event.currentTarget.value),
      [onChangeText],
    );
    return <input value={value} disabled={!editable} onInput={onInput} />;
  },
  Pressable: ({
    children,
    onPress,
    disabled,
  }: React.PropsWithChildren<{ onPress: () => void; disabled: boolean }>) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
const id = "00000000-0000-4000-8000-000000000001";
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
  rpc.invoke.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
const colors = {
  foreground: "black",
  foregroundMuted: "gray",
  accent: "blue",
  accentForeground: "white",
  border: "gray",
};
function makeTarget(
  generation: number,
): React.ComponentProps<typeof NativeQueuedInstruction>["target"] {
  return { id, generation, mode: "delegated" };
}
async function mount(fresh = true, generation = 2) {
  const target = makeTarget(generation);
  await act(async () =>
    root.render(
      <NativeQueuedInstruction target={target} fresh={fresh} hostId="host" colors={colors} />,
    ),
  );
}
async function type(value = "bounded draft") {
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}
async function send() {
  await act(async () => container.querySelector("button")!.click());
}
test.each([
  { label: "at", text: "🙂".repeat(4096), calls: 1 },
  { label: "above", text: "🙂".repeat(4097), calls: 0 },
])(
  "browser UTF-8 cap $label 16 KiB preserves original dispatch boundary",
  async ({ text, calls }) => {
    rpc.invoke.mockResolvedValue({ ok: false, dispatched: false, code: "unauthorised" });
    await mount();
    await type(text);
    await send();
    expect(rpc.invoke).toHaveBeenCalledTimes(calls);
    if (calls) expect(rpc.invoke.mock.calls[0]![0].input.text).toBe(text);
  },
);
test("explicit protected operator queue uses one immutable attempt and displays queued separately from delivery", async () => {
  rpc.invoke.mockImplementation(async (raw) => ({
    ok: true,
    result: {
      id: raw.input.messageId,
      session: id,
      kind: "send",
      state: "queued",
      body: "PRIVATE BODY",
      result: {
        nativeReceipt: {
          messageId: "orca-control:" + raw.input.messageId,
          state: "queued",
          pendingCount: 1,
        },
      },
    },
  }));
  await mount();
  expect(rpc.invoke).not.toHaveBeenCalled();
  await type();
  await send();
  await send();
  expect(rpc.invoke).toHaveBeenCalledTimes(1);
  expect(rpc.invoke.mock.calls[0]![0]).toMatchObject({
    method: "operator-native-queue",
    input: { sessionId: id, expectedGeneration: 2, text: "bounded draft" },
  });
  expect(container.textContent).toContain("Message queued");
  expect(container.textContent).not.toContain("PRIVATE BODY");
  expect(container.querySelector("input")!.value).toBe("bounded draft");
});
test.each([false, true])(
  "host refusal/uncertainty retains draft without resend (dispatched=%s)",
  async (dispatched) => {
    rpc.invoke.mockResolvedValue({
      ok: false,
      dispatched,
      code: dispatched ? "uncertain" : "unauthorised",
      message: "PRIVATE ERROR",
    });
    await mount();
    await type();
    await send();
    await send();
    expect(rpc.invoke).toHaveBeenCalledTimes(1);
    expect(container.querySelector("input")!.value).toBe("bounded draft");
    expect(container.textContent).not.toContain("PRIVATE ERROR");
  },
);
test("unmarked lost acknowledgement cannot replay or claim no durable admission", async () => {
  rpc.invoke.mockRejectedValue(new Error("lost acknowledgement"));
  await mount();
  await type();
  await send();
  await send();
  expect(rpc.invoke).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Outcome unconfirmed");
});
test("held generation replacement refuses old publication and keeps original attempt", async () => {
  let resolve!: (output: unknown) => void;
  rpc.invoke.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount();
  await type();
  await send();
  await mount(true, 3);
  await act(async () => resolve({ ok: true, result: {} }));
  expect(container.textContent).not.toContain("Message queued");
  await send();
  expect(rpc.invoke).toHaveBeenCalledTimes(1);
});
test("stale management availability is not action rights", async () => {
  await mount(false);
  await type();
  await send();
  expect(rpc.invoke).not.toHaveBeenCalled();
});
