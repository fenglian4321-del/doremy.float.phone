// Real selected-model adapters, assistant, Shizuku client, owner routes and SQLite.
// Binder, phone, permission dialogs and model replies are simulated; no device use.
import assert from 'node:assert/strict';
import { createWorkbenchFixture } from './workbench-fixture.mjs';
const f = await createWorkbenchFixture(), trace = [];
const action = (id, name) => ({ id, name, args: {} });
try {
    for (const mode of ['work', 'private']) for (const provider of ['Custom', 'Anthropic', 'Google']) {
        const room = await f.create(mode), grant = f.enableShizuku(room), count = f.shizukuEffects.length;
        f.register(room);
        const calls = ['shizuku_system_info', 'shizuku_app_info', 'shizuku_launch_app'].map((name, i) => action('shizuku-call-' + i, name));
        f.setModel(({ protocol, results, body }) => {
            const ids = protocol === "anthropic" ? body.messages.flatMap(row => Array.isArray(row.content) ? row.content : []).filter(row => row.type === "tool_result").map(row => row.tool_use_id) : protocol === "gemini" ? body.contents.flatMap(row => row.parts).filter(row => row.functionResponse).map(row => row.functionResponse.id) : body.messages.filter(row => row.role === "tool").map(row => row.tool_call_id);
            assert.deepEqual(ids, calls.slice(0, results.length).map(row => row.id));
            assert.ok(!JSON.stringify(body).includes('PRIVATE_LIFE_PERSONA'));
            return results.length < calls.length ? { calls: [calls[results.length]] } : { content: 'Results from the selected Shizuku channel.' };
        });
        const result = await f.run(room, { ...f.model, provider, baseUrl: provider === 'Custom' ? f.model.baseUrl : undefined }, item => trace.push(item));
        assert.equal(result.run.state, 'complete'); assert.equal(f.shizukuEffects.length - count, 3);
        for (const wire of f.shizukuWire.slice(-3)) { assert.equal(wire.grantId, grant.id); assert.equal(wire.scope.mode, mode); assert.equal(wire.scope.workspaceId, room.scope.workspaceId); assert.deepEqual(Object.keys(wire).sort(), ['action','grantId','operation','requestId','scope']); }
        const messages = result.workspace.messages.filter(row => row.role === 'assistant'); assert.ok(messages.length);
    }
    assert.ok(trace.some(row => row.location === 'shizuku' && row.ok));
    const off = await f.create(); f.register(off);
    f.setModel(({ body }) => { assert.ok(!JSON.stringify(body).includes('"name":"shizuku_')); return { content: 'Tools disabled.' }; });
    await f.run(off);
    const readOnly = await f.create(); f.enableShizuku(readOnly, false); const session = f.shizuku.getShizukuSession(readOnly.scope);
    assert.deepEqual(Array.from(session.tools(), row => row.name), ['shizuku_system_info', 'shizuku_app_info']);
    await assert.rejects(session.bindTask('Different task'), /任务/);
    const elsewhere = await f.create('private'); assert.equal(f.shizuku.getShizukuSession(elsewhere.scope), null);
    f.shizuku.disableShizukuTools(readOnly.scope);
    const beforeDeath = await f.create(); f.enableShizuku(beforeDeath); f.register(beforeDeath);
    f.setModel(() => { f.shizukuState.ready = false; f.shizukuState.status = 'disconnected'; f.shizukuState.epoch++; return { calls: [action('dead', 'shizuku_system_info')] }; });
    let count = f.shizukuEffects.length; await assert.rejects(f.run(beforeDeath)); assert.equal(f.shizukuEffects.length, count);
    const revoked = await f.create(); f.enableShizuku(revoked); f.register(revoked);
    f.setModel(() => { f.shizukuState.ready = false; f.shizukuState.status = 'revoked'; return { calls: [action('revoked', 'shizuku_app_info')] }; });
    count = f.shizukuEffects.length; await assert.rejects(f.run(revoked)); assert.equal(f.shizukuEffects.length, count);
    const stopped = await f.create(); f.enableShizuku(stopped); f.register(stopped);
    f.setModel(() => { f.shizuku.disableShizukuTools(stopped.scope); return { calls: [action('cancelled', 'shizuku_launch_app')] }; });
    count = f.shizukuEffects.length; await assert.rejects(f.run(stopped)); assert.equal(f.shizukuEffects.length, count);
    const during = await f.create(); f.enableShizuku(during); f.register(during); f.setShizukuMode('death');
    f.setModel(() => ({ calls: [action('during', 'shizuku_launch_app')] })); count = f.shizukuEffects.length;
    await assert.rejects(f.run(during)); assert.equal(f.shizukuEffects.length, count); assert.ok(f.shizuku.shizukuPending(during.scope));
    f.setShizukuMode(''); const modelCount = f.modelWire.length; const detail = await f.client.spaceCall('work','detail',{workspaceId:during.workspace.id});
    await assert.rejects(f.client.runWorkspaceChat(detail.workspace, f.model, null, new AbortController().signal)); assert.equal(f.modelWire.length, modelCount);
    const storage = await f.create(); f.enableShizuku(storage); f.register(storage); f.setStorageFailure(true); count = f.shizukuWire.length;
    await assert.rejects(f.run(storage)); assert.equal(f.shizukuWire.length, count); f.setStorageFailure(false);
    const old = await f.create(); const api = f.shizukuWindow.AndroidShell; f.shizukuWindow.AndroidShell = undefined;
    assert.equal(f.shizuku.shizukuStatus().supported, false); assert.throws(() => f.enableShizuku(old), /授权|APK|未确认/); f.shizukuWindow.AndroidShell = api;
    console.log('Shizuku: 3 providers x 2 scopes, exact IDs via real adapters, task/owner leases, default off, read-only grant, scope/task isolation, Binder death before/during call, revoked permission, old APK/browser rejection, durable-before-action failure and no replay passed. Native/Binder/model are simulated.');
} finally { await f.close(); }
