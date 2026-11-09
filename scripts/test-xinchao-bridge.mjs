// Fixed bridge transport only, real loopback HTTP. No UI/model/device/account.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const require=createRequire(import.meta.url),env={FLOAT_XINCHAO_PROACTIVE_ENABLED:'true',FLOAT_XINCHAO_BRIDGE_MACHINE_TOKEN:'SYNTHETIC_BRIDGE_MACHINE_TOKEN_'.repeat(2),DYNAMIC_MIND_TOKEN:'SYNTHETIC_STATE_TOKEN_'.repeat(2),FLOAT_XINCHAO_ALLOW_HTTP:'true',FLOAT_XINCHAO_REST_CONTRACT:'4.3.0-2abe7fa9'};
function load(file,mocks={}){const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,require:name=>mocks[name]??require(name),process:{env},URL,Request,Response,AbortSignal,TextEncoder,TextDecoder,fetch,console});return module.exports;}
const common=load('../lib/server/shared-memory.ts'),heart=load('../lib/server/xinchao.ts',{'./shared-memory':common}),transport=load('../lib/server/xinchao-bridge.ts',{'./shared-memory':common,'./xinchao':heart});
let scenario='normal',calls=[],acks=0;
const id='delivery-synthetic-123',connected='event: connected\ndata: {"protocol":"xinchao-bridge-stream/1"}\n\n',delivery='event: delivery\ndata: '+JSON.stringify({protocol:'xinchao-bridge-stream/1',deliveryId:id})+'\n\n';
const fixture=createServer(async(request,response)=>{
 const chunks=[];for await(const chunk of request)chunks.push(chunk);const raw=Buffer.concat(chunks).toString();calls.push({url:request.url,method:request.method,raw});
 assert.equal(request.headers.authorization,'Bearer '+(request.url==='/health'?env.DYNAMIC_MIND_TOKEN:env.FLOAT_XINCHAO_BRIDGE_MACHINE_TOKEN));
 if(request.url==='/health'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({ok:true,system:'xinchao-dynamic-mind',version:scenario==='version'?'4.4.0':'4.3.0'}));return;}
 if(scenario==='redirect'){response.writeHead(302,{Location:'https://never-connect.invalid'});response.end();return;}
 response.setHeader('Content-Type','application/json');
 if(request.url==='/bridge/v1/health'){response.end(JSON.stringify({protocol:scenario==='bridge-version'?'other/2':'xinchao-bridge-server/1',status:'ok'}));return;}
 if(request.url==='/bridge/v1/events'){
  response.setHeader('Content-Type','text/event-stream');if(scenario==='bad-utf8'){response.end(Buffer.from([0xff]));return;}
  if(scenario==='missing-connected'){response.end(delivery);return;}
  if(scenario==='unknown-event'){response.end(connected+'event: sampling\ndata: {"protocol":"xinchao-bridge-stream/1","deliveryId":"'+id+'"}\n\n');return;}
  if(scenario==='incomplete'){response.end(connected+delivery.slice(0,-2));return;}
  if(scenario==='too-many'){response.end(connected+delivery.repeat(33));return;}
  if(scenario==='oversize'){response.end(connected+':'+ 'x'.repeat(70000));return;}
  if(scenario==='hold'){response.write(connected+delivery);return;}
  if(scenario==='crlf'){const bytes=Buffer.from((connected+': heartbeat\n\n'+delivery).replaceAll('\n','\r\n'));for(let start=0;start<bytes.length;start+=3)response.write(bytes.subarray(start,start+3));response.end();return;}
  response.end(connected+': heartbeat\n\n'+delivery+delivery);return;
 }
 if(request.url==='/bridge/v1/deliveries/'+id){let body={protocol:'xinchao-runtime-wake/1',deliveryId:id,reason:'self_signal',message:'SYNTHETIC_WAKE_HINT_NOT_AN_ASSISTANT_REPLY'};if(scenario==='secret')body.message=env.FLOAT_XINCHAO_BRIDGE_MACHINE_TOKEN;if(scenario==='state-secret')body.message=env.DYNAMIC_MIND_TOKEN;if(scenario==='bad-reason')body.reason=['self_signal'];if(scenario==='long-message')body.message='x'.repeat(4097);if(scenario==='id-mismatch')body.deliveryId='delivery-other-123';if(scenario==='media')body.image='https://never-connect.invalid/image';response.end(JSON.stringify(body));return;}
 if(request.url==='/bridge/v1/deliveries/'+id+'/ack'){assert.equal(request.method,'POST');assert.deepEqual(JSON.parse(raw),{status:'delivered'});acks++;response.end(JSON.stringify({ok:true,deliveryId:id,status:'delivered'}));return;}
 assert.fail('Unexpected bridge path '+request.url);
});await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));env.FLOAT_XINCHAO_URL='http://127.0.0.1:'+fixture.address().port;
try{
 assert.equal(transport.readXinchaoBridgeConfig({}),null);assert.equal(calls.length,0);assert.throws(()=>transport.readXinchaoBridgeConfig({...env,FLOAT_XINCHAO_BRIDGE_MACHINE_TOKEN:env.DYNAMIC_MIND_TOKEN}));
 const bridge=transport.createXinchaoBridge(transport.readXinchaoBridgeConfig());await bridge.check();assert.deepEqual(calls.map(call=>call.url),['/health','/bridge/v1/health']);
 const seen=[];await bridge.subscribe(async value=>{seen.push(value);});assert.deepEqual(seen,[id,id]);assert.equal(acks,0);assert.ok(!calls.some(call=>/deliveries\//.test(call.url)),'SSE does not pull body, ack, call a model or notify');
 scenario='crlf';const crlf=[];await bridge.subscribe(async value=>{crlf.push(value);});assert.deepEqual(crlf,[id]);assert.equal(acks,0);scenario='normal';const wake=await bridge.pull(id);assert.equal(wake.message,'SYNTHETIC_WAKE_HINT_NOT_AN_ASSISTANT_REPLY');assert.equal(wake.reason,'self_signal');assert.equal(acks,0);
 const before=calls.length;for(const invalid of ['../../outside','delivery/%2f','https://evil.invalid','delivery?x=y','/absolute']){await assert.rejects(bridge.pull(invalid));await assert.rejects(bridge.acknowledge(invalid));}assert.equal(calls.length,before);
 for(const invalid of ['secret','state-secret','bad-reason','long-message','id-mismatch','media']){scenario=invalid;await assert.rejects(bridge.pull(id),error=>!error.message.includes(env.DYNAMIC_MIND_TOKEN)&&!error.message.includes(env.FLOAT_XINCHAO_BRIDGE_MACHINE_TOKEN));assert.equal(acks,0);}
 for(const invalid of ['version','bridge-version','redirect','bad-utf8','missing-connected','unknown-event','incomplete','too-many','oversize']){scenario=invalid;await assert.rejects(bridge.subscribe(async()=>{}));assert.equal(acks,0);}
 scenario='hold';const controller=new AbortController(),cancelled=[];await assert.rejects(bridge.subscribe(async value=>{cancelled.push(value);controller.abort();},controller.signal));assert.deepEqual(cancelled,[id]);assert.equal(acks,0);
 scenario='normal';await bridge.acknowledge(id);assert.equal(acks,1);assert.equal(calls.filter(call=>call.method==='POST').length,1);
 console.log('Xinchao bridge transport: actual synthetic HTTP, distinct tokens/fixed paths, health+protocol gates, bounded JSON/SSE/UTF8/CRLF/events/EOF/cancel, payload/ID/secret refusal, metadata-only subscriptions, explicit ack only and no automatic reconnect/pull/model/notification passed. Not an integrated proactive/offline feature.');
}finally{const closed=new Promise(resolve=>fixture.close(resolve));fixture.closeAllConnections();await closed;}
