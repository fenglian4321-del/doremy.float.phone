import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto, createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
const cache = new Map(), jobs = new Map(), counts = { submit: 0, create: 0, verify: 0, cancel: 0, network: 0 };
let shell = false, lost = false, pending = false, bad = false;
const scope = { mode: 'work', workspaceId: 'fixture-space' }, room = { mode: 'private', workspaceId: 'fixture-space' };
const grant = { id: 'synthetic-grant', label: '合成授权目录', readable: true, writable: true };
const text = 'PRIVATE_PHONE_SYNTHETIC_BODY';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify({ protocol: 'float-shell-files/v1', location: 'android_device', ...value });
const done = result => json({ ok: true, state: 'complete', result });
const native = {
    getScopedFilesCapabilities: () => json({ ok: true, createOnly: true, maxTextBytes: 32768 }),
    requestScopedDirectory: (raw, id) => { jobs.set(id, { scope: JSON.parse(raw), result: done({ grant }) }); return jobs.get(id).result; },
    submitScopedFiles: raw => {
        counts.submit++; const body = JSON.parse(raw); let result;
        if (body.scope.mode === 'private' && body.grantId === grant.id) result = json({ ok: false, code: 'grant_scope' });
        else if (body.operation === 'grants') result = done({ grants: [grant] });
        else if (body.operation === 'list') result = done({ path: body.path, files: [{ name: 'note.md', directory: false, bytes: 28 }] });
        else if (body.operation === 'read') result = done({ path: body.path, content: text, bytes: new TextEncoder().encode(text).byteLength, digest: sha(text) });
        else if (body.operation === 'revoke') result = done({ revoked: true });
        else if (body.operation === 'create') { counts.create++; result = done({ path: body.path, bytes: new TextEncoder().encode(body.content).byteLength, digest: sha(body.content), created: true }); }
        else throw Error('Unexpected operation');
        jobs.set(body.requestId, { scope: body.scope, result });
        if (lost) { lost = false; throw Error('content://DO_NOT_EXPOSE_PRIVATE_PROVIDER'); }
        if (bad) return json({ ok: true, state: 'complete', result: { content: 'bad', uri: 'content://private' } });
        return pending ? json({ ok: true, state: 'pending' }) : result;
    },
    getScopedFilesResult: (raw, id) => {
        const job = jobs.get(id);
        if (!job) return json({ ok: false, code: 'request_missing' });
        if (JSON.stringify(job.scope) !== raw) return json({ ok: false, code: 'grant_scope' });
        return pending ? json({ ok: true, state: 'pending' }) : job.result;
    },
    verifyScopedFiles: (raw, id) => { counts.verify++; return native.getScopedFilesResult(raw, id); },
    cancelScopedFiles: (raw, id) => { counts.cancel++; if (jobs.has(id)) jobs.get(id).result = json({ ok: false, code: 'cancelled' }); return json({ ok: false, code: 'cancelled' }); },
};
function load(crypto = webcrypto) {
    const module = { exports: {} };
    const code = ts.transpileModule(readFileSync(new URL('../lib/scoped-phone-files.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, require: name => name === './kv-db' ? { kvGet: k => cache.get(k), kvSet: (k, v) => cache.set(k, v), kvRemove: k => cache.delete(k), registerDynamicPrefix() {} } : { isShellEnvironment: () => shell }, window: { AndroidShell: native }, crypto, TextEncoder, Date, JSON, Error, Promise, AbortController, AbortSignal, setTimeout, clearTimeout, fetch: () => { counts.network++; throw Error('No remote fallback'); } });
    return module.exports;
}
const api = load();
assert.equal(api.phoneFileAvailability().available, false);
await assert.rejects(api.phoneFileCall(scope, 'grants'), /普通浏览器/); assert.equal(counts.submit, 0);
shell = true; assert.equal(api.phoneFileAvailability().available, true);
await assert.rejects(api.phoneFileCall({ mode: 'life', workspaceId: 'fixture' }, 'grants'), /工作或私人/);
await assert.rejects(api.phoneFileCall(scope, 'read', { grantId: grant.id, path: 'x.md', scope: room }), /参数不匹配/); assert.equal(counts.submit, 0);
assert.equal((await api.phoneFileCall(scope, 'picker')).grant.id, grant.id);
assert.equal((await api.phoneFileCall(scope, 'grants')).grants.length, 1);
assert.equal((await api.phoneFileCall(scope, 'list', { grantId: grant.id, path: '' })).files[0].name, 'note.md');
assert.equal((await api.phoneFileCall(scope, 'read', { grantId: grant.id, path: 'note.md' })).content, text);
assert.ok(!JSON.stringify([...cache.values()]).includes(text));
await assert.rejects(api.phoneFileCall(room, 'read', { grantId: grant.id, path: 'note.md' }), /不属于当前空间/);
lost = true;
await assert.rejects(api.phoneFileCall(scope, 'create', { grantId: grant.id, path: 'new.md', content: text }), error => error.code === 'uncertain' && !error.message.includes('content://'));
assert.equal(counts.create, 1); assert.ok(api.phoneFileReceipt(scope));
assert.ok(!JSON.stringify([...cache.values()]).includes(text)); assert.ok(!JSON.stringify([...cache.values()]).includes('new.md'));
await assert.rejects(api.phoneFileCall(scope, 'create', { grantId: grant.id, path: 'new.md', content: text }), /核对上次/);
assert.equal(counts.create, 1);
assert.equal((await api.recoverPhoneFileCall(scope)).created, true); assert.equal(counts.verify, 1); assert.equal(counts.create, 1);
assert.equal(api.phoneFileReceipt(scope), null);
bad = true;
await assert.rejects(api.phoneFileCall(scope, 'read', { grantId: grant.id, path: 'note.md' }), error => error.code === 'protocol'); bad = false;
assert.equal((await api.recoverPhoneFileCall(scope)).content, text);
pending = true; const controller = new AbortController();
const cancelled = api.phoneFileCall(scope, 'read', { grantId: grant.id, path: 'note.md' }, controller.signal);
controller.abort(); await assert.rejects(cancelled, /等待已停止/); assert.equal(counts.cancel, 1);
pending = false; await assert.rejects(api.recoverPhoneFileCall(scope), /已停止/); assert.equal(api.phoneFileReceipt(scope), null);
const early = new AbortController(); early.abort(); const before = counts.submit;
await assert.rejects(api.phoneFileCall(scope, 'grants', {}, early.signal)); assert.equal(counts.submit, before);
lost = true; await assert.rejects(api.phoneFileCall(scope, 'list', { grantId: grant.id, path: '' }));
api.abandonPhoneFileWait(scope); assert.equal(api.phoneFileReceipt(scope), null);
assert.equal(counts.network, 0);
assert.equal((await api.phoneFileCall(scope, 'revoke', { grantId: grant.id })).revoked, true);
let releaseHash;
const delayed = load({ randomUUID: webcrypto.randomUUID.bind(webcrypto), subtle: { digest: () => new Promise(resolve => { releaseHash = resolve; }) } });
const duringHash = new AbortController(), createsBeforeHash = counts.create;
const hashing = delayed.phoneFileCall(scope, 'create', { grantId: grant.id, path: 'cancel-before-submit.md', content: text }, duringHash.signal);
duringHash.abort(); releaseHash(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
await assert.rejects(hashing, /尚未提交/);
assert.equal(counts.create, createsBeforeHash); assert.equal(delayed.phoneFileReceipt(scope), null);
const nativeSource = readFileSync(new URL('../android-shell/app/src/main/java/app/floatphone/shell/ScopedFilesBridge.kt', import.meta.url), 'utf8');
const verify = nativeSource.slice(nativeSource.indexOf('    fun verify('), nativeSource.indexOf('    fun cancel('));
assert.ok(!/createDocument|openOutputStream/.test(verify)); assert.ok(verify.includes('expectedDigest'));
console.log('Scoped phone client: browser/old-bridge refusal, fixed work/private scope, explicit picker/list/read/create/revoke, lost create acknowledgement, read-only recovery, cancelled/invalid receipts, no raw KV or network fallback passed. Fake bridge only; no phone/SAF provider accessed.');
