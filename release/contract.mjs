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
