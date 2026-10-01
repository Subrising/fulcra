import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const helper = fileURLToPath(new URL('../watch-child.mjs',import.meta.url));
// Test cleanup is independent of the mutated lifecycle implementation. It only
// signals a fixture's registered child with matching birth, command and nonce.
export async function cleanupRegistry(directory) {
 for(const name of await fs.readdir(directory).catch(()=>[])) {
  if(!/^[a-f0-9]{32}\.json$/.test(name)) continue;
  let row;try{row=JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));}catch{continue;}
  if(row.helper!==helper||row.nonce!==name.slice(0,32)||!Number.isSafeInteger(row.pid)||row.pid<2||row.command!==process.execPath+' '+helper+' '+row.nonce)continue;
  let current;try{current=execFileSync('/bin/ps',['-p',String(row.pid),'-o','lstart=','-o','command='],{encoding:'utf8',timeout:2000,env:{LC_ALL:'C',PATH:'/usr/bin:/bin'}}).trim().replace(/\s+/g,' ');}catch{continue;}
  if(current===row.started+' '+row.command)try{process.kill(row.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
 }
}
