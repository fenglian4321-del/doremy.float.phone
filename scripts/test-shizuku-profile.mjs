// Real persistent client, role executor/capability registry, workspace loop and
// selected-model adapters. Android dialogs/Binder/commands are synthetic.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createWorkbenchFixture } from './workbench-fixture.mjs';
const f = await createWorkbenchFixture(), native = f.shizukuWindow, profile = { version: 1, configured: false, enabled: false, allowChat: true, allowLaunch: false, revision: 0, applications: [], recent: [] };
const tickets = new Map(), receipts = new Map(), effects = [], controls = [];
let fail = '', pending;
const reply = v => JSON.stringify({ protocol: 'float-shizuku/v1', state: 'complete', ...v });
native.AndroidShell = {
    getShizukuStatus: () => reply({ ...f.shizukuState, profile }),
    shizukuControl: raw => {
        const b = JSON.parse(raw); controls.push(b);
        if (b.operation === 'profile_config') { Object.assign(profile, { configured: true, enabled: b.enabled, allowChat: b.allowChat, allowLaunch: b.allowLaunch, revision: profile.revision + 1 }); return reply({ requestId: b.requestId }); }
        if (b.operation === 'profile_begin') { const ticketId = webcrypto.randomUUID(); tickets.set(ticketId, { scope: JSON.stringify(b.scope), revision: profile.revision, used: false }); return reply({ ticketId, revision: profile.revision }); }
        if (b.operation === 'profile_end') { tickets.delete(b.ticketId); return reply({}); }
        if (b.operation === 'profile_cancel') { pending = undefined; return reply({}); }
        if (b.operation === 'profile_receipt') return reply({ requestId: b.requestId, replayed: true, receipt: receipts.get(b.requestId) });
        if (b.operation === 'profile_result') return reply({ requestId: b.requestId, state: 'pending' });
        assert.equal(b.operation, 'profile_action'); const t = tickets.get(b.ticketId);
        assert.equal(t.scope, JSON.stringify(b.scope)); assert.equal(t.used, false); assert.equal(t.revision, profile.revision); t.used = true;
        assert.ok([...f.f.kv.values()].some(v => v.includes(b.requestId)), 'durable intent before native action');
        const receipt = { requestId: b.requestId, operation: b.action, state: 'complete' }; receipts.set(b.requestId, receipt);
        effects.push(b);
        if (fail === 'pending') { pending = b; return reply({ state: 'pending', requestId: b.requestId }); }
        if (fail === 'death') { f.shizukuState.ready = false; f.shizukuState.epoch++; }
        if (fail === 'revision') profile.revision++;
        return reply({ requestId: b.requestId, ...(fail === 'replay' ? { replayed: true } : {}), data: { uid: 2000, operation: b.action, location: 'android_shizuku', activityManagerReported: b.action === 'launch_app', synthetic: true }, receipt });
    },
};
try {
    f.shizukuState.ready = true; f.shizukuState.status = 'ready';
    const chat = { mode: 'chat', workspaceId: 'role-chat' };
    assert.equal(f.profile.persistentShizukuAvailable(true), false);
    await assert.rejects(f.profile.executePersistentShizuku(chat, { action: 'system_info' }));
    await f.profile.configureShizukuProfile(chat, { enabled: true, allowChat: true, allowLaunch: true });
    profile.applications = [{ packageName: 'org.example.synthetic', label: '合成应用' }];
    const capability = f.load('lib/internal-capability-storage.ts', { './kv-db': { ...f.db, registerKvMigration() {} }, './shizuku-profile': f.profile, './xinchao-core': { innerPreferences:()=>({tools:false,binding:null}) } }, true, { window: native });
    assert.ok(capability.getEnabledInternalCapabilities('chat').some(c => c.id === 'shizuku_phone'));
    const executor = f.load('lib/tool-executor.ts', { './shizuku-profile': f.profile, './internal-capability-storage': capability, './tool-storage': { loadRestTools: () => [], loadRestToolPackages: () => [], loadCompositeTools: () => [], loadCompositeToolPackages: () => [], loadMcpServers: () => [] } }, true, { window: native });
    for (const mode of ['chat', 'group_chat']) {
        const result = await executor.executeToolCalls([{ name: 'Shizuku手机助手', args: { action: 'launch_app', packageName: 'org.example.synthetic' } }], { appId: mode, sourceEngine: mode, sessionId: 'role-' + mode, signal: new AbortController().signal });
        assert.equal(result[0].success, true, result[0].error); assert.match(result[0].userNotice, /启动/);
        assert.equal(effects.at(-1).scope.mode, mode); assert.equal(effects.at(-1).scope.workspaceId, 'role-' + mode);
    }
    const before = effects.length;
    const denied = await executor.executeToolCalls([{ name: 'Shizuku手机助手', args: { action: 'launch_app', packageName: 'org.example.synthetic' } }], { appId: 'custom', sessionId: 'fake', sourceEngine: 'custom_app' });
    assert.equal(denied[0].success, false); assert.equal(effects.length, before);
    for (const mode of ['work', 'private']) for (const provider of ['Custom', 'Anthropic', 'Google']) {
        const room = await f.create(mode); f.register(room);
        f.setModel(({ body, results, protocol }) => {
            assert.ok(JSON.stringify(body).includes('shizuku_phone'));
            if (results.length) { const ids = protocol === 'anthropic' ? body.messages.flatMap(r => Array.isArray(r.content) ? r.content : []).filter(r => r.type === 'tool_result').map(r => r.tool_use_id) : protocol === 'gemini' ? body.contents.flatMap(r => r.parts).filter(r => r.functionResponse).map(r => r.functionResponse.id) : body.messages.filter(r => r.role === 'tool').map(r => r.tool_call_id); assert.deepEqual(ids, ['profile-call']); return { content: '真实结果以回执为准。' }; }
            return { calls: [{ id: 'profile-call', name: 'shizuku_phone', args: { action: 'system_info' } }] };
        });
        const result = await f.run(room, { ...f.model, provider, baseUrl: provider === 'Custom' ? f.model.baseUrl : undefined }); assert.equal(result.run.state, 'complete');
        assert.equal(effects.at(-1).scope.mode, mode); assert.equal(effects.at(-1).scope.workspaceId, room.scope.workspaceId); assert.equal(profile.enabled, true, 'ending one workspace run preserves durable opt-in');
    }
    assert.equal(controls.filter(c => c.operation === 'profile_config').length, 1, 'no per-message configuration');
    profile.allowChat = false; assert.equal(capability.getEnabledInternalCapabilities('chat').some(c => c.id === 'shizuku_phone'), false);
    await assert.rejects(f.profile.executePersistentShizuku(chat, { action: 'system_info' })); profile.allowChat = true;
    profile.allowLaunch = false; await assert.rejects(f.profile.executePersistentShizuku(chat, { action: 'launch_app', packageName: 'org.example.synthetic' })); profile.allowLaunch = true;
    await assert.rejects(f.profile.executePersistentShizuku(chat, { action: 'launch_app', packageName: 'other.app' }));
    await assert.rejects(f.profile.executePersistentShizuku(chat, { action: 'system_info', scope: { mode: 'work', workspaceId: 'injected' } }));
    f.setStorageFailure(true); const count = effects.length; await assert.rejects(f.profile.executePersistentShizuku(chat, { action: 'system_info' })); assert.equal(effects.length, count); f.setStorageFailure(false);
    for (const mode of ['death', 'revision', 'replay']) {
        const s = { ...chat, workspaceId: mode }; fail = mode;
        await assert.rejects(f.profile.executePersistentShizuku(s, { action: 'launch_app', packageName: 'org.example.synthetic' })); assert.ok(f.profile.profilePending(s));
        f.shizukuState.ready = true; const n = effects.length; await assert.rejects(f.profile.executePersistentShizuku(s, { action: 'system_info' })); assert.equal(effects.length, n);
        assert.equal(f.profile.profileReceipt(s).replayed, true); f.profile.acknowledgeProfileReceipt(s);
    }
    fail = 'pending'; const aborter = new AbortController(), s = { ...chat, workspaceId: 'cancelled' }, task = f.profile.executePersistentShizuku(s, { action: 'system_info' }, aborter.signal);
    await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(pending);
    await assert.rejects(f.profile.executePersistentShizuku(s, { action: 'system_info' })); aborter.abort(); await assert.rejects(task); assert.ok(f.profile.profilePending(s));
    assert.ok(controls.some(c => c.operation === 'profile_cancel')); fail = '';
    const api = native.AndroidShell; native.AndroidShell = undefined; assert.equal(f.profile.persistentShizukuAvailable(true), false); native.AndroidShell = api;
    console.log('Persistent Shizuku: role + group real executor, 3 adapters x 2 workspace scopes, one configuration across messages, scope/allowlist/read-only/disabled gates, durable-before-effect, concurrent exclusion, cancellation/death/revision/replay and uncertain receipts passed. Native/Binder/models synthetic.');
} finally { await f.close(); }
