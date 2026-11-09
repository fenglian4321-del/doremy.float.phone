// Actual Next owner routes + Python SQLite/review + managed MCP transport.
// Models, native children and one Float tool are synthetic, never real accounts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';
import { createManagedMcpFixture } from './managed-mcp-fixture.mjs';
export { repo } from './managed-mcp-fixture.mjs';
export async function createWorkbenchFixture() {
    const f = await createManagedMcpFixture(), { load, db } = f, modelWire = [], backendWire = [], nativeWire = [], approvals = [], floatWrites = [];
    const env = Object.fromEntries(['PATH','Path','SystemRoot','TEMP','TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const child = spawn(process.env.FLOAT_TEST_PYTHON || 'python', [fileURLToPath(new URL('../tools/float-memory-review/workbench_test_host.py', import.meta.url))], { windowsHide:true, env:{...env,PYTHONUTF8:'1',...(process.env.FLOAT_TEST_WORK_DIR?{FLOAT_TEST_WORK_DIR:process.env.FLOAT_TEST_WORK_DIR}:{})},stdio:['ignore','pipe','pipe'] });
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
    const port = await new Promise((resolve,reject) => { let raw='';const timer=setTimeout(()=>reject(Error(stderr||'Fixture startup')),10000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});child.stdout.on('data',bytes=>{raw+=bytes;if(raw.includes('\n')){clearTimeout(timer);resolve(JSON.parse(raw.trim()).port);}}); });
    let failStorage = false, floatMode = '', catalogChanged = false, composed = true, modelHandler = () => ({ content:'Synthetic final response.' });
    db.kvSetAsync = async (key,value) => { if(failStorage)throw Error('SYNTHETIC_IDB_FAILURE'); db.kvSet(key,value); };
    const config = { baseUrl:'http://127.0.0.1:'+port,password:'synthetic-dashboard',accessToken:f.ownerToken,reviewToken:'synthetic-work-service-token-only' };
    const review = load('lib/server/shared-memory-review.ts',{'./shared-memory':f.owner},true), owner={...f.owner,readSharedMemoryConfig:()=>config};
    const routes = Object.fromEntries(['workspaces','private-space'].map(name=>[name,load('app/api/shared-memory/'+name+'/route.ts',{'next/server':{NextResponse:{json:(body,init)=>Response.json(body,init)}},'@/lib/server/shared-memory':owner,'@/lib/server/shared-memory-review':review})]));
    const memoryRoute=load('app/api/shared-memory/route.ts',{'next/server':{NextResponse:{json:(body,init)=>Response.json(body,init)}},'@/lib/server/shared-memory':owner,'@/lib/server/shared-memory-review':review});
    f.setScopeBackend(review.createOmbreReviewClient(config));
    const tokens=load('lib/token-usage.ts'),ledger=load('lib/usage-ledger.ts',{'./kv-db':db}),usage=load('lib/usage-fetch.ts',{'./usage-ledger':ledger,'./token-usage':tokens});
    const helpers=load('lib/api-helpers.ts',{'./usage-fetch':usage,'./token-usage':tokens},true);
    const adapter=load('lib/llm-provider-adapter.ts',{'./api-helpers':helpers,'./generation-parameters':{resolveEnabledGenerationParameters:()=>new Set()},'./token-usage':tokens});
    const http=load('lib/llm-http.ts',{'./usage-fetch':usage}),budget=load('lib/consolidation-budget.ts',{'./token-counter':load('lib/token-counter.ts')});
    const managed=load('lib/managed-mcp-session.ts',{'./kv-db':db,'./managed-mcp-client':f.client,'./managed-mcp-policy':f.policy});
    const phones=new Map(),devices=new Map(),key=scope=>scope.mode+':'+scope.workspaceId;
    const phoneModule={getPhoneToolSession:scope=>phones.get(key(scope))||null,phoneToolRunPending:()=>false,clearPhoneToolRun(){},disablePhoneTools:scope=>{phones.get(key(scope))?.stop();phones.delete(key(scope));}};
    const deviceModule={getPhoneDeviceSession:scope=>devices.get(key(scope))||null,phoneDeviceRunPending:()=>false,clearPhoneDeviceRun(){},disablePhoneDeviceTools:scope=>{devices.get(key(scope))?.stop();devices.delete(key(scope));}};
    const client=load('lib/workspace-client.ts',{'./kv-db':db,'./llm-provider-adapter':adapter,'./llm-http':http,'./consolidation-budget':budget,'./managed-mcp-session':managed,'./phone-file-tools':phoneModule,'./phone-device-tools':deviceModule});
    const catalog=[{name:'本地资料库',description:'读取合成Float资料',source:'internal',sourceId:'synthetic-local-data',parameterSchema:'{}'},{name:'写入合成便签',description:'写入合成的Float便签',source:'rest',sourceId:'synthetic-write',parameterSchema:'{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}'}];
    const readonly={name:'读取资料记录',description:'读合成记录',source:'internal',sourceId:'synthetic-local-data',parameterSchema:'{"type":"object","properties":{}}'};
    const storage={getEnabledTools:()=>catalogChanged?[]:catalog,findEnabledToolForSchema:name=>name==='读取资料记录'?readonly:catalog.find(row=>row.name===name)};
    const execute={executeToolCalls:async(calls,context)=>{
        context.signal.throwIfAborted();assert.equal(context.appId,'workspace');assert.equal(context.sourceEngine,'workspace');assert.equal(context.workspace.approved,true);
        for(const call of calls)if(call.name==='写入合成便签'){assert.ok(approvals.length);floatWrites.push(call.args);if(floatMode==='lost')throw Error('SYNTHETIC_PRIVATE_UPSTREAM_ERROR');}
        return calls.map(call=>({name:call.name,success:true,data:JSON.stringify({body:'SYNTHETIC_FLOAT_PRIVATE_DATA',apiKey:'sk-SYNTHETIC_SECRET_1234567890',echo:call.args})}));
    }};
    const shizukuState={ready:false,status:'authorized',identity:'shell',uid:2000,epoch:1},shizukuGrants=new Map(),shizukuResults=new Map(),shizukuWire=[],shizukuEffects=[];
    let shizukuMode='';
    const shizukuWindow={location:{origin:'https://float.fixture'},AndroidShell:{
        getShizukuStatus:()=>JSON.stringify({protocol:'float-shizuku/v1',state:'complete',...shizukuState}),
        shizukuControl:encoded=>{
            const b=JSON.parse(encoded),scopeId=key(b.scope||{mode:'work',workspaceId:'control'}),reply=extra=>JSON.stringify({protocol:'float-shizuku/v1',state:'complete',...extra});
            const g=shizukuGrants.get(b.grantId);
            if(['grant_status','activate','action'].includes(b.operation)&&(!shizukuState.ready||!g||g.scopeId!==scopeId||g.epoch!==shizukuState.epoch))return reply({state:'failed',code:'grant_expired'});
            if(b.operation==='grant_status')return reply({grant:g});
            if(b.operation==='activate'){if(g.taskDigest!==b.taskDigest)throw Error('task mismatch');g.run={runId:b.runId,claim:b.claim};return reply({grant:g});}
            if(b.operation==='revoke'){shizukuGrants.delete(b.grantId);return reply({});}
            if(b.operation==='cancel'){const r=shizukuResults.get(b.requestId);if(r)r.cancelled=true;return reply({state:'failed',code:'cancelled'});}
            if(['result','receipt'].includes(b.operation)){const r=shizukuResults.get(b.requestId);if(!r||r.scopeId!==scopeId)return reply({state:'failed',code:'invalid_scope'});return reply(r.reply);}
            if(b.operation==='action'){
                assert.ok(g.run);assert.ok(g.allowLaunch||b.action!=='launch_app');shizukuWire.push(b);
                const record={scopeId,cancelled:false,reply:{state:'pending',requestId:b.requestId}};shizukuResults.set(b.requestId,record);
                void ownerRequest('/api/shared-memory/'+(b.scope.mode==='work'?'workspaces':'private-space'),{method:'POST',headers:{'Content-Type':'application/json','x-float-space-external-tools':'v1'},body:JSON.stringify({operation:'phone_lease',workspaceId:b.scope.workspaceId,...g.run})}).then(async response=>{
                    assert.equal(response.status,200);const lease=await response.json();assert.equal(lease.externalMode,'assistant');assert.equal(lease.taskDigest,g.taskDigest);
                    if(shizukuMode==='death'){shizukuState.ready=false;shizukuState.status='disconnected';shizukuState.epoch++;}
                    if(!record.cancelled&&shizukuState.ready){shizukuEffects.push(b);record.reply={state:'complete',requestId:b.requestId,receipt:{requestId:b.requestId,operation:b.action,state:'complete'},data:{location:'android_shizuku',operation:b.action,uid:shizukuState.uid,identity:shizukuState.identity,untrustedData:true,synthetic:'PUBLIC_APP_METADATA'}};}
                    else record.reply={state:'failed',code:'action_uncertain',requestId:b.requestId};
                }).catch(()=>{record.reply={state:'failed',code:'task_inactive',requestId:b.requestId};});
                return reply({state:'pending',requestId:b.requestId});
            }
            throw Error('Unexpected Shizuku operation '+b.operation);
        }
    }};
    const shizukuModule=load('lib/shizuku-tools.ts',{'./kv-db':db},false,{window:shizukuWindow});
    const memoryTools=load('lib/workspace-memory-tools.ts');
    const assistant=load('lib/workspace-assistant-session.ts',{'./kv-db':db,'./tool-storage':storage,'./tool-prompt':{formatToolSchema:tool=>tool.usageGuide||tool.parameterSchema},'./phone-file-tools':phoneModule,'./phone-device-tools':deviceModule,'./shizuku-tools':shizukuModule,'./scoped-device-ui':{deviceUiAvailability:()=>({available:true,composedTasks:composed})},'./managed-mcp-session':managed,'./workspace-client':client,'./chat-storage':{loadChatSessions:()=>[],resolveSessionCharacterId:()=>''},'./character-storage':{loadCharacters:()=>[]},'./workspace-memory-tools':memoryTools,'./tool-executor':execute});
    const rawMcp=f.internalNetwork;
    const ownerRequest=async(path,init={})=>{
        const request=new Request('https://float.fixture'+path,{...init,headers:{...init.headers,Origin:'https://float.fixture','x-float-memory-access-token':config.accessToken}});
        if(path.split('?')[0]==='/api/shared-memory')return (init.method==='POST'?memoryRoute.POST:memoryRoute.GET)(request);
        return routes[path.includes('/private-space')?'private-space':'workspaces'].POST(request);
    };
    const resultsFrom=(body,protocol)=>{
        const rows=protocol==='anthropic'?body.messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(part=>part.type==='tool_result').map(part=>part.content):protocol==='gemini'?body.contents.flatMap(message=>message.parts).filter(part=>part.functionResponse).map(part=>part.functionResponse.response.result):body.messages.filter(message=>message.role==='tool').map(message=>message.content);
        return rows.map(row=>typeof row==='string'?JSON.parse(row):row);
    };
    f.setNetwork(async(url,init={})=>{
        if(url==='/api/shared-memory/mcp')return rawMcp(url,init);
        if(url.startsWith('/api/shared-memory')){if(init.body)backendWire.push(JSON.parse(init.body));return ownerRequest(url,init);}
        if(url.startsWith(config.baseUrl))return fetch(url,init);
        const host=new URL(url).hostname;assert.ok(['selected-workbench.fixture','api.anthropic.com','generativelanguage.googleapis.com'].includes(host));
        const protocol=host==='api.anthropic.com'?'anthropic':host==='generativelanguage.googleapis.com'?'gemini':'openai',body=JSON.parse(init.body),results=resultsFrom(body,protocol);
        modelWire.push({protocol,body,results}); const result=await modelHandler({protocol,body,results,signal:init.signal}); const calls=result.calls||[],content=result.content||'';
        if(protocol==='anthropic')return Response.json({content:content?[{type:'text',text:content}]:calls.map(call=>({type:'tool_use',id:call.id,name:call.name,input:call.args})),usage:{input_tokens:10,output_tokens:5}});
        if(protocol==='gemini')return Response.json({candidates:[{content:{parts:content?[{text:content}]:calls.map(call=>({functionCall:{id:call.id,name:call.name,args:call.args},thoughtSignature:'synthetic-signature'}))}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:5}});
        return Response.json({choices:[{message:{content,...(calls.length?{tool_calls:calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))}:{})}}],usage:{prompt_tokens:10,completion_tokens:5}});
    });
    const model={id:'synthetic-api',name:'合成API',provider:'Custom',baseUrl:'https://selected-workbench.fixture/v1',apiKey:'SYNTHETIC_MODEL_KEY',defaultModel:'synthetic-model',enableNativeTools:true,contextWindowTokens:64000};
    const makeNative=(scope,kind)=>{
        const controller=new AbortController();let run,task;
        const tool={name:kind==='device'?'phone_observe_ui':'phone_list_files',description:'Synthetic native '+kind,parameters:{type:'object',properties:{},required:[],additionalProperties:false}};
        return {scope,signal:controller.signal,stop(){controller.abort();},check(signal){signal?.throwIfAborted();controller.signal.throwIfAborted();},tools:()=>[tool],bindTask:async content=>{task=content;},bindRun:value=>{run=value;},begin(){},async execute(call,signal,trace){controller.signal.throwIfAborted();if(kind==='device'){const leaseResponse=await ownerRequest('/api/shared-memory/'+(scope.mode==='work'?'workspaces':'private-space'),{method:'POST',headers:{'Content-Type':'application/json','x-float-space-external-tools':'v1'},body:JSON.stringify({operation:'phone_lease',workspaceId:scope.workspaceId,...run}),signal});assert.equal(leaseResponse.status,200);const lease=await leaseResponse.json();assert.equal(lease.externalMode,'assistant');assert.equal(lease.taskDigest,createHash('sha256').update(task).digest('hex'));}nativeWire.push({kind,scope,call});trace?.(kind==='device'?{deviceUi:true,id:call.id,operation:'observe',location:'android_device',ok:true}:{id:call.id,operation:'list',location:'android_device',ok:true});return {role:'tool',name:call.name,toolCallId:call.id,content:JSON.stringify({ok:true,untrustedData:true,location:'android_device',body:'SYNTHETIC_NATIVE_DATA'})};}};
    };
    return {f,load,db,config,client,managed,assistant,memoryTools,model,modelWire,backendWire,nativeWire,floatWrites,approvals,ownerRequest,storage,
        setModel(fn){modelHandler=fn;},setFloatMode(value){floatMode=value;},setStorageFailure(value){failStorage=value;},setCatalogChanged(value){catalogChanged=value;},setComposed(value){composed=value;},
        shizuku:shizukuModule,shizukuState,shizukuWindow,shizukuWire,shizukuEffects,
        setShizukuMode(value){shizukuMode=value;},
        enableShizuku(room,allowLaunch=true){shizukuState.ready=true;shizukuState.status='ready';const g={id:webcrypto.randomUUID(),label:'Synthetic selected app',allowLaunch,taskDigest:createHash('sha256').update('合成组合任务').digest('hex'),expires:Date.now()+600000,epoch:shizukuState.epoch,scopeId:key(room.scope)};shizukuGrants.set(g.id,g);shizukuModule.enableShizukuTools(room.scope,g);return g;},
        async create(kind='work'){const response=await client.spaceCall(kind,'create',{title:'新对话',clientKey:webcrypto.randomUUID()});return {workspace:response.workspace,scope:{mode:kind,workspaceId:response.workspace.id}};},
        async enableNative(room){phones.set(key(room.scope),makeNative(room.scope,'file'));devices.set(key(room.scope),makeNative(room.scope,'device'));const control=await f.client.managedMcpControl(room.scope,'catalog');await f.client.managedMcpControl(room.scope,'bind',{version:control.binding.version,enabled:true,services:[{id:'fixture',revision:control.services[0].revision,tools:['lookup']}]});await managed.enableManagedMcpSession(room.scope,'fixture');},
        nativeStop(scope){devices.get(key(scope))?.stop();},
        register(room,names=[],decision=true){const value=new assistant.WorkspaceAssistantSession(room.scope,names,undefined,request=>{if(request){approvals.push(request);if(decision!==null)request.decide(decision);}});client.registerWorkspaceAssistant(value);return value;},
        run(room,selected=model,trace){return client.runWorkspaceChat(room.workspace,selected,'合成组合任务',new AbortController().signal,undefined,room.scope.mode,[],trace,trace,trace,trace);},
        async close(){child.kill();await f.close();},
    };
}
