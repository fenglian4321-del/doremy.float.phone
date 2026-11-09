export const CODEX_GATEWAY_PROTOCOL: 'float-codex/v1';
export type CodexGatewayToolName = 'float_xinchao_context' | 'float_memory_pulse';
export const CODEX_GATEWAY_TOOLS: ReadonlyArray<{ name: CodexGatewayToolName; description: string; parameters: Record<string, unknown> }>;
export class CodexGatewayError extends Error { code: string; status: number; constructor(code: string, message: string, status?: number); }
export function isObject(value: unknown): value is Record<string, unknown>;
export type CodexGatewayCall = { requestId: string; scopeId: string; tool: CodexGatewayToolName; args: Record<string, unknown> };
export function validateCodexTool(name: unknown, args: unknown): { tool: 'xinchao_context' | 'pulse'; arguments: Record<string, unknown> };
export function validateCodexCall(body: unknown): CodexGatewayCall;
