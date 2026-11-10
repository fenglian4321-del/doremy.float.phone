// Installed beside the verified 4.3.0 server, never a second engine or scheduler.
import { StateStore } from './state-store.js';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
const PROTOCOL = 'float-xinchao-inner/v1';
const MODULES = ['state', 'body', 'jars', 'thoughts', 'blackbox', 'cabin', 'core', 'timeline'];
const oid = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (code, status = 400) => {
    const e = new Error(code);
    e.status = status;
    throw e;
};
const exact = (v, keys) => {
    if (!obj(v) || Object.keys(v).sort().join() !== [...keys].sort().join()) fail('invalid_request');
};
const text = (v, max = 1000) => (typeof v === 'string' ? v.slice(0, max) : '');
const number = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export function createFloatIntegration(d) {
    const { config, model, dreamModel } = d;
    const base = {
        model: config.model.enabled,
        dream: config.dreamEnabled,
        daytime: config.daytime.enabled,
        jar: config.bridge.drivePoolEnabled,
        bark: config.bark.enabled,
        dreamModel: dreamModel.config.enabled,
    };
    const controlStore = new StateStore(
        join(dirname(config.statePath), 'float-inner-controls-v1.json'),
        () => ({
            version: 1,
            revision: 0,
            generation: 'inherit',
            jarGeneration: 'inherit',
            binding: null,
            previousBindings: [],
            receipts: {},
        }),
    );
    let queue = Promise.resolve();
    const secretValues = [
        config.serviceToken,
        config.model.apiKey,
        dreamModel.config.apiKey,
        config.bridge.machineToken,
    ].filter((v) => typeof v === 'string' && v.length >= 16);
    const clean = (v, max = 1000) => {
        let s = text(v, max);
        for (const secret of secretValues) s = s.replaceAll(secret, '[隐藏凭据]');
        return s;
    };
    function validate(s) {
        if (
            !obj(s) ||
            s.version !== 1 ||
            !Number.isSafeInteger(s.revision) ||
            s.revision < 0 ||
            !['inherit', 'paused'].includes(s.generation) ||
            !['inherit', 'paused'].includes(s.jarGeneration) ||
            !obj(s.receipts) ||
            !Array.isArray(s.previousBindings)
        )
            fail('control_state_invalid', 503);
        if (
            s.binding !== null &&
            (!obj(s.binding) ||
                !oid(s.binding.characterId) ||
                !/^[a-f0-9]{64}$/.test(s.binding.coreHash) ||
                !text(s.binding.name, 80))
        )
            fail('control_state_invalid', 503);
        return s;
    }
    async function apply() {
        const s = validate(await controlStore.read()),
            active = s.generation !== 'paused';
        // Only restore already-configured capabilities. Never enable absent keys/models.
        config.model.enabled = base.model && active;
        model.config.enabled = base.model && active;
        dreamModel.config.enabled = base.dreamModel && active;
        config.dreamEnabled = base.dream && active;
        config.daytime.enabled = base.daytime && active;
        config.bridge.drivePoolEnabled = base.jar && active && s.jarGeneration !== 'paused';
        config.bark.enabled = base.bark && active;
        return s;
    }
    const ready = apply();
    // Fence every existing model request, including a fallback inside a cycle.
    // In-flight HTTP requests may finish; pausing prevents subsequent requests.
    for (const client of new Set([model, dreamModel])) {
        const request = client.request.bind(client);
        client.request = async (...args) => {
            const s = await apply();
            if (s.generation === 'paused') fail('generation_paused', 409);
            return request(...args);
        };
    }
    const controls = (s) => ({
        revision: s.revision,
        generation: s.generation,
        jarGeneration: s.jarGeneration,
        binding: s.binding ? { ...s.binding, name: clean(s.binding.name, 80) } : null,
        cycleMinutes: config.settleIntervalMinutes,
        modelConfigured: !!(base.model && config.model.apiKey),
        toolsConfigured: !!config.mcp.enabled,
        jarConfigured: !!(base.jar && base.model && config.model.apiKey),
        privateText: !!config.dashboard.includePrivateText,
        shadow: !!config.shadowMode,
    });
    const rec = (id, title, content = '', meta = '', at = '') => ({
        id: clean(String(id), 120),
        title: clean(title, 160),
        text: clean(content, 8000),
        meta: clean(meta, 200),
        ...(at ? { at: clean(at, 40) } : {}),
    });
    async function read(module) {
        if (!MODULES.includes(module)) fail('invalid_module');
        const settings = await apply(),
            doc = {
                module,
                status: 'available',
                at: new Date().toISOString(),
                summary: '',
                metrics: [],
                records: [],
                controls: controls(settings),
            };
        const metric = (key, label, value, unit = '') => {
            if (typeof value === 'number' && Number.isFinite(value))
                doc.metrics.push({ key, label, value, unit });
        };
        if (module === 'blackbox') {
            doc.status = 'restricted';
            doc.summary =
                '原版黑匣子仅AI工具可读，不向人类看板提供列表或正文。本页不绕过限制；可在明确绑定的生活私聊允许角色按需使用。模型可自行决定是否在回复中告诉你；浏览器模型请求本身不构成对设备所有者的加密隔离。';
            return doc;
        }
        if (module === 'cabin') {
            const cabin = await d.cabin.snapshot();
            doc.summary =
                '同一小屋持久信箱。上锁来信不交给角色，查看不会标记已读或自动唤醒模型；手记与任务文件仍独立保存。';
            metric('unread', '未读来信', cabin.unreadAiNotes);
            doc.records = cabin.notes
                .slice(0, 100)
                .map((n) => ({
                    ...rec(
                        n.id,
                        n.from === 'ai' ? 'TA的来信' : '我的信',
                        n.content,
                        n.locked ? '尚未允许AI阅读' : '允许AI按需阅读',
                        n.createdAt,
                    ),
                    locked: !!n.locked,
                    from: n.from,
                    read: !!n.readAt,
                }));
            return doc;
        }
        if (module === 'body') {
            doc.summary = '模拟身体与脉，不是人的生理测量。临时偏移只存心潮内存、到期失效，不进长期记忆。';
            if (!config.pulse.enabled) {
                doc.status = 'disabled';
                return doc;
            }
            const v = d.vitals(await d.store.read());
            metric('hr', '模拟心率', v.hr, '次/分');
            metric('breath', '模拟呼吸', v.breath, '次/分');
            doc.records = [rec('pulse', v.heart, v.breathing, '', v.at)];
            return doc;
        }
        if (module === 'jars') {
            const jar = await d.drivePool.read();
            doc.summary =
                '同一念头罐缓存：读取不抽取、不续罐、不调用模型。手动续罐会请求服务端已配置模型；原版不足时的后台续罐只使用现有运行周期。';
            doc.status = base.jar ? 'available' : 'disabled';
            for (const key of d.driveKeys) {
                const pools = Object.entries(jar.pools).filter(
                    ([id, rows]) => id.startsWith(key + '|') && Array.isArray(rows),
                );
                metric(
                    key,
                    d.driveNames[key] || key,
                    pools.reduce((n, [, rows]) => n + rows.length, 0),
                    '句',
                );
                const recent = Array.isArray(jar.recent[key]) ? jar.recent[key].slice(-3) : [];
                recent.forEach((line, i) =>
                    doc.records.push(
                        rec(key + '-recent-' + i, (d.driveNames[key] || key) + ' · 最近抽出', line),
                    ),
                );
                if (config.dashboard.includePrivateText)
                    for (const [id, rows] of pools)
                        rows.slice(-15).forEach((v, i) =>
                            doc.records.push(
                                rec(
                                    id + '-' + i,
                                    (d.driveNames[key] || key) + ' · ' + id.split('|')[1],
                                    v.text,
                                    v.mood,
                                    v.at,
                                ),
                            ),
                        );
            }
            if (!config.dashboard.includePrivateText)
                doc.summary += ' 完整罐内文字受服务端私密文字开关控制，目前仅提供数量和已公开的最近抽取句。';
            doc.records = doc.records.slice(0, 180);
            return doc;
        }
        if (module === 'timeline') {
            const rows = await d.journal.list({ limit: 80 });
            doc.summary = '心潮既有状态变化日志；不复制聊天正文，不另建事件库。';
            doc.records = rows
                .slice(0, 80)
                .map((r) =>
                    rec(
                        r.id,
                        r.type,
                        '',
                        `来源 ${r.source} · 状态版本 ${r.revisionBefore ?? '?'} → ${r.revisionAfter ?? '?'}`,
                        r.at,
                    ),
                );
            return doc;
        }
        const snap = await d.snapshot();
        if (module === 'state') {
            doc.summary = '心潮实时动态层；完整驱力与情绪不覆盖你固定的人设，也不证明现实事件或关系。';
            metric('valence', '情绪愉悦', snap.emotion.valence, '比例');
            metric('arousal', '情绪唤醒', snap.emotion.arousal, '比例');
            metric('fatigue', '疲劳', snap.runtime.fatigue, '比例');
            doc.records.push(
                rec(
                    'consciousness',
                    snap.runtime.consciousness,
                    snap.emotion.shown || snap.emotion.label,
                    config.shadowMode ? '服务处于shadow模式' : '服务处于active模式',
                ),
            );
            for (const drive of snap.drives) {
                metric(drive.key, drive.short || drive.label, drive.value, '比例');
                doc.records.push(
                    rec(
                        'drive-' + drive.key,
                        drive.short || drive.label,
                        drive.sub || '',
                        [drive.trend, drive.satiety ? '饱足至 ' + drive.satiety.until : '']
                            .filter(Boolean)
                            .join(' · '),
                    ),
                );
            }
            return doc;
        }
        if (module === 'thoughts') {
            doc.summary =
                '同一思绪池中的闪念/执念及梦境材料，是模拟内部状态，不自动升格为现实事实或整段写入长期记忆。';
            metric('flash', '闪念', snap.thoughts.flashCount);
            metric('obsession', '执念', snap.thoughts.obsessionCount);
            doc.records = snap.thoughts.lines.map((r, i) =>
                rec(
                    'thought-' + i,
                    `${d.driveNames[r.key] || r.key} · ${r.kind}`,
                    r.text,
                    '强度 ' + r.intensity,
                ),
            );
            for (const dream of snap.dreams)
                doc.records.push(
                    rec(
                        dream.id || 'dream-' + doc.records.length,
                        '梦境 · 模拟材料',
                        dream.dream || '',
                        dream.hasDream && !dream.dream ? '服务端未允许私密正文' : dream.summary || '',
                        dream.createdAt,
                    ),
                );
            if (!config.dashboard.includePrivateText)
                doc.summary += ' 服务端未允许私密文字，当前显示实际数量和梦境元数据，不伪造正文。';
            return doc;
        }
        doc.summary =
            '固定核心以你选定的Float角色卡为权威；心潮14维月度自评是可变状态，锚点是行为底线。动态状态、梦境、外部工具结果均不能自动改写角色卡。冲突时保留双方数据，由你明确修改或重新绑定。';
        for (const r of snap.personality.dimensions) metric(r.key, r.label, r.score, '分');
        doc.records = snap.personality.anchors.map((r) =>
            rec(r.key, r.label, r.description || '', '行为锚点', r.addedAt),
        );
        doc.records.unshift(
            rec(
                'identity',
                '心潮服务身份',
                snap.identity.agentName,
                settings.binding && settings.binding.name !== snap.identity.agentName
                    ? '名称与固定角色不一致；请核对服务端身份配置，不会自动改名'
                    : '动态状态来源身份',
            ),
        );
        return doc;
    }
    function input(action) {
        const fields = {
            bind: ['action', 'binding', 'confirm'],
            controls: ['action', 'generation', 'jarGeneration', 'confirm'],
            letter: ['action', 'content', 'locked'],
            letter_lock: ['action', 'id', 'locked'],
            letter_read: ['action', 'id'],
            body_offset: ['action', 'hr', 'breath', 'minutes'],
            satisfy: ['action', 'drive'],
            refill: ['action', 'drive', 'confirm'],
            anchor_add: ['action', 'label', 'description', 'confirm'],
            anchor_remove: ['action', 'key', 'confirm'],
        };
        if (!Object.hasOwn(fields, action?.action)) fail('invalid_action');
        exact(action, fields[action.action]);
        if ('confirm' in action && action.confirm !== true) fail('confirmation_required');
        if (['satisfy', 'refill'].includes(action.action) && !d.driveKeys.includes(action.drive))
            fail('invalid_drive');
        if (action.action === 'bind') {
            exact(action.binding, ['characterId', 'coreHash', 'name']);
            if (
                !oid(action.binding.characterId) ||
                !/^[a-f0-9]{64}$/.test(action.binding.coreHash) ||
                typeof action.binding.name !== 'string' ||
                !action.binding.name.trim() ||
                action.binding.name.length > 80
            )
                fail('invalid_binding');
        }
        if (
            action.action === 'controls' &&
            (!['inherit', 'paused'].includes(action.generation) ||
                !['inherit', 'paused'].includes(action.jarGeneration))
        )
            fail('invalid_controls');
        if (['letter', 'letter_lock'].includes(action.action) && typeof action.locked !== 'boolean')
            fail('invalid_letter');
        if (
            action.action === 'letter' &&
            (typeof action.content !== 'string' || !action.content.trim() || action.content.length > 8000)
        )
            fail('invalid_letter');
        if (
            ['letter_lock', 'letter_read'].includes(action.action) &&
            (!text(action.id) || action.id.length > 100)
        )
            fail('invalid_id');
        if (
            action.action === 'body_offset' &&
            (!number(action.hr, -40, 80) ||
                !number(action.breath, -10, 20) ||
                !number(action.minutes, 1, 180))
        )
            fail('invalid_body');
        if (
            action.action === 'anchor_add' &&
            (typeof action.label !== 'string' ||
                !action.label.trim() ||
                action.label.length > 40 ||
                typeof action.description !== 'string' ||
                action.description.length > 300)
        )
            fail('invalid_anchor');
        if (action.action === 'anchor_remove' && (!text(action.key) || action.key.length > 60))
            fail('invalid_anchor');
    }
    async function mutate(b) {
        exact(b, ['operation', 'requestId', 'revision', 'input']);
        if (!oid(b.requestId) || !Number.isSafeInteger(b.revision)) fail('invalid_request');
        input(b.input);
        const fingerprint = createHash('sha256').update(JSON.stringify(b.input)).digest('hex');
        let s = validate(await controlStore.read());
        const old = s.receipts[b.requestId];
        if (old) {
            if (old.fingerprint !== fingerprint) fail('request_conflict', 409);
            return { state: old.state, replayed: true, requestId: b.requestId, controls: controls(s) };
        }
        if (b.revision !== s.revision) fail('revision_conflict', 409);
        const entries = Object.entries(s.receipts);
        if (entries.length >= 512) {
            for (const [id] of entries.filter(([, r]) => r.state === 'complete').slice(0, 384))
                delete s.receipts[id];
        }
        if (Object.keys(s.receipts).length >= 512) fail('receipt_capacity', 409);
        s.receipts[b.requestId] = { fingerprint, state: 'uncertain', at: new Date().toISOString() };
        await controlStore.write(s);
        const a = b.input;
        if (a.action === 'bind') {
            if (s.binding) s.previousBindings = [...s.previousBindings, s.binding].slice(-20);
            s.binding = { ...a.binding };
        }
        if (a.action === 'controls') {
            s.generation = a.generation;
            s.jarGeneration = a.jarGeneration;
        }
        if (a.action === 'letter')
            await d.cabin.addNote({
                eventId: 'float:' + b.requestId,
                from: 'user',
                content: a.content,
                locked: a.locked,
            });
        if (a.action === 'letter_lock' && !(await d.cabin.setNoteLock(a.id, a.locked)))
            fail('letter_missing', 404);
        if (a.action === 'letter_read') await d.cabin.markAiNotesRead([a.id]);
        if (a.action === 'body_offset') {
            if (!config.pulse.enabled) fail('body_disabled', 409);
            d.offset({ key: 'float:' + b.requestId, hr: a.hr, breath: a.breath, minutes: a.minutes });
        }
        if (a.action === 'satisfy') await d.satisfy(a.drive, 'float:' + b.requestId);
        if (a.action === 'refill') {
            if (
                s.generation === 'paused' ||
                s.jarGeneration === 'paused' ||
                !base.jar ||
                !base.model ||
                !config.model.apiKey
            )
                fail('generation_disabled', 409);
            await d.refill(a.drive);
        }
        if (a.action === 'anchor_add')
            await d.personality.updateAnchors({
                action: 'add',
                anchor: { label: a.label, description: a.description },
            });
        if (a.action === 'anchor_remove') await d.personality.updateAnchors({ action: 'remove', key: a.key });
        s.revision++;
        s.receipts[b.requestId].state = 'complete';
        await controlStore.write(s);
        await apply();
        return { state: 'complete', requestId: b.requestId, replayed: false, controls: controls(s) };
    }
    async function dispatch(b) {
        await ready;
        if (b?.operation === 'read') {
            exact(b, ['operation', 'module']);
            return { protocol: PROTOCOL, document: await read(b.module) };
        }
        if (b?.operation === 'receipt') {
            exact(b, ['operation', 'requestId']);
            if (!oid(b.requestId)) fail('invalid_request');
            const s = validate(await controlStore.read()),
                r = s.receipts[b.requestId];
            return { protocol: PROTOCOL, requestId: b.requestId, state: r?.state || 'missing' };
        }
        if (b?.operation === 'ai_reserve' || b?.operation === 'ai_complete') {
            exact(b, ['operation', 'requestId', 'context', 'tool', 'fingerprint']);
            exact(b.context, ['sessionId', 'characterId', 'coreHash']);
            if (
                !oid(b.requestId) ||
                !oid(b.context.sessionId) ||
                !oid(b.context.characterId) ||
                !/^[a-f0-9]{64}$/.test(b.fingerprint) ||
                ![
                    'box_list',
                    'box_read',
                    'box_put',
                    'box_unpin',
                    'box_burn',
                    'cabin_inbox',
                    'cabin_note',
                ].includes(b.tool)
            )
                fail('invalid_ai_request');
            const job = queue.then(async () => {
                const s = validate(await controlStore.read());
                if (
                    !s.binding ||
                    s.binding.characterId !== b.context.characterId ||
                    s.binding.coreHash !== b.context.coreHash
                )
                    fail('binding_changed', 409);
                const fingerprint = createHash('sha256')
                        .update(JSON.stringify([b.context, b.tool, b.fingerprint]))
                        .digest('hex'),
                    old = s.receipts[b.requestId];
                if (old && old.fingerprint !== fingerprint) fail('request_conflict', 409);
                if (b.operation === 'ai_complete') {
                    if (!old) fail('receipt_missing', 409);
                    old.state = 'complete';
                    await controlStore.write(s);
                    return { protocol: PROTOCOL, state: 'complete', requestId: b.requestId };
                }
                if (old)
                    return { protocol: PROTOCOL, state: old.state, replayed: true, requestId: b.requestId };
                const entries = Object.entries(s.receipts);
                if (entries.length >= 512)
                    for (const [id] of entries.filter(([, r]) => r.state === 'complete').slice(0, 384))
                        delete s.receipts[id];
                if (Object.keys(s.receipts).length >= 512) fail('receipt_capacity', 409);
                s.receipts[b.requestId] = { fingerprint, state: 'uncertain', at: new Date().toISOString() };
                await controlStore.write(s);
                return { protocol: PROTOCOL, state: 'reserved', replayed: false, requestId: b.requestId };
            });
            queue = job.catch(() => {});
            return job;
        }
        if (b?.operation !== 'mutate') fail('invalid_operation');
        const job = queue.then(() => mutate(b));
        queue = job.catch(() => {});
        return { protocol: PROTOCOL, ...(await job) };
    }
    return { ready, apply, dispatch, binding: async () => validate(await controlStore.read()).binding };
}
