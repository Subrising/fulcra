// G1 screenshot shim for "@getpaseo/plugin/client": every read is answered from the LaunchPad fixtures.
import { fixture } from "../launchpad-fixtures.mjs";
export function useRpc(definition) { return input => fixture(definition.name, input); }
