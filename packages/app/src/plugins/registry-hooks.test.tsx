/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.mock("./evaluate", () => ({
  runPluginClientBundle: vi.fn(),
}));
vi.mock("./client-runtime", () => ({
  createPluginClientRuntime: vi.fn(),
}));

vi.mock("./bundle-trust", () => ({
  isPluginBundleTrusted: () => false,
  PLUGIN_TRUST_EXPLANATION: "Plugin not trusted on this Mac",
}));

import { usePluginInstallations } from "./registry";

it("keeps plugin installation selections stable while the registry is unchanged", () => {
  const { result, rerender } = renderHook(() => usePluginInstallations("missing-plugin"));
  const initialInstallations = result.current;

  rerender();

  expect(result.current).toBe(initialInstallations);
});

it("updates the surface error after a refused catalog even though no plugin installs", async () => {
  const { act } = await import("@testing-library/react");
  const { pluginRegistry, usePluginEvaluationError } = await import("./registry");
  const client = {} as import("@getpaseo/client/internal/daemon-client").DaemonClient;
  const host = "refused-catalog-hook";
  const { result, unmount } = renderHook(() => usePluginEvaluationError(host, "fixture"));
  expect(result.current).toBeUndefined();
  try {
    act(() =>
      pluginRegistry.installCatalog(host, [{ id: "fixture", clientBundle: "not executable" }], {
        client,
      }),
    );
    expect(result.current).toBe("Plugin not trusted on this Mac");
    expect(result.current).toBe(pluginRegistry.getEvaluationError(host, "fixture"));
    act(() => pluginRegistry.removeHost(host));
    expect(result.current).toBeUndefined();
  } finally {
    unmount();
    pluginRegistry.removeHost(host);
  }
});
