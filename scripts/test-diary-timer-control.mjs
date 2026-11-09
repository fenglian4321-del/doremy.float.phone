import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const module = { exports: {} }, emitted = [], calls = [], entries = [], notices = [];
let settings, behavior;
const reset = () => { settings = { enabled: true, intervalHours: 24, characterIds: [], lastRunAtByCharacter: {} }; calls.length = 0; entries.length = 0; emitted.length = 0; behavior = undefined; };
const characters = [{ id: 'a', name: 'Synthetic A' }, { id: 'b', name: 'Synthetic B' }];
const window = new EventTarget(); window.dispatchEvent = event => { emitted.push(event.type); return EventTarget.prototype.dispatchEvent.call(window, event); };
class CustomEvent extends Event { constructor(type, options) { super(type); this.detail = options?.detail; notices.push(options?.detail); } }
const mocks = {
    './bg-timer': { bgSetInterval: () => () => {} }, './character-storage': { loadCharacters: () => characters },
    './diary-entry-engine': { generateDiaryEntryForCharacter: async (id, _entries, trigger, options) => { calls.push({ id, trigger, signal: options.signal }); assert.ok(settings.lastRunAtByCharacter[id], 'attempt reserved before model'); await behavior?.(id, options.signal); return { title: 'Synthetic diary', body: 'Synthetic content', blocks: [] }; } },
    './diary-entry-storage': { loadDiaryEntries: () => [], loadDiaryEntryTimerSettings: () => JSON.parse(JSON.stringify(settings)), saveDiaryEntryTimerSettings: value => { settings = value; }, createDiaryEntry: value => entries.push(value) },
};
const code = ts.transpileModule(readFileSync(new URL('../lib/diary-entry-timer-service.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
vm.runInNewContext(code, { module, exports: module.exports, require: name => { assert.ok(mocks[name], name); return mocks[name]; }, window, document: new EventTarget(), CustomEvent, AbortController, Date, console });
const runtime = module.exports;
reset(); settings.enabled = false; await runtime.runDiaryEntryTimerCheck(); assert.equal(calls.length, 0);
reset(); await runtime.runDiaryEntryTimerCheck(); assert.equal(calls.length, 2); assert.equal(entries.length, 2); await runtime.runDiaryEntryTimerCheck(); assert.equal(calls.length, 2);
reset(); behavior = async () => { settings.enabled = false; }; await runtime.runDiaryEntryTimerCheck(); assert.equal(calls.length, 1); assert.equal(entries.length, 0);
reset(); behavior = async () => { runtime.stopDiaryEntryTimerService(); }; await runtime.runDiaryEntryTimerCheck(); assert.equal(calls.length, 1); assert.equal(calls[0].signal.aborted, true); assert.equal(entries.length, 0);
reset(); behavior = async () => { throw Error('PRIVATE_PROVIDER_BODY'); }; await runtime.runDiaryEntryTimerCheck(); assert.equal(calls.length, 2); assert.equal(entries.length, 0); await runtime.runDiaryEntryTimerCheck(); assert.equal(calls.length, 2);
reset(); settings.characterIds = ['b']; await runtime.runDiaryEntryTimerCheck(); assert.deepEqual(calls.map(call => call.id), ['b']);
console.log('Diary timer: default-off, per-character reserve, interval, disable/stop during generation, no failure replay, and selected targets. No API requests.');
