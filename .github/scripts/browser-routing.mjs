import path from "node:path";

// These contracts need Metro's fixture entry point or React's development profiler.
// Keep them in the required Metro lane. A production export cannot prove them.
export function needsMetro(test) {
  const file = path.basename(test.location.file);
  return (
    file === "root-error-recovery.spec.ts" ||
    file === "agent-stream-smoothness.spec.ts" ||
    // FULCRA(FU-657): Paseo v0.15.0 specs that read React Profiler samples or component names.
    // A production export calls no Profiler onRender and minifies component names.
    file === "explorer-resize-performance.spec.ts" ||
    (file === "tool-call-overview-sheet.spec.ts" &&
      test.title.startsWith("keeps an opened lone tool call open when it becomes a group")) ||
    (file === "viewed-agent-timelines.spec.ts" &&
      test.title === "a hidden retained chat stays current without rendering")
  );
}
