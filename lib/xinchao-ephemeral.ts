// Pure helpers shared by request/log boundaries; no storage, network or engine imports.
export const XINCHAO_LAYER = '【Float心潮临时状态｜仅本轮】';
export const XINCHAO_END = '【Float心潮临时状态结束】';
type Message = { role: string; content: unknown };
export const isXinchaoLayer = (message: Message) => message.role === 'system' && typeof message.content === 'string' && message.content.startsWith(XINCHAO_LAYER);
export function mapXinchaoBlocks(text: string, transform: (block: string) => string): string {
    let result = '', rest = text;
    while (true) {
        const start = rest.indexOf(XINCHAO_LAYER); if (start < 0) return result + rest;
        result += rest.slice(0, start);
        const end = rest.indexOf(XINCHAO_END, start);
        const length = end < 0 ? rest.length : end + XINCHAO_END.length;
        result += transform(rest.slice(start, length)); rest = rest.slice(length);
    }
}
export function filterXinchaoBlocks<T extends Message>(messages: T[], keep: (block: string) => boolean): T[] {
    return messages.flatMap(message => {
        if (message.role !== 'system' || typeof message.content !== 'string') return [message];
        const content = mapXinchaoBlocks(message.content, block => keep(block) ? block : '');
        return content === message.content ? [message] : content.trim() ? [{ ...message, content } as T] : [];
    });
}
export function withoutXinchaoLayers<T extends Message>(messages: T[]): T[] { return filterXinchaoBlocks(messages, () => false); }
export function redactXinchaoLayers<T extends Message>(messages: T[]): T[] {
    return messages.map(message => {
        if (message.role !== 'system') return message;
        const clean = (text: string) => mapXinchaoBlocks(text, () => '[本轮心潮临时状态已省略，不存入调用日志]');
        if (typeof message.content === 'string') return { ...message, content: clean(message.content) } as T;
        if (Array.isArray(message.content)) return { ...message, content: message.content.map(part => part && typeof part.text === 'string' ? { ...part, text: clean(part.text) } : part) } as T;
        return message;
    });
}
