const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys;
const epoch=s=>typeof s==='string'&&s.length>0&&s.length<=256&&!/[\uD800-\uDFFF]/u.test(s)&&!Array.from(s).some(c=>c.codePointAt(0)<32||c.codePointAt(0)===127),seq=n=>Number.isSafeInteger(n)&&n>=0;
export const validCursor=c=>exact(c,'epoch,scope,seq')&&typeof c.scope==='string'&&/^[a-f0-9]{64}$/.test(c.scope)&&epoch(c.epoch)&&seq(c.seq);
export function pageRequest(cursor,scope){
 if(!/^[a-f0-9]{64}$/.test(scope)||cursor!=null&&(!validCursor(cursor)||cursor.scope!==scope))throw Error('Activity cursor identity changed; return to latest');
 return Object.freeze({limit:50,projection:'canonical',direction:cursor?'before':'tail',...(cursor?{cursor:Object.freeze({epoch:cursor.epoch,seq:cursor.seq})}:{})});
}
export function pageResult(p,request,scope,agentId){
 const projected=p?.projection==='projected',position=c=>exact(c,'epoch,seq')&&c.epoch===p.epoch&&seq(c.seq);
 if(!p||p.agentId!==agentId||p.direction!==request.direction||!['canonical','projected'].includes(p.projection)||!epoch(p.epoch)||p.error||p.gap||p.reset||p.staleCursor||typeof p.hasOlder!=='boolean'||typeof p.hasNewer!=='boolean'||!Array.isArray(p.entries)||p.entries.length>(projected&&request.direction==='tail'?2048:50)||request.direction==='tail'&&p.hasNewer||request.cursor&&request.cursor.epoch!==p.epoch)throw Error('Activity page changed or unavailable; return to latest');
 if(projected&&(!p.window||!seq(p.window.minSeq)||!seq(p.window.maxSeq)||p.window.minSeq>p.window.maxSeq))throw Error('Activity window changed');
 let last=-1;for(const e of p.entries){
  if(!seq(e.seqStart)||!seq(e.seqEnd)||e.seqEnd<e.seqStart||e.seqStart<=last||request.cursor&&(projected?e.seqStart:e.seqEnd)>=request.cursor.seq||projected&&(e.seqStart<p.window.minSeq||e.seqEnd>p.window.maxSeq))throw Error('Activity page order changed');
  // Projected tool lifecycles overlap other rows; backward paging follows display anchors.
  last=projected?e.seqStart:e.seqEnd;
 }
 if(p.entries.length){
  if(!position(p.startCursor)||!position(p.endCursor)||p.startCursor.seq!==p.entries[0].seqStart||p.endCursor.seq<last||!projected&&p.endCursor.seq!==last||projected&&p.endCursor.seq!==(request.cursor?Math.min(p.window.maxSeq,request.cursor.seq-1):p.window.maxSeq))throw Error('Activity page boundary changed');
 }else if(p.startCursor!==null||p.endCursor!==null||p.hasOlder)throw Error('Activity page boundary changed');
 // A tail may expand to include an earlier tool lifecycle. Display at most 50 rows,
 // but resume from the first displayed anchor so omitted rows remain reachable.
 const older=p.hasOlder||p.entries.length>50,anchor=p.entries.slice(-50)[0]?.seqStart;
 if(older&&(!anchor||request.cursor&&anchor>=request.cursor.seq))throw Error('Activity cursor did not progress');
 return {cursor:older?{scope,epoch:p.epoch,seq:anchor}:null};
}
