import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
for (const [file, name] of [['chat-engine.ts', 'generateOfflineChatCompletion'], ['group-chat-engine.ts', 'generateGroupOfflineChatCompletion']]) {
    const source = ts.createSourceFile(file, readFileSync(new URL('../lib/' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration);
    const compiled = ts.transpileModule(declaration.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const [stream, retry, alwaysMissing, expected] of [[false, true, false, 2], [true, true, false, 2], [false, false, false, 1], [false, true, true, 3]]) {
        const module = { exports: {} }, calls = [];
        const model = { defaultModel: 'synthetic-selected-model' };
        const build = async () => ({ llmMessages: [{ role: 'system', content: 'synthetic-persona' }, { role: 'user', content: 'synthetic-user' }], character: { name: 'Synthetic' }, config: model, preset: null, regexes: [], userIdentity: { name: 'Synthetic user' } });
        const send = async (config, _preset, _messages, _regexes, _meta, options) => {
            assert.equal(config, model); calls.push(options.usageReason);
            return calls.length > 1 && !alwaysMissing ? '<summary>合成补提摘要</summary>' : '<content>合成正文</content>';
        };
        vm.runInNewContext(compiled, { module, exports: module.exports, buildChatPromptMessages: build, buildGroupChatPromptMessages: build,
            isSessionStreamingEnabled: () => stream, sendLLMRequest: send, sendLLMStreamRequest: async (...args) => ({ content: await send(...args) }),
            stripPresetTexts: value => value, parseOfflineResponse: raw => ({ content: '合成正文', summary: /<summary>(.*?)<\/summary>/.exec(raw)?.[1] || '' }), throwIfAborted() {},
        });
        await module.exports[name]({ id: 'synthetic-session', offlineSummaryRetry: retry }, [{ role: 'user', content: 'synthetic', sessionId: 'synthetic-session' }], { onStreamDelta() {} });
        assert.equal(calls.length, expected);
        assert.equal(calls[0], 'offline_reply'); assert.ok(calls.slice(1).every(reason => reason === 'offline_summary_retry'));
    }
}
console.log('Usage causes: actual private/group offline functions, JSON/SSE, existing 0/1/2 summary retry behavior and chosen-model reasons passed. No real API or extra runtime requests.');
