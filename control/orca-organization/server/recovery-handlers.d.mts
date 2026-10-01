import type { RecoveryStatus } from '../shared/recovery-view.mjs';
export type RecoveryRead={status:'observed';observedAt:string;recovery:RecoveryStatus}|{status:'error';observedAt:string;message:string};
export type RecoveryActResult={status:string;message:string;observedAt:string;messageId?:string;results?:{sessionId:string;state:string;error:string|null}[]};
export function createRecovery(call:(method:string,input?:unknown)=>Promise<any>,now?:()=>string):{read():Promise<RecoveryRead>;act(input:unknown):Promise<RecoveryActResult>};
