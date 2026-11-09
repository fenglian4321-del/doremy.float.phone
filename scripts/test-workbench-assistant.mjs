import assert from 'node:assert/strict';
import { createWorkbenchFixture } from './workbench-fixture.mjs';
const f=await createWorkbenchFixture(),trace=[];
const execute=(id,name,args)=>({id,name,args});
try {
    for(const kind of ['work','private'])for(const provider of ['Custom','Anthropic','Google']){
        const room=await f.create(kind);await f.enableNative(room);f.register(room,['本地资料库','写入合成便签']);
        const prefix=kind==='work'?'workspace_':'private_',before=f.modelWire.length,backend=f.backendWire.length;
        const actions=[execute('save',prefix+'write_file',{path:'notes/result.md',content:'SYNTHETIC_COMPOSED_FILE',baseVersion:0}),execute('phone','phone_list_files',{}),execute('screen','phone_observe_ui',{}),execute('mcp','mcp_0_lookup',{query:'synthetic'}),execute('schema','float_tool_instructions',{name:'写入合成便签'}),execute('float-write','float_execute_tool',{name:'写入合成便签',argumentsJson:'{"text":"SYNTHETIC_FLOAT_NOTE"}'}),execute('float-read','float_execute_tool',{name:'读取资料记录',argumentsJson:'{}'})];
        f.setModel(({results,body})=>{
            assert.ok(!JSON.stringify(body).includes('PRIVATE_LIFE_PERSONA'));
            assert.ok(!JSON.stringify(body).includes('sk-SYNTHETIC_SECRET'));
            return results.length<actions.length?{calls:[actions[results.length]]}:{content:'Synthetic combined task completed from receipts.'};
        });
        const result=await f.run(room,{...f.model,provider,baseUrl:provider==='Custom'?f.model.baseUrl:undefined},row=>trace.push(row));
        assert.equal(result.run.state,'complete');assert.equal(result.run.externalMode,'assistant');assert.equal(f.modelWire.length-before,8);
        const saved=await f.client.spaceCall(kind,'read_file',{workspaceId:room.workspace.id,path:'notes/result.md'});assert.equal(saved.result.content,'SYNTHETIC_COMPOSED_FILE');
        assert.ok(!JSON.stringify(f.backendWire.slice(backend)).includes('SYNTHETIC_NATIVE_DATA'));assert.ok(!JSON.stringify(f.backendWire.slice(backend)).includes('SYNTHETIC_FLOAT_PRIVATE_DATA'));
        assert.ok(!f.backendWire.slice(backend).some(body=>['turn','tool'].includes(body.operation)));
        assert.equal(f.assistant.workspaceActionReceipts(room.scope).at(-1).state,'complete');
    }
    assert.equal(f.floatWrites.length,6);assert.equal(f.approvals.length,6);assert.equal(f.nativeWire.length,12);assert.ok(f.f.counts.call>=6);
    assert.ok(trace.some(row=>row.deviceUi));assert.ok(trace.some(row=>row.operation==='list'));assert.ok(trace.some(row=>row.serviceId));assert.ok(trace.some(row=>row.assistant&&row.location==='float'));
    const action=execute('proposed','float_execute_tool',{name:'写入合成便签',argumentsJson:'{"text":"ONE_REVIEWED_WRITE"}'});
    f.setModel(({results})=>results.length?{content:'Synthetic final'}:{calls:[action]});
    const declined=await f.create();f.register(declined,['写入合成便签'],false);const writes=f.floatWrites.length;await assert.rejects(f.run(declined));assert.equal(f.floatWrites.length,writes);assert.equal(f.assistant.workspaceActionReceipts(declined.scope).length,0);
    const lost=await f.create();f.register(lost,['写入合成便签']);f.setFloatMode('lost');await assert.rejects(f.run(lost),error=>!error.message.includes('PRIVATE_UPSTREAM'));assert.equal(f.floatWrites.length,writes+1);assert.equal(f.assistant.workspaceActionReceipts(lost.scope).at(-1).state,'uncertain');
    assert.throws(()=>f.register(lost,['写入合成便签']),/先核对/);const beforeResume=f.modelWire.length,detail=await f.client.spaceCall('work','detail',{workspaceId:lost.workspace.id});await assert.rejects(f.client.runWorkspaceChat(detail.workspace,f.model,null,new AbortController().signal));assert.equal(f.modelWire.length,beforeResume);f.setFloatMode('');
    const storage=await f.create();f.register(storage,['写入合成便签']);f.setStorageFailure(true);const beforeStore=f.floatWrites.length;await assert.rejects(f.run(storage));assert.equal(f.floatWrites.length,beforeStore);f.setStorageFailure(false);
    const revoked=await f.create();await f.enableNative(revoked);f.register(revoked,[]);const nativeBefore=f.nativeWire.length;f.setModel(()=>{f.nativeStop(revoked.scope);return {calls:[execute('late','phone_observe_ui',{})]};});await assert.rejects(f.run(revoked));assert.equal(f.nativeWire.length,nativeBefore);
    const old=await f.create();await f.enableNative(old);f.setComposed(false);assert.throws(()=>f.register(old,[]),/APK/);f.setComposed(true);
    const drift=await f.create();f.register(drift,['写入合成便签']);f.setModel(()=>{f.setCatalogChanged(true);return {calls:[action]};});const beforeDrift=f.floatWrites.length;await assert.rejects(f.run(drift));assert.equal(f.floatWrites.length,beforeDrift);f.setCatalogChanged(false);
    // Explicit canonical memory tools use the same real owner route/review DB.
    const memory=new f.memoryTools.WorkspaceMemoryTools(),signal=new AbortController().signal,context={mode:'work',workspaceId:'synthetic-context',runId:'synthetic-run',callId:'memory-read'};
    const first=await memory.execute('读取共享记忆',{id:'memory-synthetic-1'},context,signal);
    const changed=await memory.execute('保存共享记忆',{id:first.id,revision:first.revision,content:'SYNTHETIC_CORRECTED_CANONICAL_MEMORY'},{...context,callId:'memory-edit'},signal);assert.equal(changed.saved,true);
    await assert.rejects(memory.execute('保存共享记忆',{id:first.id,revision:first.revision,content:'MUST_NOT_OVERWRITE'}, {...context,callId:'stale-edit'},signal));
    const history=await memory.execute('查看共享记忆历史',{id:first.id},{...context,callId:'history'},signal);assert.ok(history.history.length>0);assert.equal(history.history[0].source.proposedBy,'selected_model');assert.equal(history.history[0].source.confirmation,'human_per_action');
    const undone=await memory.execute('撤销共享记忆修改',{operationId:history.history[0].id},{...context,callId:'undo'},signal);assert.equal(undone.undone,true);
    const restored=await memory.execute('读取共享记忆',{id:first.id},{...context,callId:'read-after-undo'},signal);assert.equal(restored.content,first.content);
    const unknown=new f.memoryTools.WorkspaceMemoryTools();await assert.rejects(unknown.execute('保存共享记忆',{id:first.id,revision:first.revision,content:'MUST_READ_FIRST'},context,signal));
    const unauth=await f.create();f.register(unauth,[]);f.setModel(()=>({calls:[execute('forbidden-memory','float_execute_tool',{name:'保存共享记忆',argumentsJson:'{"content":"MUST_NOT_CREATE"}'})]}));await assert.rejects(f.run(unauth));
    assert.ok(!JSON.stringify([...f.f.kv.values()]).includes('SYNTHETIC_FLOAT_PRIVATE_DATA'));assert.ok(!JSON.stringify([...f.f.kv.values()]).includes('SYNTHETIC_CORRECTED_CANONICAL_MEMORY'));
    console.log('Workbench assistant: 3 providers x 2 scopes combine live SQLite file tools, synthetic phone children, actual managed MCP and Float confirmation; revoke, old APK, config drift, storage-before-effect, unknown receipt/no replay; actual canonical edit/history/undo CAS passed. No real model/phone/account.');
}finally{await f.close();}
