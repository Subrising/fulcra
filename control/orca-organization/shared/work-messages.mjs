const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys;
const safeText=s=>typeof s==='string'&&s.length>0&&s.length<=2000&&!/[\uD800-\uDFFF]/u.test(s)&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(s);
export function validateMessages(messages,activity){
 if(!Array.isArray(messages)||messages.length>6)throw Error('Invalid conversation excerpts');
 let previous=-1;
 for(const m of messages){
  if(!exact(m,'id,role,text,truncated')||typeof m.id!=='string'||!/^\d{1,16}$/.test(m.id)||!Number.isSafeInteger(Number(m.id))||Number(m.id)<=previous||!['instruction','agent'].includes(m.role)||!safeText(m.text)||typeof m.truncated!=='boolean')throw Error('Invalid conversation excerpt');
  previous=Number(m.id);
  if(activity&&!activity.some(a=>a.id===m.id&&a.kind===(m.role==='agent'?'assistant_message':'user_message')))throw Error('Conversation excerpt outside activity page');
 }
 return messages;
}
/** Copy message text only. Tool payloads, thinking and provider metadata stay out. */
export function projectMessages(entries){
 const messages=[];
 for(const e of entries.slice(-50)){
  const item=e?.item;
  if(!['user_message','assistant_message'].includes(item?.type)||typeof item.text!=='string'||!item.text.trim())continue;
  if(!Number.isSafeInteger(e.seqStart)||e.seqStart<0)throw Error('Conversation message identity unavailable');
  const clean=item.text.replace(/[\uD800-\uDFFF]/gu,'\uFFFD').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,'');
  if(!clean.trim())continue;
  let text=clean.slice(0,2000);if(/[\uD800-\uDFFF]/u.test(text))text=text.slice(0,-1);
  messages.push({id:String(e.seqStart),role:item.type==='user_message'?'instruction':'agent',text,truncated:clean.length>text.length});
 }
 return validateMessages(messages.slice(-6));
}
