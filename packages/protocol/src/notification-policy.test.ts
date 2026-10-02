import { describe, expect, it } from "vitest";
import { shouldNotifyForSession } from "./notification-policy.js";

const worker = { "fulcra.role": "implementation" };

describe("shouldNotifyForSession", () => {
  it("notifies primes and leads, not workers, in primes mode", () => {
    expect(shouldNotifyForSession({ mode: "primes", labels: { "fulcra.role": "orchestration" }, hasChildren: false })).toBe(true);
    expect(shouldNotifyForSession({ mode: "primes", labels: { "fulcra.role": "prime" }, hasChildren: false })).toBe(true);
    expect(shouldNotifyForSession({ mode: "primes", labels: worker, hasChildren: false })).toBe(false);
    expect(shouldNotifyForSession({ mode: "primes", labels: {}, hasChildren: false })).toBe(false);
  });

  it("treats a session with children as a lead", () => {
    expect(shouldNotifyForSession({ mode: "primes", labels: worker, hasChildren: true })).toBe(true);
  });

  it("notifies everything in all mode and nothing in off mode", () => {
    expect(shouldNotifyForSession({ mode: "all", labels: worker, hasChildren: false })).toBe(true);
    expect(shouldNotifyForSession({ mode: "off", labels: { "fulcra.role": "prime" }, hasChildren: true })).toBe(false);
  });

  it("lets the per-session toggle override the role but not the global off", () => {
    expect(shouldNotifyForSession({ mode: "primes", labels: { ...worker, "fulcra.notify": "on" }, hasChildren: false })).toBe(true);
    expect(shouldNotifyForSession({ mode: "all", labels: { "fulcra.notify": "off" }, hasChildren: false })).toBe(false);
    expect(shouldNotifyForSession({ mode: "off", labels: { "fulcra.notify": "on" }, hasChildren: false })).toBe(false);
  });
});
