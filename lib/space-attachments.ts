/** Explicitly selected text files only. Never fetch a URL or inspect a device directory. */
export async function readSpaceTextAttachment(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<{ path: string; content: string; bytes: number; originalName: string }> {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 32768) throw new Error('文字附件最多32KiB，不会截断导入。');
    if (!/\.(txt|md|json|csv|log)$/i.test(file.name)) throw new Error('当前支持txt、md、json、csv、log文字附件，其他格式暂未接入。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== file.size || bytes.byteLength > 32768) throw new Error('附件大小发生变化，未导入。');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('附件不是有效UTF-8文字，未猜测编码或截断。'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(content)) throw new Error('附件包含不支持的控制字符，未导入。');
    const basename = file.name.split(/[\\/]/).pop() || 'attachment.txt';
    let safe = basename.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '_');
    while (new TextEncoder().encode(safe).byteLength > 180) safe = Array.from(safe).slice(1).join('');
    return { path: 'attachments/' + crypto.randomUUID().slice(0, 8) + '-' + safe, content, bytes: bytes.byteLength, originalName: basename };
}
