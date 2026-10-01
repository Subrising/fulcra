// CONTRACTS v1.8 §3.6 rules 2 and 5 (R2-4): a device described in words, shared by the controller's security
// alerts and the app's Devices list. Platform and protection level are as the device reported them at pairing.
export const PLATFORM_NAME = Object.freeze({ macos: 'Mac', ios: 'iPhone', android: 'Android phone', windows: 'Windows PC', linux: 'Linux computer' });
export function protectionText(d) {
  if (d.keyStorage === 'software') return 'Not protected by hardware';
  if (!d.userPresence) return 'Protected by your login only';
  if (d.platform === 'macos') return 'Protected by Touch ID';
  if (d.platform === 'ios') return 'Protected by Face ID or Touch ID';
  if (d.platform === 'android') return 'Protected by your fingerprint or face';
  return 'Protected by your device sign-in';
}
// "Test Phone · iPhone · Protected by Face ID or Touch ID"
export const deviceLine = d => `${d.label} · ${PLATFORM_NAME[d.platform] ?? d.platform} · ${protectionText(d)}`;
