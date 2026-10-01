import { loadConfig } from '../config.mjs';
import path from 'node:path';
import { portable } from '../portable-config.mjs';
// Where this installation keeps its own state. Defined once here because provider-mode.mjs needs it and
// native.mjs imports provider-mode.mjs, so native.mjs cannot be the definition without a cycle.
export const CONTROLLER_HOME = portable.controller;
export const SETTINGS_FILE = 'config.json';
export const settingsPath = (home = CONTROLLER_HOME) => path.join(home, SETTINGS_FILE);
// One private config supplies the installation layer beneath per-spawn overrides.
export function installationConfig(home = CONTROLLER_HOME, config = portable) {
  return config ?? loadConfig({ ORCA_HOME: home });
}
// Where an operator edits this, and whether they have. Reported by the session-defaults RPC so the
// question "what will a new session get, and where do I change it" has one answer.
export function settingsStatus(home = CONTROLLER_HOME, config = portable) {
  config ??= loadConfig({ ORCA_HOME: home });
  return { kind: 'portable', path: path.join(config.home, 'config.json'), key: 'defaults', present: true };
}

// Pure renderer for the read-only operator view. It exists because of a real trap: a controller that
// predates this feature serves a session-defaults response with NO `settings` field, and it neither reads
// nor reports session-defaults.json. So an operator can write the file, see no error, and get nothing --
// a silent no-op that looks like a broken setting rather than a controller that has not been updated.
//
// `live` is the session-defaults RPC result from the RUNNING controller; `local` is settingsStatus() read
// from this checkout. The mismatch between them is the whole point, so it is stated first.
export function describeSessionDefaults(live, local) {
  if (!live || live.__error) return [`error: ${live?.__error ?? 'no response'}`];
  const served = Object.hasOwn(live, 'settings');
  const lines = [`file: ${local.path}  (${local.present ? 'present' : 'absent'})`];
  if (!served) lines.push('THE RUNNING CONTROLLER DOES NOT SERVE THIS SETTING -- it predates the feature.'
    + (local.present ? ' The file above is NOT in effect: writing it changes nothing until the controller runs code that reads it.'
                     : ' Writing the file above would change nothing until then.'));
  else if (live.settings?.path !== local.path) lines.push(`the running controller reads a DIFFERENT file: ${live.settings?.path ?? 'unknown'}`);
  for (const [provider, chosen] of Object.entries(live.providers ?? {})) {
    lines.push(`${provider.padEnd(7)} mode=${chosen.modeId} (${chosen.source?.modeId ?? '?'})`
      + `  thinking=${chosen.thinkingOptionId} (${chosen.source?.thinkingOptionId ?? '?'})`
      + `  ask=${chosen.ask?.length ? chosen.ask.join('+') : 'none'} (${chosen.source?.ask ?? 'not reported'})`
      // A bare family is reported as what it MEANS rather than as the string, because 'claude' printed in
      // a model column reads as a missing value and is in fact the setting that tracks the host.
      + `  model=${chosen.model ? (chosen.modelFollowsProviderDefault ? `${chosen.model} (provider default, ${chosen.source?.model ?? '?'})` : `${chosen.model} (${chosen.source?.model ?? '?'})`) : 'not reported'}`
      + (chosen.askConfiguredWithAutomatic ? '  <-- ASK LIST CONFIGURED ALONGSIDE THE AUTOMATIC MODE' : ''));
  }
  return lines;
}
