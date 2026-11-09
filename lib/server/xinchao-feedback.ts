import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { SharedMemoryError } from './shared-memory';
import { readXinchaoConfig, recordXinchaoPresence } from './xinchao';

export type XinchaoFeedbackTurn = { sessionId: string; characterId: string; messageId: string; createdAt: string };
type Receipt = { state: 'reserved' | 'recorded' | 'uncertain' | 'rate_limited'; at: number; revision?: number };
type Config = { root: string; key: string };
const fail = (code: string, message: string, status = 409): never => { throw new SharedMemoryError(code, message, status); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function xinchaoFeedbackTurn(value: unknown): asserts value is XinchaoFeedbackTurn {
    if (!object(value) || Object.keys(value).sort().join(',') !== 'characterId,createdAt,messageId,sessionId'
        || !['sessionId', 'characterId', 'messageId'].every(key => typeof value[key] === 'string' && /^[^\x00-\x20\x7f]{1,160}$/.test(value[key] as string))
        || typeof value.createdAt !== 'string' || value.createdAt.length > 40 || !Number.isFinite(Date.parse(value.createdAt))) fail('xinchao_feedback_input', '反馈只接受明确生活私聊的新消息标识。', 400);
}
export function readXinchaoFeedbackConfig(env: NodeJS.ProcessEnv = process.env): Config | null {
    if (env.FLOAT_XINCHAO_FEEDBACK_ENABLED !== 'true') return null;
    const root = env.FLOAT_XINCHAO_FEEDBACK_STATE_DIR, key = env.FLOAT_XINCHAO_FEEDBACK_LEDGER_KEY;
    if (!root || !path.isAbsolute(root) || !key || key.length < 32 || key.length > 512 || key === env.DYNAMIC_MIND_TOKEN) return fail('xinchao_feedback_config', '对话反馈需要独立私有回执目录和密钥。', 503);
    return { root: path.resolve(root), key };
}
const missing = (error: unknown) => object(error) && error.code === 'ENOENT';
/** Metadata only. Reserve durably before the one fixed outbound presence POST. */
export function createXinchaoFeedback(config: Config, origin: string, send: typeof recordXinchaoPresence = recordXinchaoPresence) {
    const mac = (value: unknown) => createHmac('sha256', config.key).update(JSON.stringify(value)).digest('hex');
    async function read(file: string): Promise<Receipt | null> {
        try {
            const bytes = await readFile(file);
            if (bytes.length > 1024) throw Error();
            const value: unknown = JSON.parse(bytes.toString('utf8'));
            if (!object(value) || Object.keys(value).some(key => !['state', 'at', 'revision'].includes(key)) || typeof value.state !== 'string' || !['reserved', 'recorded', 'uncertain', 'rate_limited'].includes(value.state) || !Number.isSafeInteger(value.at) || Number(value.at) < 0 || (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0))) throw Error();
            if (value.state === 'recorded' && value.revision === undefined) throw Error();
            return value as Receipt;
        } catch (error) { if (missing(error)) return null; return fail('xinchao_feedback_state', '反馈回执异常，未重新发送。', 503); }
    }
    async function atomic(file: string, value: unknown) {
        const temporary = file + '.' + randomUUID() + '.tmp', handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, file);
        if (process.platform !== 'win32') { const directory = await open(config.root, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    }
    async function identity(create: boolean) {
        const file = path.join(config.root, 'ledger.json'), expected = mac(['ledger-v1', origin]);
        try {
            const bytes = await readFile(file);
            if (bytes.length > 256 || bytes.toString('utf8') !== JSON.stringify({ keyTag: expected })) throw Error();
            return true;
        } catch (error) {
            if (!missing(error)) return fail('xinchao_feedback_state', '反馈密钥、来源或账本身份不匹配，未重新发送。', 503);
            let names: string[] = []; try { names = await readdir(config.root); } catch (error) { if (!missing(error)) throw error; }
            if (names.some(name => /^[a-f0-9]{64}\.json$/.test(name))) return fail('xinchao_feedback_state', '已有反馈回执缺少账本身份，需先检查备份。', 503);
            if (!create) return false;
            await atomic(file, { keyTag: expected });
            return true;
        }
    }
    async function lock<T>(callback: () => Promise<T>): Promise<T> {
        await mkdir(config.root, { recursive: true, mode: 0o700 });
        let handle; const deadline = Date.now() + 500;
        while (!handle) {
            try { handle = await open(path.join(config.root, 'state.lock'), 'wx', 0o600); }
            catch (error) { if (!object(error) || error.code !== 'EEXIST' || Date.now() >= deadline) return fail('xinchao_feedback_busy', '反馈正忙或需检查回执锁，未重复发送。'); await new Promise(resolve => setTimeout(resolve, 10)); }
        }
        try { return await callback(); } finally { await handle.close(); await unlink(path.join(config.root, 'state.lock')); }
    }
    return async (operation: 'record' | 'status', turn: XinchaoFeedbackTurn, signal?: AbortSignal) => {
        xinchaoFeedbackTurn(turn);
        const eventId = mac(['presence-v1', origin, turn.sessionId, turn.characterId, turn.messageId]);
        const file = path.join(config.root, eventId + '.json');
        if (operation === 'status') return { receipt: await identity(false) ? await read(file) : null };
        const now = Date.now(), messageAt = Date.parse(turn.createdAt);
        if (messageAt > now + 60000 || now - messageAt > 600000) return fail('xinchao_feedback_old', '消息不在新对话反馈时段，未补报历史。');
        const service = readXinchaoConfig(); // validate all fixed service config before reserving
        const reserved = await lock(async () => {
            signal?.throwIfAborted();
            await identity(true);
            const old = await read(file);
            if (old) return { replayed: true, receipt: old };
            const names = (await readdir(config.root)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
            if (names.length >= 4096) return fail('xinchao_feedback_capacity', '反馈回执已满，未自动删除或重新发送。', 503);
            const last = await read(path.join(config.root, 'last.json'));
            const receipt: Receipt = { state: last && now - last.at < 20000 ? 'rate_limited' : 'reserved', at: now };
            await atomic(file, receipt);
            if (receipt.state === 'reserved') await atomic(path.join(config.root, 'last.json'), receipt);
            return { replayed: false, receipt };
        });
        if (reserved.replayed || reserved.receipt.state !== 'reserved') return reserved;
        let receipt: Receipt;
        try {
            signal?.throwIfAborted();
            const result = await send(service, 'float:' + eventId, 'float:' + mac(['session', origin, turn.sessionId, turn.characterId]), signal);
            receipt = { state: 'recorded', at: now, revision: result.revision };
        } catch { receipt = { state: 'uncertain', at: now }; }
        // External success followed by a local write failure stays reserved and
        // is not resent. A restart/status read never calls the remote service.
        await lock(() => atomic(file, receipt));
        return { replayed: false, receipt };
    };
}
