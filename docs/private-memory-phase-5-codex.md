# 第五阶段：所选模型经 Codex 执行固定心潮工具

> 历史阶段记录。第七阶段已按用户新分工撤下普通聊天中的两项 Codex 心潮工具，仅保留显式诊断；记忆和内置工具直接执行。本文原来的聊天启用开关与曝光行为已被替代，当前行为见 [第七阶段](private-memory-phase-7-consolidation.md)。

本地产品代码已接入原工具循环，默认关闭、用户在记忆设置检查连接后启用。所选 API 继续生成工具调用和最终回复，Codex 仅执行固定只读 MCP 动作，不做第二次模型推理，不使用或转发官方登录凭据。参见 `tools/float-codex-gateway/README.md` 的协议、参数和部署限制。

新增同源 `/api/shared-memory/codex`，复用本人 HttpOnly 会话及部署任务修好的可信公开 origin。仅服务端知道私有网关口令；输入不接受 URL、RPC、shell、工具目录、provider key 或模型配置。CLI 独立空白 home，只允许 xinchao_context inspect 与 pulse 不含归档，未知版本/schema 明确失败。最多8个作用域、每作用域4个排队、35秒整体执行、只读请求幂等回执及有界结果；取消会清理自己创建的执行进程树，后续可重新握手。

复用 getEnabledTools、原生 schema、executeToolCalls 和聊天/群聊原循环；其他应用、关闭开关或本机记忆来源不暴露。禁用原生工具协议时拒绝本工具，不能偷偷变成文本动作。旧离线云端 bailout 不会执行本私有网关，启用网关的回合不上传那个无工具兜底快照。主聊天/后台/embedding 原用量不变，新工具回执单列而不计模型 token。

实际验证用了本机 CLI0.166.0-alpha.5.1、空白临时 home、合成 HTTP MCP 和虚构 OpenAI-compatible 模型 JSON/SSE。执行真实 Float 原生循环、provider 适配、usage、客户端、工具执行器和本人路由，结果按原 tool_call_id 返回同一模型；没有 Codex 推理RPC、私人 API 或 VPS 操作。测试涵盖两轮模型用量、工具回执、跨站/公开origin、凭据隐藏、禁止动作/参数、同时重试只执行一次、同ID异参409、超时与取消后恢复。另做手机界面开关、仅聊天暴露、本机来源暂停、会话失效提示与布局检查。

CLI0.167 和真实供应商仍需目标环境验收；不是所有模型/中转都支持完整原生工具循环，也没有开放全部 Codex 能力。产品网关未部署到服务器冻结版本，不代表主动消息或锁屏离线推送完成。
