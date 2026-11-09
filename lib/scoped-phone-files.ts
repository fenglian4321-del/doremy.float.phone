import { kvGet, kvSet, kvRemove, registerDynamicPrefix } from './kv-db';
import { isShellEnvironment } from './shell-detect';
export type PhoneFileScope = { mode: 'work' | 'private'; workspaceId: string };
export type PhoneGrant = { id: string; label: string; readable: boolean; writable: boolean };
export type PhoneFile = { name: string; directory: boolean; bytes: number | null };
export type PhoneFileResult = { grant?: PhoneGrant; grants?: PhoneGrant[]; files?: PhoneFile[]; path?: string; content?: string; digest?: string; created?: boolean; revoked?: boolean; bytes?: number; receiptId?: string };
type Native = {
    getScopedFilesCapabilities(): string;
    requestScopedDirectory(scope: string, id: string): string;
    submitScopedFiles(json: string): string;
    getScopedFilesResult(scope: string, id: string): string;
    verifyScopedFiles(scope: string, id: string): string;
    cancelScopedFiles(scope: string, id: string): string;
};
type Receipt = { id: string; operation: string; at: number };
const PREFIX = 'float_phone_files_receipt_v1_'; registerDynamicPrefix(PREFIX);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
function validateScope(scope: PhoneFileScope) { if (!['work', 'private'].includes(scope.mode) || !validId(scope.workspaceId)) throw new Error('手机目录仅绑定当前工作或私人空间。'); }
const key = (scope: PhoneFileScope) => { validateScope(scope); return PREFIX + scope.mode + '_' + scope.workspaceId; };
export class PhoneFileError extends Error {
    constructor(public code: string, message: string) { super(message); }
}
const messages: Record<string, string> = {
    file_exists: '目标文件已存在；本版本只另存新文件，不覆盖原件。',
    permission_revoked: '目录权限已失效，请重新选择或撤销此授权。',
    grant_scope: '目录不属于当前空间，未访问其他区域。',
    read_only: '此目录只有读取权限，不能新建文件。',
    unsupported_text: '仅支持txt、md、json、csv、log文字；未读取二进制正文。',
    text_capacity: '单文件超过32KiB，未截断读取或保存。',
    invalid_utf8: '文件不是有效UTF-8文字，未猜测编码。',
    invalid_path: '仅支持授权目录内的相对路径，不能使用URI或跨级路径。',
    invalid_text: '文字含不支持的控制字符或无效Unicode。',
    directory_capacity: '目录超过128项；请改选更小的目录，不会显示一份被截断的清单。',
    write_uncertain: '新文件创建结果尚未确认，请核对同一回执及目录，不要自动重新新建。',
    receipt_capacity: '本机写入回执已达128条；请先核对，再撤销并重新授权目录。文件不会被删除。',
    grant_capacity: '本App最多保留32个目录授权，请先撤销不再使用的授权。',
    file_missing: '目录或文件已被移动、改名或移除。',
    request_missing: '此回执已不在当前进程；未重放读取或自动重新创建文件。',
    cancelled: '本机操作已停止；已经提交的文件创建不能自动撤回。',
    busy: '本机文件提供器繁忙，尚未确认操作。',
};
function native(): Native | null {
    if (typeof window === 'undefined' || !isShellEnvironment()) return null;
    const api = (window as unknown as { AndroidShell?: Partial<Native> }).AndroidShell;
    return api && ['getScopedFilesCapabilities', 'requestScopedDirectory', 'submitScopedFiles', 'getScopedFilesResult', 'verifyScopedFiles', 'cancelScopedFiles'].every(name => typeof api[name as keyof Native] === 'function') ? api as Native : null;
}
export function phoneFileAvailability(): { available: boolean; message: string } {
    const api = native();
    if (!api) return { available: false, message: isShellEnvironment() ? '当前APK没有目录桥，需要同签名更新至含此能力的版本。' : '此页面没有本机目录桥；普通浏览器或VPS不能代替手机执行。' };
    try {
        const cap = JSON.parse(api.getScopedFilesCapabilities());
        if (cap.ok === true && cap.protocol === 'float-shell-files/v1' && cap.location === 'android_device' && cap.createOnly === true && cap.maxTextBytes === 32768) return { available: true, message: '执行于此手机 · Android授权目录，文件不自动上传VPS。' };
    } catch { /* No fallback or guessed success. */ }
    return { available: false, message: '本机目录桥格式不匹配或尚未就绪，未访问文件。' };
}
export function phoneFileReceipt(scope: PhoneFileScope): Receipt | null {
    try {
        const parsed = JSON.parse(kvGet(key(scope)) || 'null');
        return object(parsed) && validId(parsed.id) && typeof parsed.operation === 'string' && ['picker', 'grants', 'revoke', 'list', 'read', 'create'].includes(parsed.operation) && typeof parsed.at === 'number' ? parsed as Receipt : null;
    } catch { return null; }
}
function parse(raw: unknown): { pending: boolean; result?: PhoneFileResult } {
    if (typeof raw !== 'string' || raw.length > 160000) throw new PhoneFileError('protocol', '本机响应不匹配，结果未确认。');
    let value: unknown; try { value = JSON.parse(raw); } catch { throw new PhoneFileError('protocol', '本机响应不是有效JSON。'); }
    if (!object(value) || value.protocol !== 'float-shell-files/v1' || value.location !== 'android_device' || typeof value.ok !== 'boolean') throw new PhoneFileError('protocol', '本机执行位置或协议不匹配，未加载结果。');
    if (!value.ok) throw new PhoneFileError(typeof value.code === 'string' ? value.code : 'native_error', messages[String(value.code)] || '本机文件操作未确认；提供器可能离线、不支持此操作或权限已失效。');
    if (value.state === 'pending') return { pending: true };
    if (value.state !== 'complete' || !object(value.result)) throw new PhoneFileError('protocol', '未收到本机完成回执。');
    const result = value.result;
    if (Object.keys(result).some(name => !['grant', 'grants', 'files', 'path', 'content', 'digest', 'created', 'revoked', 'bytes'].includes(name))) throw new PhoneFileError('protocol', '本机返回了未审核字段，未加载结果。');
    if (result.content !== undefined && (typeof result.content !== 'string' || new TextEncoder().encode(result.content).byteLength > 32768)) throw new PhoneFileError('protocol', '本机文字超限或格式异常。');
    for (const field of ['grants', 'files']) if (result[field] !== undefined && (!Array.isArray(result[field]) || result[field].length > (field === 'files' ? 128 : 32))) throw new PhoneFileError('protocol', '本机清单超限或格式异常。');
    const grant = (item: unknown) => object(item) && Object.keys(item).every(key => ['id', 'label', 'readable', 'writable'].includes(key)) && validId(item.id) && typeof item.label === 'string' && item.label.length <= 80 && typeof item.readable === 'boolean' && typeof item.writable === 'boolean';
    if ((result.grant !== undefined && !grant(result.grant)) || (Array.isArray(result.grants) && !result.grants.every(grant))) throw new PhoneFileError('protocol', '本机授权列表格式异常。');
    if (Array.isArray(result.files) && !result.files.every(item => object(item) && Object.keys(item).every(key => ['name', 'directory', 'bytes'].includes(key)) && typeof item.name === 'string' && new TextEncoder().encode(item.name).byteLength <= 240 && !/[/\\\x00-\x1f]/.test(item.name) && typeof item.directory === 'boolean' && (item.bytes === null || (Number.isSafeInteger(item.bytes) && Number(item.bytes) >= 0)))) throw new PhoneFileError('protocol', '本机文件列表格式异常。');
    if ((result.path !== undefined && (typeof result.path !== 'string' || new TextEncoder().encode(result.path).byteLength > 240)) || (result.digest !== undefined && (typeof result.digest !== 'string' || !/^[a-f0-9]{64}$/.test(result.digest)))) throw new PhoneFileError('protocol', '本机文件标识格式异常。');
    return { pending: false, result: result as PhoneFileResult };
}
function wait(signal?: AbortSignal) { return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new PhoneFileError('wait_stopped', '等待已停止，请核对同一回执。')); return; }
    const abort = () => { clearTimeout(timer); reject(new PhoneFileError('wait_stopped', '等待已停止，请核对同一回执。')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 150); signal?.addEventListener('abort', abort, { once: true });
}); }
async function digest(text: string): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), value => value.toString(16).padStart(2, '0')).join('');
}
async function poll(api: Native, scope: PhoneFileScope, receipt: Receipt, first?: string, signal?: AbortSignal, expected?: { path?: string; digest?: string; bytes?: number }): Promise<PhoneFileResult> {
    const started = Date.now(), limit = receipt.operation === 'picker' ? 180000 : 15000;
    let raw = first;
    try {
        while (true) {
            if (signal?.aborted) throw new PhoneFileError('wait_stopped', '等待已停止，请核对同一回执。');
            const value = parse(raw ?? api.getScopedFilesResult(JSON.stringify(scope), receipt.id));
            if (!value.pending) {
                const item = value.result!;
                const valid = receipt.operation === 'picker' ? !!item.grant : receipt.operation === 'grants' ? !!item.grants : receipt.operation === 'list' ? !!item.files && typeof item.path === 'string' : receipt.operation === 'read' ? typeof item.content === 'string' && !!item.digest && item.bytes === new TextEncoder().encode(item.content).byteLength : receipt.operation === 'create' ? item.created === true && !!item.path && !!item.digest && Number.isSafeInteger(item.bytes) && item.bytes! >= 0 && item.bytes! <= 32768 : item.revoked === true;
                if (!valid) throw new PhoneFileError('protocol', '本机完成回执与操作不匹配，未声称成功。');
                if ((expected?.path !== undefined && item.path !== expected.path) || (expected?.digest !== undefined && item.digest !== expected.digest) || (expected?.bytes !== undefined && item.bytes !== expected.bytes) || (receipt.operation === 'read' && item.digest !== await digest(item.content!))) throw new PhoneFileError('protocol', '本机回执与原目标或正文摘要不匹配，请核对同一回执。');
                if (signal?.aborted) throw new PhoneFileError('wait_stopped', '等待已停止，请核对同一回执。');
                kvRemove(key(scope)); return { ...item, receiptId: receipt.id };
            }
            if (Date.now() - started > limit) throw new PhoneFileError('timeout', '提供器尚未回报；已停止等待，请核对同一回执。');
            await wait(signal); raw = undefined;
        }
    } catch (error) {
        if (signal?.aborted || (error instanceof PhoneFileError && error.code === 'timeout')) { try { api.cancelScopedFiles(JSON.stringify(scope), receipt.id); } catch { /* Keep uncertain receipt. */ } }
        if (error instanceof PhoneFileError && !['write_uncertain', 'timeout', 'wait_stopped', 'protocol'].includes(error.code)) kvRemove(key(scope));
        throw error instanceof PhoneFileError ? error : new PhoneFileError('uncertain', '本机回执未确认，请核对同一操作。');
    }
}
export async function phoneFileCall(scope: PhoneFileScope, operation: 'picker' | 'grants' | 'revoke' | 'list' | 'read' | 'create', payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<PhoneFileResult> {
    validateScope(scope);
    const fields = operation === 'picker' || operation === 'grants' ? [] : operation === 'revoke' ? ['grantId'] : operation === 'create' ? ['grantId', 'path', 'content'] : ['grantId', 'path'];
    if (Object.keys(payload).length !== fields.length || Object.keys(payload).some(name => !fields.includes(name))) throw new PhoneFileError('invalid_request', '手机操作参数不匹配，未交给其他工具。');
    if (signal?.aborted) throw new PhoneFileError('wait_stopped', '尚未提交手机操作。');
    const available = phoneFileAvailability(), api = native();
    if (!available.available || !api) throw new PhoneFileError('unavailable', available.message);
    let expected: { path?: string; digest?: string; bytes?: number } | undefined;
    if (['list', 'read', 'create'].includes(operation)) {
        if (typeof payload.path !== 'string') throw new PhoneFileError('invalid_request', '手机相对路径格式不匹配。');
        expected = { path: payload.path };
        if (operation === 'create') {
            if (typeof payload.content !== 'string') throw new PhoneFileError('invalid_request', '手机新文件正文格式不匹配。');
            expected.digest = await digest(payload.content); expected.bytes = new TextEncoder().encode(payload.content).byteLength;
        }
    }
    if (signal?.aborted) throw new PhoneFileError('wait_stopped', '尚未提交手机操作。');
    if (phoneFileReceipt(scope)) throw new PhoneFileError('pending', '请先核对上次手机回执，未新建重复操作。');
    const receipt: Receipt = { id: crypto.randomUUID(), operation, at: Date.now() };
    kvSet(key(scope), JSON.stringify(receipt));
    // Deliberately retain only an opaque receipt: no filename, URI or text body in KV.
    let raw: string;
    try { raw = operation === 'picker' ? api.requestScopedDirectory(JSON.stringify(scope), receipt.id) : api.submitScopedFiles(JSON.stringify({ ...payload, operation, requestId: receipt.id, scope })); }
    catch { throw new PhoneFileError('uncertain', '桥接回执丢失，请核对同一手机操作。'); }
    return poll(api, scope, receipt, raw, signal, expected);
}
export async function recoverPhoneFileCall(scope: PhoneFileScope, signal?: AbortSignal): Promise<PhoneFileResult> {
    const receipt = phoneFileReceipt(scope), api = native();
    if (!receipt || !api || !phoneFileAvailability().available) throw new PhoneFileError('unavailable', '没有可核对的本机回执，或当前页面没有目录桥。');
    let first: string | undefined;
    if (receipt.operation === 'create' && !signal?.aborted) { try { first = api.verifyScopedFiles(JSON.stringify(scope), receipt.id); } catch { throw new PhoneFileError('uncertain', '核对尚未返回；没有重新提交创建操作。'); } }
    return poll(api, scope, receipt, first, signal);
}
export function abandonPhoneFileWait(scope: PhoneFileScope): void {
    const receipt = phoneFileReceipt(scope), api = native();
    if (receipt && api) { try { api.cancelScopedFiles(JSON.stringify(scope), receipt.id); } catch { /* This never retracts a write. */ } }
    kvRemove(key(scope));
}
