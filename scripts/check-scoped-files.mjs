import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(path.join(root, name), 'utf8');
const dir = 'android-shell/app/src/main/java/app/floatphone/shell/';
const native = read(dir + 'ScopedFilesBridge.kt'), activity = read(dir + 'MainActivity.kt'), manifest = read('android-shell/app/src/main/AndroidManifest.xml');
assert.ok(!/MANAGE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE/.test(manifest));
// Preserve the original <=Android9 media-save permission, without broadening it.
assert.match(manifest, /android:name="android.permission.WRITE_EXTERNAL_STORAGE"\s+android:maxSdkVersion="28"/);
for (const method of ['getScopedFilesCapabilities', 'requestScopedDirectory', 'submitScopedFiles', 'getScopedFilesResult', 'verifyScopedFiles', 'cancelScopedFiles']) assert.match(activity, new RegExp('@JavascriptInterface\\s+fun ' + method + '\\('));
assert.match(activity, /SecureJavascriptBridge\(ShellBridge\(\)\)/);
assert.ok(!/addJavascriptInterface\(.*scopedFiles/i.test(activity));
assert.match(activity, /ACTION_OPEN_DOCUMENT_TREE/); assert.match(activity, /isTrustedShellPage\(\).*isFinishing/);
assert.match(native, /takePersistableUriPermission/); assert.match(native, /releasePersistableUriPermission/);
assert.match(native, /isChildDocument/); assert.match(native, /getTreeDocumentId/);
assert.ok(!/java\.io\.File|FileInputStream|FileOutputStream|Runtime\.getRuntime|ProcessBuilder|https?:\/\/[^"']/.test(native));
assert.ok(!/deleteDocument|renameDocument|copyDocument|moveDocument/.test(native), 'No destructive file operations');
assert.match(native, /grant\.getJSONObject|same\(it\.getJSONObject\("scope"\), job\.scope\)/);
assert.ok(native.indexOf('journal(job, id, digest, null)') < native.indexOf('DocumentsContract.createDocument'));
assert.ok(native.indexOf('if (children(tree, parent, job).any') < native.indexOf('DocumentsContract.createDocument'));
assert.match(native, /actual\.contentEquals\(bytes\)/);
assert.match(native, /LinkedBlockingQueue<Runnable>\(8\)/);
assert.match(native, /job\.writing\) error\("write_uncertain"\)/);
assert.ok(!native.includes('failure.message).toString()'), 'Never echo provider exceptions or URIs');
if (process.argv.includes('--compile-policy')) {
    const workRoot = path.resolve(process.env.FLOAT_TEST_WORK_DIR || path.join(root, 'work'));
    mkdirSync(workRoot, { recursive: true });
    const output = mkdtempSync(path.join(workRoot, 'scoped-file-policy-'));
    const compiler = spawnSync(process.env.FLOAT_TEST_JAVAC || 'javac', ['--release', '11', '-encoding', 'UTF-8', '-d', output, path.join(root, dir, 'ScopedFilePolicy.java'), path.join(root, 'android-shell/policy-test/ScopedFilePolicyTest.java')], { encoding: 'utf8', windowsHide: true });
    if (compiler.error || compiler.status !== 0) throw Error('JDK 11+ required for standalone policy check: ' + (compiler.error?.message || compiler.stderr));
    const tested = spawnSync(process.env.FLOAT_TEST_JAVA || 'java', ['-cp', output, 'ScopedFilePolicyTest'], { encoding: 'utf8', windowsHide: true });
    if (tested.status !== 0) throw Error(tested.stderr || 'JVM policy fixtures failed');
    process.stdout.write(tested.stdout);
}
console.log('Scoped Android files: permission, secure-dispatch, SAF, create-only, verification and durable-intent static checks passed. APK build still requires JDK17/Gradle/Android SDK.');
