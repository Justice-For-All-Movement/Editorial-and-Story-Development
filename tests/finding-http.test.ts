import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFindingPort } from '../src/engine/ports.ts';
import { ctx } from './fixtures.ts';
const ref='E08:finding:fiction@1';
const token=(over={})=>`header.${Buffer.from(JSON.stringify({tid:'t1',pid:'p1',purpose:'editorial',kind:'service',cmp:[],...over})).toString('base64url')}.signature`;
const record=()=>({ref,kind:'finding',id:'fiction',revision:1,state:'approved',stale:false,blocked:false,data:{label:'verified_fact',classification:'established'}});
test('actual E08 route, exact edition and detached literal metadata without invented compartment or truth mapping',async()=>{
 let calls=0;const source=record();
 const port=httpFindingPort({baseUrl:'https://example.invalid',token:token(),fetch:async(url,init)=>{calls++;assert.equal(String(url),'https://example.invalid/v1/records/finding/fiction');assert.equal(init?.method,'GET');return Response.json(source);}});
 const got=await port.getFindingStatus(ctx(),ref);
 assert.deepEqual(got,{ref,state:'approved',label:'verified_fact',classification:'established',stale:false,blocked:false});
 source.data.classification='refuted';assert.equal(got?.classification,'established');assert.equal((await port.getFindingStatus(ctx(),ref))?.classification,'refuted');assert.equal(calls,2);
});
test('malformed or nonpositive finding refs deny before credentials and transport',async()=>{
 let credentials=0,calls=0;const port=httpFindingPort({baseUrl:'https://example.invalid',token:()=>{credentials++;return token();},fetch:async()=>{calls++;return Response.json(record());}});
 for(const ref of ['E08:finding:fiction','E08:finding:fiction@0','E08:finding:fiction@01','E08:finding:fiction@9007199254740992','E07:claim:fiction@1'])await assert.rejects(port.getFindingStatus(ctx(),ref));
 assert.equal(credentials,0);assert.equal(calls,0);
});
test('foreign scope and broader compartment credentials never reach transport',async()=>{
 let calls=0;for(const over of [{tid:'foreign'},{pid:'foreign'},{purpose:'foreign'},{kind:'human'},{cmp:['secret']}])await assert.rejects(httpFindingPort({baseUrl:'https://example.invalid',token:token(over),fetch:async()=>{calls++;return Response.json(record());}}).getFindingStatus(ctx(),ref));assert.equal(calls,0);
});
test('new current edition is never silently substituted, and malformed metadata fails whole',async()=>{
 for(const change of [{ref:'E08:finding:fiction@2',revision:2},{kind:'question'},{id:'other'},{stale:undefined},{blocked:'false'},{state:'active'},{data:{label:'verified_fact',classification:'supported'}},{data:{label:'invented',classification:'established'}}])await assert.rejects(httpFindingPort({baseUrl:'https://example.invalid',token:token(),fetch:async()=>Response.json({...record(),...change})}).getFindingStatus(ctx(),ref));
 assert.equal(await httpFindingPort({baseUrl:'https://example.invalid',token:token(),fetch:async()=>new Response(null,{status:404})}).getFindingStatus(ctx(),ref),null);
});
test('withdrawn, stale and blocked records remain literal; failures cannot become approval',async()=>{
 for(const change of [{state:'withdrawn'},{stale:true},{blocked:true}]){const got=await httpFindingPort({baseUrl:'https://example.invalid',token:token(),fetch:async()=>Response.json({...record(),...change})}).getFindingStatus(ctx(),ref);for(const [key,value] of Object.entries(change))assert.equal((got as any)[key],value);}
 for(const status of [401,403,500])await assert.rejects(httpFindingPort({baseUrl:'https://example.invalid',token:token(),fetch:async()=>Response.json(record(),{status})}).getFindingStatus(ctx(),ref));
});
