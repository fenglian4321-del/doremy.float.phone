// Fixed source allowlist only. Never scans a home, environment, vault or deployment directory.
import { readFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import JSZip from 'jszip';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--outdir' || !path.isAbsolute(args[1])) throw Error('Use --outdir <absolute output directory>; no deployment or automatic overwrite is performed.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), output = args[1];
const files = [
    'tools/float-android-build/verify_apk.py',
    'docs/private-memory-phase15-apk-build.md',
    'scripts/package-private-memory-phase15.mjs',
    'lib/phone-file-tools.ts',
    'scripts/test-phone-file-tools.mjs',
    'scripts/test-phone-file-tools-ui.mjs',
    'tools/float-android-build/local_build.py',
    'tools/float-android-build/test_local_build.py',
    'tools/float-android-build/README.md',
    'scripts/package-private-memory-phase14.mjs',
    'docs/private-memory-phase14-phone-tools.md',
    "android-shell/DIAGNOSTICS.md",
    "android-shell/README.md",
    "android-shell/app/build.gradle",
    "android-shell/app/src/main/AndroidManifest.xml",
    "android-shell/app/src/main/java/app/floatphone/shell/AmbientLightMonitorService.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/BootReceiver.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/CalendarBridge.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/CallActionReceiver.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/CallAlert.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/CallControlService.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/CallOverlayService.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/CheckInService.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/DeviceActionBridge.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/HealthBridge.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/IncomingCallActivity.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/LocationBridge.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/MediaControlListenerService.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/NativeRealityBridge.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/NotificationReplyReceiver.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/OverlayActionReceiver.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/PerceptionBridge.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/PhoneWidgetConfigActivity.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/PhoneWidgetProvider.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/PhoneWidgetRenderer.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/PushService.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/ScreenshotBallService.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/ScreenshotBridge.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/ShellBus.kt",
    "android-shell/app/src/main/res/drawable/appicon.png",
    "android-shell/app/src/main/res/drawable/ic_stat.xml",
    "android-shell/app/src/main/res/layout/phone_widget.xml",
    "android-shell/app/src/main/res/values/strings.xml",
    "android-shell/app/src/main/res/values/themes.xml",
    "android-shell/app/src/main/res/xml/call_control_service.xml",
    "android-shell/app/src/main/res/xml/network_security_config.xml",
    "android-shell/app/src/main/res/xml/phone_widget_info.xml",
    "android-shell/app/src/main/res/xml/shared_video_paths.xml",
    "android-shell/build.gradle",
    "android-shell/gradle.properties",
    "android-shell/settings.gradle",
    "android-shell/app/src/main/java/app/floatphone/shell/ScopedFilesBridge.kt",
    "android-shell/app/src/main/java/app/floatphone/shell/ScopedFilePolicy.java",
    "android-shell/policy-test/ScopedFilePolicyTest.java",
    ".github/workflows/android-shell.yml",
    "NOTICE",
    "lib/scoped-phone-files.ts",
    "components/memory/phone-directory-panel.tsx",
    "scripts/check-android-permissions.mjs",
    "scripts/check-scoped-files.mjs",
    "scripts/test-scoped-phone-files.mjs",
    "scripts/test-usage-ledger.mjs",
    "scripts/test-usage-reasons.mjs",
    "lib/api-helpers.ts",
    "lib/memory-embedding.ts",
    "docs/private-memory-phase13-phone-files-usage.md",
    "scripts/package-private-memory-phase13.mjs",
    'lib/xinchao-chat.ts', 'lib/xinchao-ephemeral.ts', 'lib/api-log-store.ts',
    'app/api/shared-memory/xinchao/now/route.ts',
    'scripts/test-xinchao-chat.mjs', 'scripts/package-private-memory-phase12.mjs',
    'docs/private-memory-phase12-xinchao-chat-state.md',
    'tools/float-memory-review/test_space_history_context.py',
    'docs/private-memory-phase11-space-context-history.md',
    'scripts/package-private-memory-phase11.mjs',
    'lib/desktop-config.ts', 'components/desktop-shell.tsx', 'components/icon-glyph.tsx',
    'lib/xinchao-types.ts', 'lib/xinchao-client.ts', 'lib/server/xinchao.ts',
    'app/api/shared-memory/xinchao/route.ts',
    'components/xinchao/xinchao-app.tsx', 'components/xinchao/xinchao.module.css',
    'scripts/test-xinchao.mjs', 'scripts/package-private-memory-phase10.mjs',
    'docs/private-memory-phase10-xinchao-view.md',
    'app/api/shared-memory/private-space/route.ts',
    'lib/space-attachments.ts',
    'tools/float-memory-review/float_private_spaces.py',
    'tools/float-memory-review/test_private_spaces.py',
    'tools/float-memory-review/check_overlay_package.py',
    'tools/float-memory-review/test_overlay_package.py',
    'tools/float-memory-review/test_review_service.py',
    'tools/float-memory-review/test_orbis_import.py',
    'tools/float-memory-review/vault_backup.py',
    'tools/float-memory-review/test_vault_backup.py',
    'docs/private-memory-phase9-private-spaces.md',
    'scripts/package-private-memory-phase9.mjs',
    'LICENSE', '.env.example', 'package.json',
    'app/api/shared-memory/workspaces/route.ts',
    'lib/workspace-client.ts',
    'lib/chat-storage.ts',
    'lib/llm-prompt-assembler.ts',
    'components/memory/workspace-panel.tsx',
    'components/memory/workspace.module.css',
    'scripts/test-workspaces.mjs',
    'scripts/package-private-memory-phase8.mjs',
    'tools/float-memory-review/float_workspaces.py',
    'tools/float-memory-review/test_workspaces.py',
    'tools/float-memory-review/workspace_test_host.py',
    'docs/private-memory-phase8-workspaces.md',
    'app/api/shared-memory/consolidation/route.ts',
    'lib/consolidation-protocol.ts',
    'lib/consolidation-client.ts',
    'lib/consolidation-budget.ts',
    'lib/memory-storage.ts',
    'lib/memory-summarizer.ts',
    'lib/core-memory-builder.ts',
    'lib/settings-types.ts',
    'lib/llm-provider-adapter.ts',
    'components/memory/shared-consolidation-panel.tsx',
    'components/settings/api-settings.tsx',
    'scripts/test-consolidation.mjs',
    'scripts/package-private-memory-phase7.mjs',
    'tools/float-memory-review/float_consolidation.py',
    'tools/float-memory-review/test_consolidation.py',
    'tools/float-memory-review/float_orbis_import.py',
    'docs/private-memory-phase-7-consolidation.md',
    'docs/private-expansion-next.md',
    'app/api/shared-memory/route.ts', 'app/api/shared-memory/codex/route.ts',
    'lib/server/shared-memory.ts', 'lib/server/shared-memory-review.ts', 'lib/server/codex-gateway.ts',
    'lib/codex-gateway-client.ts', 'lib/codex-gateway-policy.mjs', 'lib/codex-gateway-policy.d.mts',
    'lib/tool-storage.ts', 'lib/tool-executor.ts', 'lib/chat-engine.ts', 'lib/group-chat-engine.ts', 'lib/memory-service.ts', 'lib/usage-ledger.ts',
    'components/memory/codex-gateway-panel.tsx', 'components/memory/memory-bank-page.tsx',
    'components/memory/shared-memory-review-panel.tsx', 'components/memory/shared-memory.module.css', 'components/memory/usage-ledger-panel.tsx',
    'scripts/test-codex-gateway.mjs', 'scripts/test-memory-controls.mjs', 'scripts/test-shared-memory-origin.mjs', 'scripts/test-shared-memory-review.mjs', 'scripts/package-private-memory-increment.mjs',
    'tools/float-codex-gateway/server.mjs', 'tools/float-codex-gateway/README.md', 'tools/float-codex-gateway/example.env',
    'tools/float-memory-review/review_service.py', 'tools/float-memory-review/install_overlay.py', 'tools/float-memory-review/Dockerfile.overlay',
    'tools/float-memory-review/float_latent_semantic.py', 'tools/float-memory-review/float_provider_state.py',
    'tools/float-memory-review/test_latent_semantic.py', 'tools/float-memory-review/test_provider_state.py',
    'tools/float-memory-review/semantic-config.example.env', 'tools/float-memory-review/README.md',
    ...['LICENSE', 'UPSTREAM.md', '__init__.py', 'memory_retrieval.py', 'embedding_provider.py', 'chunking_experiment.py', 'time_context.py'].map(name => 'tools/float-memory-review/float_latent_vendor/' + name),
    'docs/private-memory-phase-5-codex.md', 'docs/private-memory-phase-6-semantic.md', 'docs/private-memory-phase-5-6-migration.md',
];
for (const check of ['scripts/check-android-permissions.mjs', 'scripts/check-scoped-files.mjs']) { const checked = spawnSync(process.execPath, [path.join(root, check)], { cwd: root, encoding: 'utf8', windowsHide: true }); if (checked.status !== 0) throw Error('Android source contract failed: ' + checked.stderr + checked.stdout); }
const properties = (await readFile(path.join(root, 'android-shell/gradle.properties'), 'utf8')).split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));
if (properties.some(line => !/^(?:org\.gradle\.jvmargs|android\.useAndroidX|android\.nonTransitiveRClass|kotlin\.code\.style)=/.test(line.trim()))) throw Error('Unreviewed Android Gradle property; refusing source packaging');
const packageCheck = spawnSync('python', [path.join(root, 'tools/float-memory-review/check_overlay_package.py'), '--allowlist-stdin'], { cwd: root, encoding: 'utf8', input: JSON.stringify(files), windowsHide: true });
if (packageCheck.status !== 0) throw Error('Overlay package incomplete: ' + packageCheck.stderr + packageCheck.stdout);
if (new Set(files).size !== files.length) throw Error('Duplicate source allowlist entries');
const zip = new JSZip(), records = [], sha256 = data => createHash('sha256').update(data).digest('hex');
for (const relative of files) {
    const absolute = path.resolve(root, relative);
    if (path.relative(root, absolute).startsWith('..')) throw Error('Source path escaped repository');
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) throw Error('Expected a regular allowlisted source file: ' + relative);
    const data = await readFile(absolute);
    if (relative.endsWith('.env') || relative === '.env.example') {
        for (const line of data.toString('utf8').split(/\r?\n/)) {
            const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
            if (match && /(?:KEY|TOKEN|PASSWORD|SECRET)$/.test(match[1]) && match[2].trim()) throw Error('Refusing nonempty credential field in source template: ' + relative);
        }
    }
    zip.file(relative, data); records.push({ path: relative, bytes: data.length, sha256: sha256(data) });
}
const result = spawnSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (result.status !== 0) throw Error('Could not identify local Git base');
const manifest = {
    format: 'float-private-increment/v1', stages: ['actual-local-android-debug-build-and-v2-verification', 'windows-long-path-sdk-extraction-completion-marker', 'default-off-scoped-phone-ai-web-prototype', 'phone-only-location-explicit-model-tools', 'ephemeral-tool-bodies-and-no-replay-on-interruption', 'task-local-build-tools-sdk-license-explicitly-accepted', 'scoped-android-directory-apk-built-not-device-validated', 'manual-create-only-phone-files', 'fixed-usage-request-reasons', 'xinchao-optional-bound-private-chat-state', 'transient-state-log-redaction-and-disable', 'feedback-and-proactive-still-off-unimplemented', 'explicit-space-context-compression', 'file-version-history-cas-restore', 'lost-acknowledgement-lease-recovery', 'xinchao-standalone-read-only-app', 'isolated-ai-private-spaces', 'explicit-versioned-text-attachments', 'overlay-package-completeness', 'isolated-workspaces', 'workspace-file-tools', 'gemini-provider-call-ids', 'threshold-consolidation', 'direct-memory-dispatch', 'codex-prototype-diagnostic-only', 'latent-settings-unchanged', 'provider-persistence-preserved'],
    localGitHead: result.stdout.trim(), serverSnapshot: '/opt/float-private-phase13-20261109', serverBaselineCompared: false,
    note: 'Full current versions of fixed allowlisted files, not an automatic patch. Review against frozen server source and rebuild separately. No private deployment files, state, credentials, node_modules or .next are included.',
    androidBuild: { versionName: '1.0.30', versionCode: 29, actualApkBuilt: true, requiresSameSignature: true, requiresDeviceValidation: true, manualFilesOnly: false, aiPhoneFilesDefaultOff: true, aiPhoneFilesDeviceValidated: false, sdkInstalled: true, signing: 'new-task-local-debug', existingInstallationSignatureCompared: false },
    apkBuildEvidence: { artifact: 'float-phase15-1.0.30-debug.apk', bytes: 6233261, sha256: '79be60256ef6e15273dc88338bb47bc4acf3d980ddb45b80ff9aa86c6e456dd5', certificateSha256: '351389dd01e2248f1d5390e1a5360c74525838ba7b1388ac7b8e72995278fb0e', signatureVerified: true, signatureSchemeV2: true, installed: false, deviceValidated: false },
    files: records,
};
const manifestText = JSON.stringify(manifest, null, 2) + '\n'; zip.file('INCREMENT-MANIFEST.json', manifestText);
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
// Verify the generated archive's entries and hashes before writing deliverables.
const reopened = await JSZip.loadAsync(bytes);
for (const record of records) if (sha256(await reopened.file(record.path).async('nodebuffer')) !== record.sha256) throw Error('Archive hash mismatch');
const unexpected = Object.values(reopened.files).filter(file => !file.dir && file.name !== 'INCREMENT-MANIFEST.json' && !files.includes(file.name));
if (unexpected.length) throw Error('Unexpected archive entry');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'float-phase15-source-delta.zip'), bytes, { flag: 'wx' });
await writeFile(path.join(output, 'float-phase15-source-manifest.json'), manifestText, { flag: 'wx' });
console.log(JSON.stringify({ sourceFiles: records.length, archiveBytes: bytes.length, archiveSha256: sha256(bytes), serverBaselineCompared: false }));
