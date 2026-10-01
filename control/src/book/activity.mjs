import {uuid} from '../control/authority.mjs';
import {exact} from './protocol.mjs';
import path from 'node:path';
const bounded = s => typeof s === 'string' && s.length <= 512 && s.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(s);
const toolName = s => typeof s === 'string' && /^[A-Za-z_][\w.:-]{0,127}$/.test(s);
const states = ['pending','running','completed','failed','cancelled','unknown'];
export function projectBookActivity(page,cwd) {
  if (!bounded(cwd) || !path.isAbsolute(cwd) || path.resolve(cwd)!==cwd) throw Error('Owned activity directory required');
  if (!page || page.error || page.gap || page.reset || page.staleCursor || page.hasNewer || !Array.isArray(page.entries) || page.entries.length > 50 || typeof page.hasOlder !== 'boolean') throw Error('Book canonical activity unavailable');
  const activity = [];let skippedCount=0,withheldPaths=0;
  for (const [index, e] of page.entries.entries()) {
    const item = e?.item, kind = item?.type;
    if (!['tool_call','user_message','assistant_message'].includes(kind)) {skippedCount++;continue;}
    const tool = kind === 'tool_call', d = item.detail;
    const reported=tool && ['read','edit','write'].includes(d?.type) && typeof d.filePath==='string',resolved=reported && bounded(d.filePath)?path.resolve(cwd,d.filePath):null,inside=resolved && bounded(resolved) && resolved.startsWith(cwd+'/');if(reported&&!inside)withheldPaths++;
    activity.push({id:String(Number.isSafeInteger(e.seqStart) && e.seqStart >= 0 ? e.seqStart : index),kind,
      label:tool ? toolName(item.name) ? item.name : 'Tool' : kind === 'user_message' ? 'User instruction' : 'Assistant response',
      state:tool ? states.includes(item.status) ? item.status : 'unknown' : null,
      files:inside && bounded(resolved)?[resolved]:[]});
  }
  return {activity,hasOlder:page.hasOlder,skippedCount,withheldPaths};
}
export function validateBookActivity(value,cwd) {
  if(!bounded(cwd)||!path.isAbsolute(cwd)||path.resolve(cwd)!==cwd)throw Error('Owned activity directory required');
  if (!exact(value,'activity,agentId,hasOlder,nativeId,observedAt,sessionId,skippedCount,taskId,withheldPaths') || !uuid(value.sessionId) || !uuid(value.taskId) || !uuid(value.agentId) || (value.nativeId !== null && !uuid(value.nativeId)) || !bounded(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) || typeof value.hasOlder !== 'boolean' || !Array.isArray(value.activity) || value.activity.length > 50 || !Number.isSafeInteger(value.skippedCount) || value.skippedCount<0 || value.skippedCount+value.activity.length>50 || !Number.isSafeInteger(value.withheldPaths) || value.withheldPaths<0 || value.withheldPaths>value.activity.length) throw Error('Invalid Book activity response');
  for (const a of value.activity) {
    if (!exact(a,'files,id,kind,label,state') || typeof a.id !== 'string' || !/^\d{1,16}$/.test(a.id) || !['tool_call','user_message','assistant_message'].includes(a.kind) || !Array.isArray(a.files) || a.files.length > 1 || !a.files.every(f=>bounded(f)&&path.isAbsolute(f)&&path.resolve(f)===f&&f.startsWith(cwd+'/'))) throw Error('Invalid Book activity row');
    if (a.kind === 'tool_call' ? !toolName(a.label) || !states.includes(a.state) : a.state !== null || a.files.length || a.label !== (a.kind === 'user_message' ? 'User instruction' : 'Assistant response')) throw Error('Invalid Book activity summary');
  }
  return value;
}
