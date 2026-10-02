/** @vitest-environment jsdom */
import React from "react";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const calls = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), status: vi.fn() }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/text-input", () => ({
  EditingTextInput: ({
    initialValue,
    onChangeText,
    accessibilityLabel,
    editable,
  }: {
    initialValue: string;
    onChangeText(value: string): void;
    accessibilityLabel: string;
    editable: boolean;
  }) => {
    const change = React.useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value),
      [onChangeText],
    );
    return (
      <input
        aria-label={accessibilityLabel}
        defaultValue={initialValue}
        disabled={editable === false}
        onChange={change}
      />
    );
  },
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children: React.ReactNode;
    onPress(): void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../../../../control/orca-organization/shared/intercom", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../../control/orca-organization/shared/intercom")
  >()),
  intercomRateSettingsGetRpc: { name: "get" },
  intercomRateSettingsRpc: { name: "set" },
  intercomStatusRpc: { name: "status" },
}));
vi.mock("../../../../../control/orca-organization/client/use-contract", () => ({
  useContract: (contract: { name: string }) => {
    if (contract.name === "get") return calls.read;
    if (contract.name === "set") return calls.save;
    return calls.status;
  },
}));
import { IntercomSettingsSection } from "./intercom-section";
const theme = {
  colors: { foreground: "black", foregroundMuted: "gray", border: "gray" },
} as React.ComponentProps<typeof IntercomSettingsSection>["theme"];
const HOST = { id: "host", label: "Host" };
const LAYOUT = { compact: false, platform: "web" as const };
function mount() {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={query}>
      <IntercomSettingsSection theme={theme} host={HOST} layout={LAYOUT} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  calls.read.mockResolvedValue({ initialized: false, settings: null, windowMs: 3600000 });
  calls.save.mockResolvedValue({ duplicate: false });
});
afterEach(cleanup);
test("missing settings stay inactive until an explicit save", async () => {
  mount();
  await screen.findByText(/not initialized/);
  expect(calls.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
  await waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1));
  expect(calls.save.mock.calls[0][0]).toEqual({
    messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    settings: { report: 0, followup: 0, channel: 0, seat: 0 },
  });
});
test("owner refusal exposes no defaults or save control", async () => {
  calls.read.mockRejectedValue(new Error("Owner required"));
  mount();
  await screen.findByText(/Owner required/);
  expect(screen.queryByRole("button", { name: "Save limits" })).toBeNull();
  expect(calls.save).not.toHaveBeenCalled();
});
test("fractional and out-of-range values cannot be submitted", async () => {
  mount();
  await screen.findByText(/not initialized/);
  const input = screen.getByLabelText("Reports per hour");
  fireEvent.change(input, { target: { value: "1.5" } });
  expect(screen.getByRole("button", { name: "Save limits" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(input, { target: { value: "13" } });
  expect(screen.getByRole("button", { name: "Save limits" }).hasAttribute("disabled")).toBe(true);
  expect(calls.save).not.toHaveBeenCalled();
});
test("diagnostic details never render as defaults or raw errors", async () => {
  calls.read.mockRejectedValue(new Error("secret-shaped-fixture-diagnostic"));
  mount();
  await screen.findByText(/Intercom could not be read/);
  expect(screen.queryByText(/secret-shaped-fixture/)).toBeNull();
  expect(calls.save).not.toHaveBeenCalled();
});
