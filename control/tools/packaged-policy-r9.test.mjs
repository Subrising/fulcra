import {test} from 'node:test'; import assert from 'node:assert/strict';
import {personalBlocker, safeFinding} from './packaged-review-policy.mjs';
import {forbidden} from './no-machine-ties.mjs';
test('all configured machine identifiers and case variants are non-reviewable even for vendors',()=>{
 const values=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','srv_fixtureA','srv_fixtureB','.ts.net','100.90.','owner@','-----begin private key-----','GHP_'+'a'.repeat(32)];
 for(const value of values) for(const pattern of [value,value.toUpperCase()]) for(const vendor of [true,false]) assert(personalBlocker({pattern,context:pattern},vendor),pattern);
});
test('generic reviewed names and numeric module IDs stay reviewable',()=>{
 for(const pattern of ['David','3200','https://qwen.readthedocs.io/en/latest/users/']) assert.equal(personalBlocker({pattern,context:pattern},false),null);
});

test('credential redaction wins even when a token also contains an identifier-shaped substring',()=>{
 const pattern='sk-'+'a'.repeat(32)+'-00000000-0000-4000-8000-000000000001';
 const hit={pattern,context:pattern};const blocker=personalBlocker(hit,false);
 assert.equal(blocker,'credential-shaped value');assert.equal(safeFinding(hit,blocker).pattern,'[credential-shaped value]');
});
