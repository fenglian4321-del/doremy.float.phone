import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { SharedMemoryError } from './shared-memory';
import { createXinchaoBridge, readXinchaoBridgeConfig, type XinchaoWake } from './xinchao-bridge';
import { emptyXinchaoProactiveSettings, validXinchaoProactiveSettings, xinchaoProactiveId, xinchaoProactiveQuiet, type XinchaoInboxItem, type XinchaoProactiveSettings } from '../xinchao-proactive-types';

type Config = { root: string; key: string; bridge?: NonNullable<ReturnType<typeof readXinchaoBridgeConfig>> };
type Envelope = { nonce: string; ciphertext: string; tag: string };
type Entry = XinchaoInboxItem & { envelope?: Envelope; claimHash?: string; claimVersion?: number; receiver?: string };
const fail = (code: string, message: string, status = 409): never => { throw new SharedMemoryError(code, message, status); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const absent = (error: unknown) => object(error) && error.code === 'ENOENT';
const delivery = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{5,159}$/.test(value);
export function readXinchaoProactiveInboxConfig(env: NodeJS.ProcessEnv = process.env, stateOnly = false): Config | null {
    if (!stateOnly && env.FLOAT_XINCHAO_PROACTIVE_ENABLED !== 'true') return null;
    const bridge = stateOnly ? undefined : readXinchaoBridgeConfig(env) ?? undefined;
    const root = env.FLOAT_XINCHAO_PROACTIVE_STATE_DIR, key = env.FLOAT_XINCHAO_PROACTIVE_LEDGER_KEY;
    if (stateOnly && !root && !key) return null;
    if (!root || !path.isAbsolute(root) || !key || key.length < 32 || key.length > 512 || [env.FLOAT_XINCHAO_BRIDGE_MACHINE_TOKEN, env.DYNAMIC_MIND_TOKEN, env.FLOAT_XINCHAO_FEEDBACK_LEDGER_KEY].includes(key)) return fail('xinchao_inbox_config', '主动收件箱需要独立私有目录和稳定密钥。', 503);
    return { root: path.resolve(root), key, bridge };
}
/** Durable encrypted wake inbox and single-use model claims. No model/native API. */
export function createXinchaoProactiveInbox(config: Config, origin: string, bridge = config.bridge ? createXinchaoBridge(config.bridge) : undefined) {
    const mac = (value: unknown) => createHmac('sha256', config.key).update(JSON.stringify(value)).digest('hex');
    const encryptionKey = createHmac('sha256', config.key).update('float-proactive-body-v1').digest();
    const file = (id: string) => { if (!delivery(id)) return fail('xinchao_inbox_input', '投递标识无效。', 400); return mac(['delivery', origin, id]) + '.json'; };
    async function read(name: string): Promise<unknown | null> {
        try { const bytes = await readFile(path.join(config.root, name)); if (bytes.length > 32768) throw Error(); return JSON.parse(bytes.toString('utf8')) as unknown; }
        catch (error) { if (absent(error)) return null; return fail('xinchao_inbox_state', '主动收件箱状态异常，未重新执行。', 503); }
    }
    async function write(name: string, value: unknown) {
        const destination = path.join(config.root, name), temporary = destination + '.' + randomUUID() + '.tmp';
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, destination);
        if (process.platform !== 'win32') { const directory = await open(config.root, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    }
    async function identity(create = false) {
        const value = await read('ledger.json'), keyTag = mac(['identity-v1', origin]);
        if (value !== null) { if (!object(value) || Object.keys(value).length !== 1 || value.keyTag !== keyTag) return fail('xinchao_inbox_state', '主动账本身份与密钥或来源不符。', 503); return; }
        let names: string[] = []; try { names = await readdir(config.root); } catch (error) { if (!absent(error)) throw error; }
        if (names.some(name => name.endsWith('.json'))) return fail('xinchao_inbox_state', '已有主动状态缺少账本身份，请先检查备份。', 503);
        if (create) await write('ledger.json', { keyTag });
    }
    async function lock<T>(callback: () => Promise<T>): Promise<T> {
        await mkdir(config.root, { recursive: true, mode: 0o700 });
        const deadline = Date.now() + 1000; let handle;
        while (!handle) { try { handle = await open(path.join(config.root, 'state.lock'), 'wx', 0o600); } catch (error) { if (!object(error) || error.code !== 'EEXIST' || Date.now() >= deadline) return fail('xinchao_inbox_busy', '主动收件箱正忙或需检查残留锁。'); await new Promise(resolve => setTimeout(resolve, 10)); } }
        try { await identity(true); return await callback(); } finally { await handle.close(); await unlink(path.join(config.root, 'state.lock')); }
    }
    async function settings() {
        await identity();
        const value = await read('settings.json');
        if (value === null) return emptyXinchaoProactiveSettings();
        if (!validXinchaoProactiveSettings(value)) return fail('xinchao_inbox_state', '主动设置状态异常，未触发动作。', 503);
        return value;
    }
    function validEntry(value: unknown): value is Entry {
        if (!object(value) || Object.keys(value).some(key => !['deliveryId', 'reason', 'state', 'receivedAt', 'expiresAt', 'policyVersion', 'ack', 'replyId', 'envelope', 'claimHash', 'claimVersion', 'receiver'].includes(key))
            || !delivery(value.deliveryId) || typeof value.reason !== 'string' || !['self_signal', 'user_interaction', 'user_note', 'scheduled_interaction', 'user_feedback', ''].includes(value.reason)
            || typeof value.state !== 'string' || !['receiving', 'pending', 'claimed', 'complete', 'ignored', 'expired', 'unavailable'].includes(value.state) || typeof value.ack !== 'string' || !['none', 'pending', 'confirmed', 'uncertain'].includes(value.ack)
            || !['receivedAt', 'expiresAt', 'policyVersion'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
            || (value.replyId !== undefined && !xinchaoProactiveId(value.replyId)) || (value.receiver !== undefined && !xinchaoProactiveId(value.receiver))
            || (value.claimHash !== undefined && (typeof value.claimHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.claimHash)))) return false;
        if (value.envelope !== undefined) {
            if (!object(value.envelope) || Object.keys(value.envelope).sort().join(',') !== 'ciphertext,nonce,tag' || typeof value.envelope.nonce !== 'string' || !/^[a-f0-9]{24}$/.test(value.envelope.nonce) || typeof value.envelope.tag !== 'string' || !/^[a-f0-9]{32}$/.test(value.envelope.tag) || typeof value.envelope.ciphertext !== 'string' || value.envelope.ciphertext.length > 24000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.envelope.ciphertext)) return false;
        }
        if (value.state === 'pending' && !value.envelope) return false;
        if (Number(value.expiresAt) <= Number(value.receivedAt) || Number(value.policyVersion) < 1) return false;
        if (value.state === 'receiving' && !value.receiver) return false;
        if (value.claimVersion !== undefined && (!Number.isSafeInteger(value.claimVersion) || Number(value.claimVersion) < 1)) return false;
        if (value.state === 'claimed' && (!value.claimHash || !value.claimVersion || value.envelope !== undefined)) return false;
        if (value.state === 'complete' && (!value.replyId || !value.claimHash || !value.claimVersion)) return false;
        if (['complete', 'ignored'].includes(value.state) ? value.ack === 'none' || value.envelope !== undefined : value.ack !== 'none') return false;
        return true;
    }
    async function entry(id: string): Promise<Entry | null> {
        const value = await read(file(id));
        if (value === null) return null;
        if (!validEntry(value) || value.deliveryId !== id) return fail('xinchao_inbox_state', '主动投递回执异常，未重新执行。', 503);
        return value;
    }
    function view(value: Entry, current: XinchaoProactiveSettings): XinchaoInboxItem {
        const { deliveryId, reason, receivedAt, expiresAt, policyVersion, ack, replyId } = value;
        const state = value.state === 'pending' && (expiresAt <= Date.now() || policyVersion !== current.epoch) ? 'expired' : value.state;
        return { deliveryId, reason, receivedAt, expiresAt, policyVersion, ack, state, ...(replyId ? { replyId } : {}) };
    }
    const aad = (value: Entry, current: XinchaoProactiveSettings) => Buffer.from(JSON.stringify([origin, value.deliveryId, value.policyVersion, current.sessionId, current.characterId]));
    function seal(wake: XinchaoWake, value: Entry, current: XinchaoProactiveSettings): Envelope {
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce); cipher.setAAD(aad(value, current));
        return { nonce: nonce.toString('hex'), ciphertext: Buffer.concat([cipher.update(wake.message, 'utf8'), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('hex') };
    }
    function unseal(value: Entry, current: XinchaoProactiveSettings) {
        try { const body = value.envelope!; const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(body.nonce, 'hex')); decipher.setAAD(aad(value, current)); decipher.setAuthTag(Buffer.from(body.tag, 'hex')); return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([decipher.update(Buffer.from(body.ciphertext, 'base64')), decipher.final()])); }
        catch { return fail('xinchao_inbox_state', '主动资料无法验证，未请求模型。', 503); }
    }
    async function acknowledge(id: string) {
        const previous = await entry(id);
        if (previous?.ack === 'confirmed') return view(previous, await settings());
        let acknowledged = false;
        try { if (!bridge) throw Error(); await bridge.acknowledge(id); acknowledged = true; } catch { /* terminal receipt remains; never re-run model */ }
        return lock(async () => { const value = await entry(id); if (!value || !['complete', 'ignored'].includes(value.state)) return fail('xinchao_inbox_state', '原完成回执缺失。', 503); value.ack = acknowledged ? 'confirmed' : 'uncertain'; await write(file(id), value); return view(value, await settings()); });
    }
    return {
        settings,
        async configure(next: XinchaoProactiveSettings) {
            if (!validXinchaoProactiveSettings(next)) return fail('xinchao_inbox_input', '主动设置无效；需明确绑定和独立选项。', 400);
            return lock(async () => {
                const current = await settings();
                if (next.enabled && next.version !== current.version) return fail('xinchao_inbox_conflict', '主动设置已变化，请刷新后明确开启。');
                const value = { ...(!next.enabled && next.version !== current.version ? current : next), version: current.version + 1, ...(!next.enabled ? { enabled: false, autoReply: false, offlineNotify: false } : {}) };
                const epoch = current.epoch + Number(value.enabled !== current.enabled || value.sessionId !== current.sessionId || value.characterId !== current.characterId);
                const saved = { ...value, epoch }; await write('settings.json', saved); return saved;
            });
        },
        async receive(id: string, signal?: AbortSignal) {
            const receiver = randomUUID();
            const reservation = await lock(async () => {
                signal?.throwIfAborted(); const current = await settings();
                if (!current.enabled) return fail('xinchao_inbox_disabled', '主动接收未开启，未连接投递材料。');
                const old = await entry(id); if (old) return { current, value: old, fresh: false };
                if ((await readdir(config.root)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length >= 4096) return fail('xinchao_inbox_capacity', '主动回执已满，未自动裁剪或重放。', 503);
                const value: Entry = { deliveryId: id, reason: '', state: 'receiving', receivedAt: Date.now(), expiresAt: Date.now() + 3600000, policyVersion: current.epoch, ack: 'none', receiver };
                await write(file(id), value); return { current, value, fresh: true };
            });
            if (!reservation.fresh) return view(reservation.value, reservation.current);
            let wake: XinchaoWake | undefined; try { if (!bridge) throw Error(); wake = await bridge.pull(id, signal); } catch { /* no model or ack */ }
            return lock(async () => {
                const current = await settings(), value = await entry(id);
                if (!value || value.receiver !== receiver || value.state !== 'receiving') return fail('xinchao_inbox_conflict', '原接收回执已变化。');
                delete value.receiver;
                if (!current.enabled || current.epoch !== reservation.current.epoch || value.expiresAt <= Date.now() || signal?.aborted) value.state = 'expired';
                else if (!wake) value.state = 'unavailable';
                else { value.reason = wake.reason; value.envelope = seal(wake, value, current); value.state = 'pending'; }
                await write(file(id), value); return view(value, current);
            });
        },
        async list() {
            const current = await settings(); let names: string[] = []; try { names = await readdir(config.root); } catch (error) { if (!absent(error)) throw error; }
            const result: XinchaoInboxItem[] = [];
            for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) { const value = await read(name); if (!validEntry(value) || file(value.deliveryId) !== name) return fail('xinchao_inbox_state', '主动回执清单异常。', 503); result.push(view(value, current)); }
            return result.sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 64);
        },
        async claim(id: string, claim: string, version: number, automatic = false) {
            if (!xinchaoProactiveId(claim)) return fail('xinchao_inbox_input', '领取标识无效。', 400);
            const prepared = await lock(async () => {
                const current = await settings(), value = await entry(id);
                if (!value || !current.enabled || version !== current.version || value.policyVersion !== current.epoch || value.expiresAt <= Date.now()) return fail('xinchao_inbox_conflict', '主动绑定、时效或设置已变化，未请求模型。');
                if (value.state !== 'pending') return { replayed: true as const, item: view(value, current) };
                const last = await read('activity.json');
                if (last !== null && (!object(last) || Object.keys(last).length !== 1 || !Number.isSafeInteger(last.at) || Number(last.at) < 0)) return fail('xinchao_inbox_state', '主动限频状态异常。', 503);
                if (automatic && (!current.autoReply || xinchaoProactiveQuiet(current) || (object(last) && Date.now() - Number(last.at) < current.cooldownMinutes * 60000))) return fail('xinchao_inbox_quiet', '当前未允许自动回复或处于安静/冷却时段。');
                const message = unseal(value, current);
                value.claimHash = mac(['claim', id, claim]); value.claimVersion = current.version; value.state = 'claimed'; delete value.envelope;
                await write(file(id), value); await write('activity.json', { at: Date.now() });
                return { replayed: false as const, item: view(value, current), message, sessionId: current.sessionId, characterId: current.characterId };
            });
            if (prepared.replayed) return prepared;
            // Recheck upstream pending/TTL without holding the settings lock.
            // The durable claim is already consumed: a lost response/failure
            // cannot start a second model from the same delivery.
            if (!bridge) return fail('xinchao_inbox_disabled', '主动桥不可用，未请求模型。');
            const upstream = await bridge.pull(id);
            const current = await settings(), value = await entry(id);
            if (!value || !current.enabled || current.version !== version || value.state !== 'claimed' || value.claimHash !== mac(['claim', id, claim]) || value.expiresAt <= Date.now() || upstream.message !== prepared.message || upstream.reason !== value.reason || (automatic && (!current.autoReply || xinchaoProactiveQuiet(current)))) return fail('xinchao_inbox_claim', '投递、绑定或安静时段已变化，未请求模型；不自动重放领取。');
            return prepared;
        },
        async finish(id: string, claim: string, replyId: string) {
            if (!xinchaoProactiveId(replyId) || !xinchaoProactiveId(claim)) return fail('xinchao_inbox_input', '回复标识无效。', 400);
            await lock(async () => {
                const current = await settings(), value = await entry(id);
                if (!value || value.claimHash !== mac(['claim', id, claim]) || !['claimed', 'complete'].includes(value.state)) return fail('xinchao_inbox_claim', '原主动领取回执不匹配。');
                if (value.state === 'complete') { if (value.replyId !== replyId) return fail('xinchao_inbox_conflict', '原回复已保存，不能换回复重做。'); return; }
                if (!current.enabled || current.version !== value.claimVersion) return fail('xinchao_inbox_conflict', '主动设置已变化，不追加旧轮回复。');
                value.state = 'complete'; value.replyId = replyId; value.ack = 'pending'; delete value.envelope;
                await write(file(id), value);
            });
            return acknowledge(id);
        },
        async verifyClaim(id: string, claim: string, version: number) {
            const current = await settings(), value = await entry(id);
            if (!xinchaoProactiveId(claim) || !value || !current.enabled || current.version !== version || value.claimVersion !== version || value.policyVersion !== current.epoch || value.state !== 'claimed' || value.expiresAt <= Date.now() || value.claimHash !== mac(['claim', id, claim])) return fail('xinchao_inbox_claim', '主动领取已停止、过期或设置变化，不能继续请求模型或保存旧结果。');
            return { sessionId: current.sessionId, characterId: current.characterId };
        },
        async dismiss(id: string) {
            await lock(async () => { const value = await entry(id); if (!value || value.state === 'complete') return fail('xinchao_inbox_conflict', '投递不存在或已有完成回复。'); value.state = 'ignored'; value.ack = 'pending'; delete value.envelope; delete value.receiver; await write(file(id), value); });
            return acknowledge(id);
        },
    };
}
