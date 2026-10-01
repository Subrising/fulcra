// Retained historical integrations and patch tooling are not portable release inputs.
export const excluded = [
  'orca-ingress/', 'orca-conversation/', 'orca-operations/', 'provider-patches/', 'service-recovery/',
  'src/book/', 'src/control/host-native.mjs', 'src/control/remote-resumption.mjs', 'src/control/remote-permissions.mjs',
  'src/control/release-paths.mjs', 'src/control/activation.mjs', 'src/control/activation-preflight.mjs', 'src/control/admission-guard.mjs',
  'src/control/admission-guard-precondition.mjs', 'src/control/native-release-hooks.mjs',
  'src/control/stage-native-turn.mjs', 'src/control/deploy-admission.mjs', 'src/control/deploy-readiness.mjs',
  'src/control/native-turn.mjs', 'src/control/permission-overlay.py', 'src/control/process.py',
];
export const fixture = name => /(?:\.test\.|\.fixture\.|\.mutations\.|\.integration\.|\/screens\/|\/fixtures\/|\/test-support\.|\/host-test-support\.|\/harness\.|\/wiring-test-adapters\.|\/ui-test-adapters\.)/.test(name);
// Frozen cutover A1 restores these reviewed Mini-side Book dependencies.
// Keep the receiver, deployment and historical tooling outside release inputs.
export const cutoverBookInputs = new Set([
  'src/control/host-native.mjs', 'src/control/remote-permissions.mjs', 'src/control/remote-resumption.mjs',
  'src/book/transport.mjs', 'src/book/protocol.mjs', 'src/book/activity.mjs', 'src/book/activity-page.mjs',
]);
export function inScope(name) {
  if (cutoverBookInputs.has(name)) return true;
  if (fixture(name) || excluded.some(p => p.endsWith('/') ? name.startsWith(p) : name === p)) return false;
  return /^(?:src\/control\/.*\.(?:mjs|json)|src\/(?:config|portable-config|local-machine|runtime|daemon|revise|canonical-memory-route)\.(?:mjs|d\.mts)|src\/portable-memory\/.*\.mjs|orca-organization\/(?:client|server|shared)\/.*\.(?:mjs|ts|tsx|mts)|orca-organization\/(?:index\.(?:server\.ts|client\.tsx|host\.js)|paseo-plugin\.json|package\.json)|orca-command\/src\/workspace\.mjs|tools\/.*\.mjs|package(?:-lock)?\.json)$/.test(name);
}
