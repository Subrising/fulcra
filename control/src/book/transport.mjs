import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { secret, sign, verify, digest } from './protocol.mjs';
import { loadConfig } from '../config.mjs';
export function privateProfile(file) {
  if(fs.realpathSync(file)!==file)throw Error('Profile path changed');
  const s=fs.statSync(file);if(!s.isFile()||s.uid!==process.getuid()||s.mode&0o077||s.size>16384)throw Error('Private bounded profile required');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
// Cutover: the Book ssh target stays PINNED, but by the owner-only portable config (hosts[] entry for the Book, whose
// sshTarget config.mjs validates), not by a literal in shipped code: personal addresses may not enter the packaged bundle.
export function pinnedBookTarget(load = loadConfig) {
  let config; try { config = load(); } catch { return null; }
  const hosts = config.hosts ?? [], book = hosts.find(h => h.name === 'macbook') ?? (hosts.length === 1 ? hosts[0] : null);
  return typeof book?.sshTarget === 'string' && /^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/.test(book.sshTarget) ? book.sshTarget : null;
}
export function sshExchange(profile, wire, pinned = pinnedBookTarget()) {
  if(profile.host!=='macbook'||!pinned||profile.sshTarget!==pinned||!Array.isArray(profile.command)||profile.command.length!==3||profile.command.some(s=>typeof s!=='string'||!s.startsWith('/')||/[\n\r\0]/.test(s)))throw Error('Unsupported Book transport profile');
  return new Promise((resolve,reject)=>{
    const child=execFile('/usr/bin/ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=yes',profile.sshTarget,profile.command.map(quote).join(' ')],{timeout:25000,maxBuffer:1048576},(e,stdout)=>{if(e)return reject(Error('Book receiver transport unavailable or uncertain: '+e.code));try{resolve(JSON.parse(stdout));}catch{reject(Error('Invalid receiver response; no retry'));}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(wire));
  });
}
export function receiverTransport(profile, key, exchange=wire=>sshExchange(profile,wire)) {
  return async (action,input)=>{
    const body={version:1,controller:profile.controller,host:'macbook',requestId:randomUUID(),action,input};
    const reply=verify(await exchange(sign(body,key)),key);
    if(reply.requestHash!==digest(body))throw Error('Receiver response identity mismatch');
    if(reply.error)throw Error(reply.error);return reply.result;
  };
}
export function configuredBook(file) { if(!file)return undefined;const p=privateProfile(file);return receiverTransport(p,secret(p.keyFile)); }
