import path from "node:path";

// These contracts need Metro's fixture entry point or React's development profiler.
// Keep them in the required Metro lane. A production export cannot prove them.
export function needsMetro(test) {
  const file = path.basename(test.location.file);
  return (
    file === "root-error-recovery.spec.ts" ||
    file === "agent-stream-smoothness.spec.ts" ||
    (file === "viewed-agent-timelines.spec.ts" &&
      test.title === "a hidden retained chat stays current without rendering")
  );
}
