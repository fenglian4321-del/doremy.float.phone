import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), dir = 'android-shell/app/src/main/java/app/floatphone/shell/';
const read = name => readFileSync(path.join(root, name), 'utf8');
const bridge = read(dir+'ShizukuBridge.kt'), service = read(dir+'ShizukuExecutor.kt'), main = read(dir+'MainActivity.kt');
for (const api of ['addBinderReceivedListenerSticky','addBinderDeadListener','addRequestPermissionResultListener','removeBinderReceivedListener','removeBinderDeadListener','removeRequestPermissionResultListener','bindUserService','unbindUserService']) assert.ok(bridge.includes(api), api);
assert.match(bridge,/IShizukuService\.Stub\.asInterface\(Shizuku.getBinder\(\)\)\.checkSelfPermission\(\)/);
assert.match(bridge,/linkToDeath/); assert.match(service,/client.linkToDeath/); assert.match(service,/ownerUid != Binder.getCallingUid\(\)/);
assert.match(bridge,/followRedirects\(false\)/); assert.match(bridge,/externalMode"\) != "assistant"/);
assert.match(bridge,/taskDigest"\) != g.taskDigest/); assert.match(bridge,/scope\.mode|scoped\?\.optString\("mode"\)/);
assert.ok(bridge.indexOf('putString(key, receipt.toString()).commit()') < bridge.indexOf('ready().execute(secret, id, action, g.pkg)'));
assert.match(main, /SecureJavascriptBridge\(ShellBridge\(\)\)/);
assert.match(main, /@JavascriptInterface\s+fun shizukuControl/); assert.match(main, /shizuku\.invalidateDocument\(\)/);
assert.ok(!/Shizuku\.newProcess|Runtime.getRuntime|sh -c|\/system\/bin\/sh/.test(bridge+service));
assert.match(read('android-shell/app/src/main/aidl/app/floatphone/shell/IShizukuExecutor.aidl'), /destroy\(\) = 16777114/);
assert.match(read('android-shell/app/src/main/AndroidManifest.xml'), /android:name="rikka.shizuku.ShizukuProvider"[\s\S]{0,250}android:permission="android.permission.INTERACT_ACROSS_USERS_FULL"/);
if (process.argv.includes('--compile-policy')) {
    const home = process.env.FLOAT_TEST_JAVA_HOME || process.env.JAVA_HOME; assert.ok(home,'Specify task-local JAVA_HOME');
    const work = path.resolve(process.env.FLOAT_TEST_WORK_DIR || path.join(root,'work')); mkdirSync(work,{recursive:true}); const out = mkdtempSync(path.join(work,'shizuku-policy-'));
    const javac=spawnSync(path.join(home,'bin',process.platform==='win32'?'javac.exe':'javac'),['-encoding','UTF-8','-d',out,...[dir+'DeviceUiPolicy.java',dir+'ShizukuPolicy.java','android-shell/policy-test/ShizukuPolicyTest.java'].map(name=>path.join(root,name))],{encoding:'utf8',windowsHide:true}); assert.equal(javac.status,0,javac.stderr);
    const java=spawnSync(path.join(home,'bin',process.platform==='win32'?'java.exe':'java'),['-cp',out,'ShizukuPolicyTest'],{encoding:'utf8',windowsHide:true}); assert.equal(java.status,0,java.stderr); process.stdout.write(java.stdout);
}
console.log('Shizuku official Binder/permission/lifecycle/task/receipt wiring checks passed; device execution remains untested.');
