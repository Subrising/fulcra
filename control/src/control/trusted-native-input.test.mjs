import test from 'node:test';
import assert from 'node:assert/strict';
import { DaemonRpcError } from './client-sdk.mjs';
import { isNativeAdmissionRefusal, boundNativeInputs } from './trusted-native-input.mjs';
test('only the complete typed host RPC outcome means refused; text and shapes mean uncertain',()=>{
 for(const error of [Error('Orca native admission refused'),{code:'admission_refused',nativeDispatched:false},new DaemonRpcError({requestId:'r',error:'refused',code:'handler_error'}),new DaemonRpcError({requestId:'r',error:'refused',code:'admission_refused'})])assert.equal(isNativeAdmissionRefusal(error),false);
 assert.equal(isNativeAdmissionRefusal(new DaemonRpcError({requestId:'r',error:'any diagnostic',code:'admission_refused',nativeDispatched:false})),true);
});
test('public input adapter requires fresh activation before and after provenance issuance',async()=>{
 let active=true,calls=0;const inputs=boundNativeInputs({daemon:{invokeRawInput:()=>{calls++;}},issueProvenance:async()=>{active=false;return'token';},verifyActivation:()=>{if(!active)throw Error('activation changed');}});
 await assert.rejects(inputs.send('agent','text','message','attempt'),/activation changed/);assert.equal(calls,0);
});

test('pre-mint activation refusal is definite and never mints or dispatches',async()=>{
 let minted=0,sent=0;const inputs=boundNativeInputs({daemon:{invokeRawInput:()=>sent++},issueProvenance:()=>minted++,verifyActivation:()=>{throw Error('activation missing');}});
 for(const run of [()=>inputs.send('a','text','m','attempt'),()=>inputs.permission('a','intent')])await assert.rejects(run(),e=>isNativeAdmissionRefusal(e));
 assert.equal(minted,0);assert.equal(sent,0);
});
test('post-mint activation failure and a provider-spoofed local diagnostic remain uncertain',async()=>{
 let checks=0,minted=0,sent=0;
 const inputs=boundNativeInputs({daemon:{invokeRawInput:()=>sent++},issueProvenance:async()=>{minted++;return'token';},verifyActivation:()=>{if(++checks===2)throw Error('activation missing');}});
 await assert.rejects(inputs.send('a','text','m','attempt'),error=>!isNativeAdmissionRefusal(error));assert.equal(minted,1);assert.equal(sent,0);
 assert.equal(isNativeAdmissionRefusal(Error('Trusted host activation unavailable before capability issuance')),false);
});
