"""Hash-checked, reversible extension for the existing heart service, no deployment."""
from pathlib import Path
import argparse, hashlib, json, shutil

HERE = Path(__file__).resolve().parent
CONTRACT = json.loads((HERE / 'upstream-contract.json').read_text(encoding='utf-8'))
def blob(data): return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()

IMPORT = "import { createFloatIntegration } from './float-integration.js';\n"
INIT = '''const floatIntegration = createFloatIntegration({
  config, model, dreamModel, store, cabin, personality, journal, drivePool,
  driveKeys: DRIVE_KEY_LIST, driveNames: DRIVE_SHORT, vitals: vitalsNow,
  snapshot: async () => buildDashboardSnapshot(await store.read(), config, new Date(), await personality.getPersonalityCore()),
  offset: (input) => { const off = normalizeOffset(input, Date.now()); if (off.error) throw new Error('invalid_body'); bodyOffsets.set(off.key, off); },
  satisfy: async (drive, eventId) => updateState({ type:'satisfy', source:'float', eventId, at:new Date() }, (state) => applySatisfaction(state, [drive], new Date(), { ...config.settle, eventId }).state),
  refill: async (drive) => {
    const prompts = await loadDrivePrompts(config.bridge.drivePromptsPath);
    const { head } = splitHint(prompts?.hints?.[drive] || '');
    if (!head) throw new Error('jar_prompt_unconfigured');
    const state = await store.read(), slot = slotOf(localDayAndHour(new Date(), config.settle.timeZone).hour);
    let failed = false;
    const job = drivePool.refill({ model, key:drive, short:DRIVE_SHORT[drive] || drive, head, slot, mood:moodOf(state), emotionLabel:state?.emotion?.label || '', log:(event) => { if (event === 'drive_pool_refill_failed') failed = true; } });
    if (!job) throw new Error('jar_busy_or_disabled');
    await job;
    if (failed) throw new Error('jar_refill_unconfirmed');
  },
});
await floatIntegration.ready;
'''
AUTH = "    if (!authorized(request)) return send(response, 401, { error: 'unauthorized' });"
ROUTE = '''
    if (request.method === 'POST' && url.pathname === '/float/v1') {
      return send(response, 200, await floatIntegration.dispatch(await body(request)));
    }
'''

def patched(source):
    rules = [("import { createServer }", IMPORT + "import { createServer }"),
             ('let cyclePromise = null;', 'let cyclePromise = null;\n' + INIT),
             ('async function runCycle() {', 'async function runCycle() {\n  await floatIntegration.apply();'),
             (AUTH, AUTH + ROUTE)]
    for old, new in rules:
        if source.count(old) != 1: raise RuntimeError('Upstream patch location mismatch')
        source = source.replace(old, new)
    return source

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True, help='Existing xinchao/src directory')
    parser.add_argument('action', choices=['check', 'apply', 'restore'])
    args = parser.parse_args()
    root = Path(args.source).resolve(); target = root / 'server.js'; backup = root / 'server.js.before-float-inner-v1'
    extension = root / 'float-integration.js'
    actual = target.read_bytes()
    original = backup.read_bytes() if backup.exists() else actual
    if blob(original) != CONTRACT['blobs']['server.js']: raise RuntimeError('Server source does not match pinned 4.3.0; request read-only source evidence')
    for name, expected in CONTRACT['blobs'].items():
        if name != 'server.js' and blob((root / name).read_bytes()) != expected: raise RuntimeError('Source mismatch: ' + name)
    expected = patched(original.decode('utf-8')).encode()
    installed = actual == expected and extension.exists() and extension.read_bytes() == (HERE / 'float-integration.js').read_bytes()
    if args.action == 'check':
        if actual not in (original, expected): raise RuntimeError('Unexpected local server changes; no overwrite')
        print(json.dumps(dict(contract='float-xinchao-inner/v1', installed=installed, filesVerified=len(CONTRACT['blobs'])))); return
    if args.action == 'restore':
        if not installed: raise RuntimeError('Extension differs; refuse blind restoration')
        target.write_bytes(original)
        print('Restored original server; all state/config/control/letter/box/personality files retained.'); return
    if installed: print('Already installed.'); return
    if actual != original or (extension.exists() and extension.read_bytes() != (HERE / 'float-integration.js').read_bytes()): raise RuntimeError('Unexpected local extension; refuse overwrite')
    if not backup.exists(): shutil.copyfile(target, backup)
    shutil.copyfile(HERE / 'float-integration.js', extension)
    target.write_bytes(expected)
    print('Installed verified extension. No service restart, timers, credentials or user-state migration performed.')

if __name__ == '__main__': main()
