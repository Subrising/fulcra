import { describe, expect, it } from "vitest";
import { resolveSingleInstanceOverride } from "./single-instance-override.js";

describe("single-instance lock override", () => {
  it("takes the lock by default", () => {
    expect(resolveSingleInstanceOverride({})).toBe("lock");
  });

  it("skips the lock only for an isolated test instance", () => {
    expect(
      resolveSingleInstanceOverride({
        PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1",
        PASEO_ELECTRON_USER_DATA_DIR: "/tmp/e2e-user-data",
      }),
    ).toBe("disabled");
  });

  it("ignores the override without a separate userData directory", () => {
    expect(resolveSingleInstanceOverride({ PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1" })).toBe(
      "ignored",
    );
    expect(
      resolveSingleInstanceOverride({
        PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1",
        PASEO_ELECTRON_USER_DATA_DIR: "  ",
      }),
    ).toBe("ignored");
  });
});
