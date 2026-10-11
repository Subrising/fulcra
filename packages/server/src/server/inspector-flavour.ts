// A packaged daemon must not open a Node inspector on SIGUSR1: any process of the same user could then run code
// inside the daemon (FU-79). The one switch is this constant. It is compiled in and has no run-time input: no
// environment variable, no file, no argument. A release build keeps it false. The gate build
// (scripts/build-gate-flavour.mjs) rewrites this one line in the built output, so the hang and restart gates can
// block a worker through the inspector. That is the only difference between the two builds.
export const GATE_FLAVOUR = false;

/** Node flags every packaged daemon process starts with. */
export function packagedInspectorFlags(): string[] {
  return GATE_FLAVOUR ? [] : ["--disable-sigusr1"];
}
