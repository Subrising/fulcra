import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function sealBundle(app){
 const root=fs.realpathSync(app),entries=[];
 function walk(dir){for(const name of fs.readdirSync(dir).sort()){
  const file=path.join(dir,name),relative=path.relative(root,file),stat=fs.lstatSync(file);
  if(stat.isSymbolicLink()){
   const resolved=fs.realpathSync(file);if(resolved!==root&&!resolved.startsWith(root+path.sep))throw Error('Bundle link escapes root');
   entries.push({file:relative,link:fs.readlinkSync(file)});
  }else if(stat.isDirectory())walk(file);
  else if(stat.isFile())entries.push({file:relative,sha256:sha(fs.readFileSync(file)),mode:stat.mode&0o777});
  else throw Error('Unsupported bundle entry');
 }}walk(root);
 if(!entries.some(e=>e.file==='Contents/MacOS/Fulcra')||!entries.some(e=>e.file==='Contents/Resources/app.asar'))throw Error('Fulcra app entries missing');
 return {schema:1,kind:'fulcra-trial-bundle',sha256:sha(JSON.stringify(entries)),entries};
}
export function verifyBundle(app,pin){const now=sealBundle(app);if(pin?.schema!==1||pin.kind!==now.kind||now.sha256!==pin.sha256||sha(JSON.stringify(pin.entries))!==pin.sha256)throw Error('Trial bundle digest mismatch');return now;}
export function sameProcess(a,b){return !!a&&!!b&&['pid','start','uid','entry'].every(k=>a[k]!==undefined&&a[k]===b[k]);}
export function createPrivateRun(destination,port){
 if(!Number.isInteger(port)||port<1024||port>65535||[6767,67_91].includes(port))throw Error('Unsafe trial port');
 const root=path.join(fs.realpathSync(path.dirname(path.resolve(destination))),path.basename(destination));
 fs.mkdirSync(root,{mode:0o700});
 for(const dir of ['home','paseo','user-data','tmp','app-logs','evidence'])fs.mkdirSync(path.join(root,dir),{mode:0o700});
 const config={version:1,daemon:{listen:`127.0.0.1:${port}`,relay:{enabled:false}},agents:{providers:Object.fromEntries(['claude','codex','opencode','pi'].map(id=>[id,{enabled:false}]))}};
 fs.writeFileSync(path.join(root,'paseo/config.json'),JSON.stringify(config),{mode:0o600,flag:'wx'});
 return {schema:1,kind:'PRIVATE-HOME + FAKE-KEYCHAIN; NOT ISOLATED ACCOUNT',root,port};
}
export function identifyProcess(line,{pid,uid,entry,executables=[]}){
 const match=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
 if(!match||Number(match[1])!==pid||Number(match[3])!==uid)throw Error('Trial PID/entry identity unavailable');
 const command=match[5].trim(),named=command===entry||command.startsWith(entry+' ')||command.endsWith(' '+entry);
 if(!named&&!executables.includes(entry))throw Error('Trial PID/entry identity unavailable');
 return {pid,ppid:Number(match[2]),uid,start:match[4],entry,command};
}
