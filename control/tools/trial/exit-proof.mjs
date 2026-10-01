import {execFileSync} from 'node:child_process';
const sameLifetime=(a,b)=>a.pid===b.pid&&a.start===b.start&&a.uid===b.uid;
export function processTable(){
 return execFileSync('/bin/ps',['-axo','pid=,ppid=,uid=,lstart=,command='],{encoding:'utf8'}).trim().split('\n').map(line=>{
  const m=line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(.{24})\s+(.+)$/);
  if(!m)throw Error('Cannot verify process table');
  return {pid:Number(m[1]),ppid:Number(m[2]),uid:Number(m[3]),start:m[4],command:m[5]};
 });
}
export function descendants(table,roots){
 const found=new Map();for(const root of roots){const actual=table.find(p=>sameLifetime(p,root));if(actual)found.set(actual.pid,actual);}
 let changed=true;while(changed){changed=false;for(const row of table)if(!found.has(row.pid)&&found.get(row.ppid)?.uid===row.uid){found.set(row.pid,row);changed=true;}}
 return [...found.values()];
}
export async function waitForExit(owners,{read=processTable,pause=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=15000}={}){
 const deadline=Date.now()+timeoutMs;let survivors;
 do{const table=await read();survivors=owners.filter(owner=>table.some(row=>sameLifetime(owner,row)));
  if(!survivors.length)return {allExited:true,processes:owners.map(({pid,start,uid})=>({pid,start,uid,exited:true})),verifiedAt:new Date().toISOString()};
  if(Date.now()>=deadline)break;await pause(100);
 }while(true);
 throw Error('Owned processes still running: '+survivors.map(p=>p.pid).join(','));
}
