#!/usr/bin/env node
// Tests and gates only (B6): a stand-in for /usr/bin/security that keeps generic passwords as 0600 files in a scratch
// directory -- the "keychain" argument names that directory. It never runs the real `security`, so no keychain is
// created and the user's keychain search list is never touched. It understands exactly what accounts.mjs sends:
//   security -i   <stdin: add-generic-password -U -s "<service>" -a "<account>" -w "<secret>" "<dir>">
//   security find-generic-password -s <service> -a <account> -w <dir>
//   security delete-generic-password -s <service> -a <account> <dir>
// Every argv is appended to <dir>/argv.log, so a test can prove the secret never reached argv.
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto';
const fail = (msg, code = 44) => { process.stderr.write(msg + '\n'); process.exit(code); };
const opts = (cmd, words) => { const o = { rest: [] }; for (let i = 0; i < words.length; i++) { const w = words[i]; if (/^-[saw]$/.test(w) && i + 1 < words.length && !(w === '-w' && cmd === 'find-generic-password')) o[w] = words[++i]; else if (w.startsWith('-')) o[w] = true; else o.rest.push(w); } return o; };
const file = (dir, o) => path.join(dir, createHash('sha256').update(`${o['-s']}\0${o['-a']}`).digest('hex'));
function run(words) {
  const [cmd, ...args] = words, o = opts(cmd, args), dir = o.rest.at(-1);
  if (!dir || !path.isAbsolute(dir)) fail('fake security: a scratch keychain directory is required', 50);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, 'argv.log'), JSON.stringify(process.argv.slice(2)) + '\n', { mode: 0o600 });
  if (cmd === 'add-generic-password') { fs.writeFileSync(file(dir, o), String(o['-w'] ?? ''), { mode: 0o600 }); return; }
  if (cmd === 'find-generic-password') { try { process.stdout.write(fs.readFileSync(file(dir, o), 'utf8') + '\n'); } catch { fail('The specified item could not be found in the keychain.'); } return; }
  if (cmd === 'delete-generic-password') { try { fs.rmSync(file(dir, o)); } catch { fail('The specified item could not be found in the keychain.'); } return; }
  fail(`fake security: unsupported command ${cmd}`, 2);
}
const argv = process.argv.slice(2);
if (argv[0] === '-i') {
  let input = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { input += c; });
  process.stdin.on('end', () => { for (const line of input.split('\n').filter(Boolean)) run([...line.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2])); });
} else run(argv);
