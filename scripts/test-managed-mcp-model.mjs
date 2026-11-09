// Actual workspace/owner/backend/managed-MCP loop; synthetic models + loopback MCP.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createManagedMcpFixture } from './managed-mcp-fixture.mjs';
const fixture = await createManagedMcpFixture(), { load, db } = fixture;
const env = Object.fromEntries(['PATH','Path','SystemRoot','TEMP','TMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
const child = spawn(process.env.FLOAT_TEST_PYTHON || 'python',[fileURLToPath(new URL('../tools/float-memory-review/workspace_test_host.py',import.meta.url))],{windowsHide:true,env:{...env,PYTHONUTF8:'1',...(process.env.FLOAT_TEST_WORK_DIR?{FLOAT_TEST_WORK_DIR:process.env.FLOAT_TEST_WORK_DIR}:{})},stdio:['ignore','pipe','pipe']});
let stderr=''; child.stderr.on('data',data=>{stderr+=data;});
let modelRequests=0, mode='normal', revokeDuringModel, failFinish=false, failBegin=false, holdCatalog=false, releaseCatalog, rewriteExecution;
const traces=[], backendRequests=[], modelWire=[];
try {
    const port=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Synthetic backend startup: '+stderr)),10000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);reject(Error('Synthetic backend exit '+code));});child.stdout.on('data',data=>{text+=data;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.trim()).port);}});});
    const owner=fixture.owner, config={baseUrl:'http://127.0.0.1:'+port,password:'synthetic-dashboard',accessToken:fixture.ownerToken,reviewToken:'synthetic-work-service-token-only'};
    const review=load('lib/server/shared-memory-review.ts',{'./shared-memory':owner},true);
    const routes=Object.fromEntries(['workspaces','private-space'].map(name=>[name,load('app/api/shared-memory/'+name+'/route.ts',{'next/server':{NextResponse:{json:(body,init)=>Response.json(body,init)}},'@/lib/server/shared-memory':{...owner,readSharedMemoryConfig:()=>config},'@/lib/server/shared-memory-review':review})]));
    fixture.setScopeBackend(review.createOmbreReviewClient(config));
    const tokens=load('lib/token-usage.ts'),ledger=load('lib/usage-ledger.ts',{'./kv-db':db}),usage=load('lib/usage-fetch.ts',{'./usage-ledger':ledger,'./token-usage':tokens});
    const helpers=load('lib/api-helpers.ts',{'./usage-fetch':usage,'./token-usage':tokens},true);
    const adapter=load('lib/llm-provider-adapter.ts',{'./api-helpers':helpers,'./generation-parameters':{resolveEnabledGenerationParameters:()=>new Set()},'./token-usage':tokens});
    const http=load('lib/llm-http.ts',{'./usage-fetch':usage});
    const budget=load('lib/consolidation-budget.ts',{'./token-counter':load('lib/token-counter.ts')});
    const managed=load('lib/managed-mcp-session.ts',{'./kv-db':db,'./managed-mcp-client':fixture.client,'./managed-mcp-policy':fixture.policy});
    let phoneActive=false;
    const workspace=load('lib/workspace-client.ts',{'./kv-db':db,'./llm-provider-adapter':adapter,'./llm-http':http,'./consolidation-budget':budget,'./phone-device-tools':{getPhoneDeviceSession:()=>null,phoneDeviceRunPending:()=>false,clearPhoneDeviceRun:()=>{},disablePhoneDeviceTools:()=>{}},'./managed-mcp-session':managed,'./phone-file-tools':{getPhoneToolSession:()=>phoneActive?{}:null,phoneToolRunPending:()=>false,clearPhoneToolRun(){},disablePhoneTools(){}}});
    const rawControl=fixture.internalNetwork;
    fixture.setNetwork(async(url,init)=>{
        if(url==='/api/shared-memory/mcp') { if(holdCatalog&&JSON.parse(init.body).operation==='catalog'){holdCatalog=false;const result=await rawControl(url,init);await new Promise(resolve=>{releaseCatalog=resolve;});return result;}return rawControl(url,init); }
        if(url==='/api/shared-memory/workspaces'||url==='/api/shared-memory/private-space'){
            const body=JSON.parse(init.body);backendRequests.push(body);
            let response=await routes[url.endsWith('/private-space')?'private-space':'workspaces'].POST(new Request('https://float.fixture'+url,{...init,headers:{...init.headers,Origin:'https://float.fixture','x-float-memory-access-token':config.accessToken}}));
            if(rewriteExecution?.operation===body.operation){const rewritten=await response.json();if(rewriteExecution.mode==='missing')delete rewritten.run.executionVersion;else rewritten.run.externalMode=rewriteExecution.mode;rewriteExecution=undefined;response=Response.json(rewritten,{status:response.status});}
            if(failFinish&&body.operation==='finish'){failFinish=false;throw new TypeError('Synthetic lost finish acknowledgement');}
            if(failBegin&&body.operation==='begin'){failBegin=false;throw new TypeError('Synthetic lost begin acknowledgement');}return response;
        }
        if(url===config.baseUrl+'/float-memory/v2/workspaces'||url===config.baseUrl+'/float-memory/v2/private_spaces')return fetch(url,init);
        const hostname=new URL(url).hostname;
        assert.ok(['selected-mcp-model.fixture','api.anthropic.com','generativelanguage.googleapis.com'].includes(hostname),'No executor/model fallback');
        modelRequests++;
        const protocol=hostname==='api.anthropic.com'?'anthropic':hostname==='generativelanguage.googleapis.com'?'gemini':'openai', body=JSON.parse(init.body);modelWire.push(body);
        assert.ok(!init.body.includes('SYNTHETIC_MCP_SERVER_TOKEN'));assert.ok(!init.body.includes('REMOTE_SYSTEM_INSTRUCTION_ATTACK'));assert.ok(!init.body.includes('PRIVATE_LIFE_SENTINEL'));
        const declarations=protocol==='anthropic'?body.tools:protocol==='gemini'?body.tools?.flatMap(tool=>tool.functionDeclarations||[]):body.tools?.map(tool=>tool.function);
        const resultParts=protocol==='anthropic'?body.messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(part=>part.type==='tool_result').map(part=>({id:part.tool_use_id,raw:part.content})):protocol==='gemini'?body.contents.flatMap(message=>message.parts).filter(part=>part.functionResponse).map(part=>({id:part.functionResponse.id,raw:part.functionResponse.response.result})):body.messages.filter(message=>message.role==='tool').map(message=>({id:message.tool_call_id,raw:message.content}));
        if(mode==='plain')assert.ok(!declarations?.some(tool=>tool.name.startsWith('mcp_')));
        else if(resultParts.length<8){assert.ok(declarations?.length===1&&declarations[0].name.startsWith('mcp_'));const schema=declarations[0].parameters||declarations[0].input_schema;assert.deepEqual(Object.keys(schema.properties),['query']);}
        if(mode!=='plain')assert.ok(!init.body.includes('只使用private_list_files/private_read_file/private_write_file'),'External mode has a matching server prompt, not contradictory VPS-only rules');
        for(const part of resultParts){const value=JSON.parse(part.raw);assert.equal(value.untrustedData,true);assert.equal(value.location,'configured_external_service');assert.equal(value.type,'external_mcp_data');assert.ok(value.requestId);assert.match(value.text,/SYNTHETIC_MCP_RESULT/);if(mode!=='limit')assert.equal(part.id,'mcp-call-a');}
        if(protocol==='gemini'&&resultParts.length){const parts=body.contents.flatMap(message=>message.parts);assert.equal(parts.find(part=>part.functionCall).functionCall.id,'mcp-call-a');assert.equal(parts.find(part=>part.functionCall).thoughtSignature,'mcp-synthetic-signature');}
        if(revokeDuringModel){const fn=revokeDuringModel;revokeDuringModel=undefined;await fn();}
        const final=mode==='plain'||(mode==='limit'?resultParts.length>=8:resultParts.length>0),name=mode==='forbidden'?'workspace_list_files':declarations?.[0]?.name;
        const callId=mode==='limit'?'mcp-step-'+resultParts.length:'mcp-call-a',args={query:'SYNTHETIC_MCP_MODEL_ARG'};
        const calls=mode==='duplicate'?[{id:callId,name,args},{id:callId,name,args}]:[{id:callId,name,args}];
        const reply='本区合成查询已按回执完成。';
        if(protocol==='anthropic')return Response.json({content:final?[{type:'text',text:reply}]:calls.map(call=>({type:'tool_use',id:call.id,name:call.name,input:call.args})),usage:{input_tokens:12,output_tokens:6}});
        if(protocol==='gemini')return Response.json({candidates:[{content:{parts:final?[{text:reply}]:calls.map(call=>({functionCall:{id:call.id,name:call.name,args:call.args},thoughtSignature:'mcp-synthetic-signature'}))}}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:6,totalTokenCount:18}});
        return Response.json({choices:[{message:final?{content:reply}:{content:'',tool_calls:calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))}}],usage:{prompt_tokens:12,completion_tokens:6,total_tokens:18}});
    });
    const model={id:'mcp-model',provider:'Custom',baseUrl:'https://selected-mcp-model.fixture/v1',apiKey:'SYNTHETIC_MODEL_KEY',defaultModel:'synthetic-model',enableNativeTools:true,contextWindowTokens:64000};
    const create=async kind=>(await workspace.spaceCall(kind,'create',{title:'MCP fixture',clientKey:webcrypto.randomUUID()})).workspace;
    const authorize=async room=>{const scope={mode:room.mode,workspaceId:room.id},catalog=await fixture.client.managedMcpControl(scope,'catalog');await fixture.client.managedMcpControl(scope,'bind',{version:catalog.binding.version,enabled:true,services:[{id:'fixture',revision:catalog.services[0].revision,tools:['lookup']}]});await managed.enableManagedMcpSession(scope,'fixture');return scope;};
    const run=(room,chosen=model,content='Use synthetic scoped tool')=>workspace.runWorkspaceChat(room,chosen,content,new AbortController().signal,undefined,room.mode,[],undefined,item=>traces.push(item));
    mode='plain';let room=await create('work');const beforeDefault=fixture.wire.length;await run(room);assert.equal(fixture.wire.length,beforeDefault);
    for(const kind of ['work','private'])for(const provider of ['Custom','Anthropic','Google']){
        mode='normal';room=await create(kind);const scope=await authorize(room),before=modelRequests;
        const result=await run(room,{...model,provider,baseUrl:provider==='Custom'?model.baseUrl:undefined});
        assert.equal(result.run.state,'complete');assert.equal(modelRequests-before,2);assert.equal(result.workspace.files.length,0);assert.equal(managed.getManagedMcpSession(scope),null);assert.equal(managed.managedMcpRunPending(scope,result.run.id),false);
        const old=await routes[kind==='work'?'workspaces':'private-space'].POST(new Request('https://float.fixture/api/shared-memory/'+(kind==='work'?'workspaces':'private-space'),{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://float.fixture','x-float-memory-access-token':config.accessToken},body:JSON.stringify({operation:'detail',workspaceId:room.id,_externalClient:'v1'})}));assert.equal(old.status,409);assert.equal((await old.json()).code,'work_client_upgrade');
    }
    for(const kind of ['work','private'])for(const operation of ['begin','heartbeat'])for(const changed of ['missing','phone']){
        room=await create(kind);await authorize(room);const modelsBefore=modelRequests,callsBefore=fixture.counts.call,wireBefore=fixture.wire.length;
        rewriteExecution={operation,mode:changed};await assert.rejects(run(room),/固定执行位置/);assert.equal(modelRequests,modelsBefore);assert.equal(fixture.counts.call,callsBefore);assert.equal(fixture.wire.length,wireBefore);
    }
    for(const bad of ['forbidden','duplicate']){mode=bad;room=await create('work');await authorize(room);const before=fixture.counts.call;await assert.rejects(run(room));assert.equal(fixture.counts.call,before);}
    mode='normal';room=await create('work');const failedScope=await authorize(room);fixture.behavior.wrongId=true;let before=modelRequests;await assert.rejects(run(room));assert.equal(modelRequests,before+1);delete fixture.behavior.wrongId;
    const detail=await workspace.spaceCall('work','detail',{workspaceId:room.id});assert.equal(detail.run.state,'cancelled');assert.equal(managed.managedMcpRunPending(failedScope,detail.run.id),true);
    before=modelRequests;const wireBefore=fixture.wire.length;await assert.rejects(run(detail.workspace,model,null),/不能自动重放/);assert.equal(modelRequests,before);assert.equal(fixture.wire.length,wireBefore);fixture.client.clearManagedMcpWait(failedScope);
    const cacheSnapshot=new Map(fixture.kv);fixture.kv.clear();await assert.rejects(run(detail.workspace,model,null),/不能自动重放/);assert.equal(modelRequests,before);for(const [key,value]of cacheSnapshot)fixture.kv.set(key,value);
    room=await create('work');const beginScope=await authorize(room);failBegin=true;before=modelRequests;const beginWire=fixture.wire.length;await assert.rejects(run(room));assert.equal(modelRequests,before);await assert.rejects(run(room,model,null),/不能自动重放/);assert.equal(modelRequests,before);assert.equal(fixture.wire.length,beginWire);assert.equal((await workspace.spaceCall('work','detail',{workspaceId:room.id})).run.state,'cancelled');managed.disableManagedMcpSession(beginScope);
    room=await create('work');const preparingScope=await authorize(room);managed.disableManagedMcpSession(preparingScope);holdCatalog=true;releaseCatalog=undefined;
    const preparation=managed.enableManagedMcpSession(preparingScope,'fixture'),preparationStopped=assert.rejects(preparation);
    const preparationStarted=Date.now();while(!releaseCatalog){if(Date.now()-preparationStarted>5000)throw Error('Preparation fixture did not respond');await new Promise(resolve=>setTimeout(resolve,5));}assert.equal(managed.managedMcpSessionPreparing(preparingScope),true);before=modelRequests;await assert.rejects(run(room),/正在核对/);assert.equal(modelRequests,before);managed.disableManagedMcpSession(preparingScope);releaseCatalog();await preparationStopped;assert.equal(managed.getManagedMcpSession(preparingScope),null);
    room=await create('private');const revokedScope=await authorize(room);const revokedBefore=fixture.counts.call;
    revokeDuringModel=async()=>{const catalog=await fixture.client.managedMcpControl(revokedScope,'catalog');await fixture.client.managedMcpControl(revokedScope,'bind',{version:catalog.binding.version,enabled:false,services:[]});};
    await assert.rejects(run(room));assert.equal(fixture.counts.call,revokedBefore);
    room=await create('work');await authorize(room);const cancelledRoom=room,cancelBefore=fixture.counts.call;
    revokeDuringModel=async()=>{const receipt=workspace.workspaceReceipt(cancelledRoom.id,cancelledRoom.mode);await workspace.spaceCall(cancelledRoom.mode,'cancel',{workspaceId:cancelledRoom.id,runId:receipt.runId,claim:receipt.claim});};await assert.rejects(run(room));assert.equal(fixture.counts.call,cancelBefore);
    room=await create('private');await authorize(room);const listedRoom=room,listBefore=fixture.counts.call;
    fixture.behavior.afterList=async()=>{delete fixture.behavior.afterList;const receipt=workspace.workspaceReceipt(listedRoom.id,listedRoom.mode);await workspace.spaceCall(listedRoom.mode,'cancel',{workspaceId:listedRoom.id,runId:receipt.runId,claim:receipt.claim});};await assert.rejects(run(room));assert.equal(fixture.counts.call,listBefore);fixture.client.clearManagedMcpWait({mode:room.mode,workspaceId:room.id});
    room=await create('work');await authorize(room);phoneActive=true;before=modelRequests;await assert.rejects(run(room),/一个授权范围/);assert.equal(modelRequests,before);phoneActive=false;managed.disableManagedMcpSession({mode:'work',workspaceId:room.id});
    room=await create('work');await authorize(room);before=modelRequests;await assert.rejects(run(room,{...model,enableNativeTools:false}),/关闭了原生工具/);assert.equal(modelRequests,before);managed.disableManagedMcpSession({mode:'work',workspaceId:room.id});
    mode='limit';room=await create('work');await authorize(room);before=modelRequests;await run(room);assert.equal(modelRequests,before+9);
    mode='normal';room=await create('private');const finishScope=await authorize(room);failFinish=true;await assert.rejects(run(room));before=modelRequests;const callsBefore=fixture.counts.call;const completed=await run(room,model,null);assert.equal(completed.run.state,'complete');assert.equal(modelRequests,before);assert.equal(fixture.counts.call,callsBefore);assert.equal(managed.managedMcpRunPending(finishScope,completed.run.id),false);
    for(const value of [JSON.stringify([...fixture.kv]),JSON.stringify(backendRequests),JSON.stringify(traces),JSON.stringify(ledger.getUsageLedger())])for(const sentinel of ['SYNTHETIC_MCP_MODEL_ARG','SYNTHETIC_MCP_RESULT','SYNTHETIC_MCP_SERVER_TOKEN','REMOTE_SYSTEM_INSTRUCTION_ATTACK'])assert.ok(!value.includes(sentinel));
    assert.ok(!backendRequests.some(body=>body.operation==='turn'||body.operation==='tool'));assert.ok(ledger.getUsageLedger().some(row=>row.reason==='tool_continuation'));
    console.log('Managed MCP model loop: actual three provider adapters/owner proxies/SQLite/MCP gateway with synthetic MCP/models, work/private×3 full ID/signature roundtrips, direct selected model without Codex, default off, location exclusivity, scope/revoke/batch/limits, no replay/lost-finish retries, untrusted tool role and no body in persistent workspace/KV/usage/traces passed. No real services/providers/devices.');
} finally { child.kill();await fixture.close(); }
