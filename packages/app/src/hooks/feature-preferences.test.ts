import { describe, expect, it } from "vitest";

import { resolveFeatureValues } from "./feature-preferences";

describe("feature-preferences", () => {
  const features = [
    {
      type: "toggle" as const,
      id: "fast_mode",
      label: "Fast",
      value: false,
    },
    {
      type: "toggle" as const,
      id: "plan_mode",
      label: "Plan",
      value: false,
    },
  ];

  it("restores persisted values for available features", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          unknown_feature: true,
        },
        localFeatureValues: {},
      }),
    ).toEqual({
      fast_mode: true,
    });
  });

  it("prefers local values over persisted values", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          plan_mode: false,
        },
        localFeatureValues: {
          fast_mode: false,
        },
      }),
    ).toEqual({
      fast_mode: false,
      plan_mode: false,
    });
  });

  it("keeps profile values while the selected provider catalog is pending", () => {
    expect(
      resolveFeatureValues({
        features: undefined,
        persistedFeatureValues: { fast_mode: false },
        localFeatureValues: { fast_mode: true },
      }),
    ).toEqual({ fast_mode: true });
  });

  it("removes unavailable values after an empty catalog arrives", () => {
    expect(
      resolveFeatureValues({
        features: [],
        persistedFeatureValues: { fast_mode: true },
        localFeatureValues: { plan_mode: true },
      }),
    ).toEqual({});
  });

  it("waits for availability before restoring saved values", () => {
    expect(
      resolveFeatureValues({
        features: undefined,
        persistedFeatureValues: { unknown_feature: true },
        localFeatureValues: {},
      }),
    ).toEqual({});
  });
});
