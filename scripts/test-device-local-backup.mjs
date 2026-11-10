// Exercise actual restore/export functions with synthetic storage, no user DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const policyModule = { exports: {} };
vm.runInNewContext(compile(readFileSync(new URL('../lib/data-management/device-local-state.ts', import.meta.url), 'utf8')), { module: policyModule, exports: policyModule.exports });
const policy = policyModule.exports;
const source = ts.createSourceFile('idb.ts', readFileSync(new URL('../lib/data-management/idb.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['importSource', 'exportKvSource', 'exportLocalStorageSource'];
const code = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(source)).join('\n') + '\nmodule.exports = { importSource, exportKvSource, exportLocalStorageSource };';
const kv = new Map(), local = new Map(), rows = new Map(), module = { exports: {} };
const keys = ['float_shizuku_profile_receipt_v1_chat', 'float_shizuku_receipt_v1_work', 'float_shizuku_run_v1_work', 'float_workspaces_v1_work', 'float_private_spaces_v1_private', 'float_phone_files_receipt_v1_work', 'float_phone_tool_run_v1_work', 'float_phone_device_ui_v1_work', 'float_phone_device_run_v1_work', 'float_managed_mcp_receipt_v1_work', 'float_managed_mcp_run_v1_work', 'float_xinchao_proactive_v1', 'float_xinchao_proactive_claims_v1', 'float_xinchao_feedback_v1', 'float_xinchao_feedback_recent_v1'];
for (const key of keys) { kv.set(key, 'LOCAL_AUTHORITY'); local.set(key, 'LOCAL_AUTHORITY'); }
const safe = { key: 'ordinary_note', value: 'USER_CONTENT' };
const storage = { get length() { return local.size; }, key: index => [...local.keys()][index], getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) };
const store = { keyPath: 'key', get: key => rows.get(key), put: value => rows.set(value.key, value) };
const db = { objectStoreNames: { contains: () => true }, transaction: () => ({ objectStore: () => store }), close() {} };
vm.runInNewContext(compile(code), { module, exports: module.exports, ...policy, window: { localStorage: storage }, kvGet: key => kv.get(key) ?? null, kvSetAsync: async (key, value) => kv.set(key, value), deserializeStorageString: async value => value, deserializeValue: async value => value, serializeStorageString: async value => value, readKvRecords: async () => [...kv].map(([key, value]) => ({ key, value })), matchesKey: () => true, ensureStores: async () => db, transactionDone: async () => {}, runRequest: async value => value, tryMergeJsonArrayByKey: () => null, tryReplaceEmptyJsonValue: () => null, formatImportError: error => String(error), Blob });
for (const type of ['kv', 'localStorage']) {
    const progress = [], result = await module.exports.importSource({ type, records: [...keys.map(key => ({ key, value: 'RESTORED_AUTHORITY' })), safe] }, true, undefined, done => progress.push(done));
    assert.equal(result.skipped, keys.length); assert.equal(result.added, 1); assert.equal(result.errors.length, 0); assert.equal(progress.at(-1), keys.length + 1);
    for (const key of keys) assert.equal((type === 'kv' ? kv : local).get(key), 'LOCAL_AUTHORITY');
    const exported = await module.exports[type === 'kv' ? 'exportKvSource' : 'exportLocalStorageSource']({ type, includeAll: true });
    assert.deepEqual(JSON.parse(JSON.stringify(exported.records)), [safe]);
}
const restored = await module.exports.importSource({ type: 'indexeddb', dbName: 'AiPhoneKvDB', stores: [{ name: 'entries', keyPath: 'key', records: [...keys.map(key => ({ key, value: { key, value: 'RESTORED_AUTHORITY' } })), { key: safe.key, value: safe }] }] }, true);
assert.equal(restored.skipped, keys.length); assert.equal(rows.size, 1); assert.equal(rows.get(safe.key).value, safe.value);
assert.equal(policy.isDeviceLocalExecutionKey('float_workspaces_ui_mode_v1'), false);
assert.equal(policy.isDeviceLocalExecutionKey('ai_phone_diary_entries_v1'), false);
console.log('Backup restore: KV, legacy localStorage and raw KV database preserve local claims, skip transferred opt-ins, and retain ordinary content.');
