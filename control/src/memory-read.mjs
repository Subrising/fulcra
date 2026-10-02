import { runtime, verifyPins } from "./runtime.mjs";
import { canonicalRoot, verifyCanonicalMemory } from "./canonical-memory-route.mjs";
verifyPins();
verifyCanonicalMemory();
process.stderr.write(
  JSON.stringify({
    component: "orca-memory-read",
    pid: process.pid,
    markerPresent: process.env.ORCA_TRIAL_RUN === runtime.marker,
  }) + "\n",
);
if (process.argv.length !== 2) throw new Error("Saved memory entry supports stdio only");
process.env.ORCA_MEMORY_RUN = "mini-saved-entry";
await import(`${canonicalRoot}/memory.mjs`);
