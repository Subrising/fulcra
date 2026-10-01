import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firstRun } from '../src/config.mjs';
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-config-')));
process.env.ORCA_HOME = home;
firstRun();
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
