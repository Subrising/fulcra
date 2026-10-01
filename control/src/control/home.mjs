import { loadConfig } from '../config.mjs';
export function controlHome(env = process.env) { return loadConfig(env).home; }
