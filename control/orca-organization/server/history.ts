import { portable } from "./portable";
import {projectMessages,validateMessages,type WorkMessage} from '../shared/work-messages.mjs';
import {createHash} from 'node:crypto';
import type {PaseoApi} from '@getpaseo/client';
import {historyRpc,historyCursor,messageExcerpts} from '../shared/history';
import {bookActivitySchema} from '../shared/fleet';
import {pageRequest,pageResult} from '../shared/history.mjs';
import {enrollment,bounded,projectActivity} from './fleet';
import {localCall} from './management';
import {readOnlyNativeScope,type NativeScope} from './native-scope';
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function readHistory(input:unknown,paseo:PaseoApi,call=localCall){
 const a=historyRpc.input.parse(input),identity={sessionId:a.sessionId,taskId:a.taskId},row=(await enrollment(call)).find(r=>r.id===a.sessionId&&r.task===a.taskId);if(!row)throw Error('Session is not enrolled in this task');
 const route=(r:any)=>sha([r.id,r.task,r.host,r.mode,r.generation,r.remote??null,r.cwd??null]);
 const enrolledScope=route(row);
 let messages:WorkMessage[]|undefined,activity:any[]=[],cursor:any=null,observedAt=new Date().toISOString(),hasOlder=false,note='',unavailable=false;
 if(![portable.localHost, ...portable.hosts].some(h => h.name === row.host))throw Error('Activity host unsupported');
 try{
 if(row.host===portable.localHost.name){
  // U5-D09: identity from the native agent's own snapshot (read-only), never the controller's `observe` (not a read).
  const scope=(n:NativeScope)=>{const binding=[enrolledScope,...n.identity];return sha(a.includeMessages?[...binding,'messages-v1']:binding);};
  const before=await bounded(readOnlyNativeScope(paseo,row)),binding=scope(before),request=pageRequest(a.cursor,binding),p=await bounded(paseo.agents.ref(row.id).timeline.refetch(request));
  cursor=pageResult(p,request,binding,row.id).cursor;const after=await bounded(readOnlyNativeScope(paseo,row));if(scope(after)!==binding||before.lastUserAt!==after.lastUserAt)throw Error('Native identity changed during page');
  if(a.includeMessages)messages=projectMessages(p.entries);activity=projectActivity(p.entries.map(e=>({...e,id:String(e.seqStart)})));hasOlder=cursor!==null;
 }else if(row.host!==portable.localHost.name){
  let value:any,withMessages=a.includeMessages===true;
  try{value=await bounded(call('book-activity-page',a));}catch(error){
   if(!withMessages)throw error;
   // Older installed routes reject the optional message request. Preserve their
   // separately validated metadata page without inventing conversation excerpts.
   value=await bounded(call('book-activity-page',{...identity,cursor:a.cursor}));withMessages=false;
  }
  if(!value||!Object.hasOwn(value,'cursor'))throw Error('Remote history paging unsupported or unavailable');const {cursor:c,messages:reported,...base}=value,p=bookActivitySchema.parse(base);if(withMessages)messages=validateMessages(messageExcerpts.parse(reported),p.activity);else if(Object.hasOwn(value,'messages'))throw Error('Unexpected conversation excerpts');cursor=c===null?null:historyCursor.parse(c);
  if(p.sessionId!==row.id||p.taskId!==row.task||p.agentId!==row.remote?.agentId||p.hasOlder!==(cursor!==null))throw Error('Remote activity page identity changed');
  const age=Date.now()-Date.parse(p.observedAt);if(!Number.isFinite(age)||age< -5000||age>45000)throw Error('Remote activity page stale');activity=p.activity;hasOlder=cursor!==null;observedAt=p.observedAt;note=(a.includeMessages&&!withMessages?'Conversation messages unavailable; showing verified tool history. ':'')+`${p.skippedCount} entries excluded; ${p.withheldPaths} out-of-task paths withheld. `;
 }
 }catch(error){if(a.cursor!==null)throw error;activity=[];messages=undefined;cursor=null;hasOlder=false;unavailable=true;note='Native tool activity unavailable, stale or unsupported; receipts retained. No current activity is inferred. ';}
 let receiptNote='';const receipts=await bounded(call('activity-receipts',identity)).catch(()=>{receiptNote='Receipt metadata unavailable. ';return [];});const fresh=(await enrollment(call)).find(r=>r.id===row.id&&r.task===row.task);if(!fresh||route(fresh)!==enrolledScope)throw Error('Session route changed during page');
 return historyRpc.output.parse({observedAt,sessionId:row.id,taskId:row.task,activity,cursor,receipts,...(messages?{messages}:{}),note:receiptNote+note+(unavailable?'':`${a.cursor?'Earlier':'Latest'} page, up to 50 displayed entries. ${hasOlder?'Older history available.':'Start of available history.'} `)+(activity.length?activity.some(a=>a.kind==='tool_call')?'Full history coverage is unverified. ':'No tool events in this window; coverage unverified. ':'No summarizable activity in this window; coverage unverified. ')+'Reported tool paths are not verified changes; delivery is not acceptance.'});
}
