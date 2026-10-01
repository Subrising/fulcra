// PA21: personal installation data and credential-shaped values are never reviewable.
// Encoded roots keep detector definitions from becoming findings themselves.
export const credentialSource = String.raw`\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----`;
const credentials = new RegExp(credentialSource, "i");
export function personalBlocker(hit, vendor) {
 if(credentials.test(hit.pattern)) return 'credential-shaped value';
 if(/(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|srv_[a-z0-9]+|\.ts\.net|100\.90\.|\b[a-z0-9._%+-]+@)/i.test(hit.pattern)) return 'machine identifier';
 const home = hit.context.match(new RegExp(String.raw`(?<![A-Za-z0-9/}$])\x2fUsers\x2f([^\x00-\x20\x2f\\\s"'<>;]+)(?:\x2f|$)`, 'i'));
 if(home && !(vendor && home[1].toLowerCase()==='runner') && !['username','user','example','yourname','<name>'].includes(home[1].toLowerCase())) return 'personal home path';
 if(new RegExp(String.raw`(?<!\x2fSystem)\x2fVolumes\x2f[^\s"'<>]+`, 'i').test(hit.context)) return 'personal volume path';
 return null;
}
export function safeFinding(hit, blocker) {
 return blocker==='credential-shaped value' ? {...hit,pattern:'[credential-shaped value]',context:'[redacted credential-shaped value]'} : hit;
}
