// These are execution claims / local opt-ins, not transferable user content.
// Keep native durable receipts and existing local claims on their own device.
const PREFIXES = [
    'float_workspaces_v1_', 'float_workspace_action_v1_', 'float_private_spaces_v1_',
    'float_phone_files_receipt_v1_', 'float_phone_tool_run_v1_',
    'float_phone_device_ui_v1_', 'float_phone_device_run_v1_',
    'float_managed_mcp_receipt_v1_', 'float_managed_mcp_run_v1_',
    'float_xinchao_proactive', 'float_xinchao_feedback_',
];
export function isDeviceLocalExecutionKey(key: unknown): boolean {
    return typeof key === 'string' && PREFIXES.some(prefix => key.startsWith(prefix));
}
