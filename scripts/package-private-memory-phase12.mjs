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
    format: 'float-private-increment/v1', stages: ['xinchao-optional-bound-private-chat-state', 'transient-state-log-redaction-and-disable', 'feedback-and-proactive-still-off-unimplemented', 'explicit-space-context-compression', 'file-version-history-cas-restore', 'lost-acknowledgement-lease-recovery', 'xinchao-standalone-read-only-app', 'xinchao-links-off-and-unimplemented', 'isolated-ai-private-spaces', 'explicit-versioned-text-attachments', 'overlay-package-completeness', 'isolated-workspaces', 'workspace-file-tools', 'gemini-provider-call-ids', 'threshold-consolidation', 'direct-memory-dispatch', 'codex-prototype-diagnostic-only', 'latent-settings-unchanged', 'provider-persistence-preserved'],
    localGitHead: result.stdout.trim(), serverSnapshot: '/opt/float-private-phase10-20261109', serverBaselineCompared: false,
    note: 'Full current versions of fixed allowlisted files, not an automatic patch. Review against frozen server source and rebuild separately. No private deployment files, state, credentials, node_modules or .next are included.',
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
await writeFile(path.join(output, 'float-phase12-source-delta.zip'), bytes, { flag: 'wx' });
await writeFile(path.join(output, 'float-phase12-source-manifest.json'), manifestText, { flag: 'wx' });
console.log(JSON.stringify({ sourceFiles: records.length, archiveBytes: bytes.length, archiveSha256: sha256(bytes), serverBaselineCompared: false }));
