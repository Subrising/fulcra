// Run cleanTestEnv at test start: `node --import`, or a Vitest globalSetup or setupFiles entry.
import { cleanTestEnv } from "./clean-test-env.mjs";

cleanTestEnv();

export default function setup() {}
