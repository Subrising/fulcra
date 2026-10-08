// A throwaway Command Centre state root for tests whose imports read installation settings at load time. Import it
// FIRST: modules evaluate in import order, so this runs before any module that reads ORCA_HOME.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstRun } from "../config.mjs";

export const stateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-state-")));
firstRun({ ORCA_HOME: stateRoot });
process.env.ORCA_HOME = stateRoot;
process.on("exit", () => fs.rmSync(stateRoot, { recursive: true, force: true }));
