import { describe, expect, it } from "vitest";

describe("test environment", () => {
  it("does not inherit FULCRA_* or live daemon values from the shell", () => {
    const leaked = Object.keys(process.env).filter(
      (name) => name.startsWith("FULCRA_") && !name.startsWith("FULCRA_TEST_"),
    );
    expect(leaked).toEqual([]);
    expect(process.env.PASEO_DAEMON_SERVER_ID).toBeUndefined();
    expect(process.env.PASEO_AGENT_ID).toBeUndefined();
  });
});
