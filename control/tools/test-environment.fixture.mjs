// Isolated test installation. Never reads a running host or an operator's state.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { firstRun } from '../src/config.mjs';
const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cc-suite-'));
process.env.ORCA_HOME = home;
const c = firstRun();
const file = path.join(home, 'config.json'), config = JSON.parse(fs.readFileSync(file));
config.localHost.name = 'mini';
config.hosts = [{ name: 'macbook', serverId: null }];
config.authority.issueApi = 'https://issues.example';
fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
process.once('exit', () => fs.rmSync(home, { recursive: true, force: true }));
