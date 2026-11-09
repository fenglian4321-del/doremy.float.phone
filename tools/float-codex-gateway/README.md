# Float 固定只读 Codex 执行网关

> 2026-11-09：本模块现在仅保留为显式诊断原型，普通聊天不曝光/执行这两项工具。日常记忆和内置工具走直接路径。下文描述原型协议和隔离验证，不代表生产聊天仍需要Codex，也不代表已接通邮件/小红书/花园。当前分工见 `docs/private-memory-phase-7-consolidation.md`。

本地实现了产品入口，不再只有协议示例。流程是 **Float 所选 API 模型 → Float 原生工具循环 → 同源本人代理 → 私有网关 → Codex app-server → 固定心潮 MCP 工具 → 原模型**。模型 key 留在原供应商请求路径；网关只收固定工具参数和不可读的会话标识，不读取或转发官方 auth.json。

网关不会调用 turn/start、command/exec、动态工具、任意 RPC 或模型接口。每个 worker 都创建专用空白 CLI home，配置不可推理的本机 provider，再创建 ephemeral 只读执行 thread。CLI 目前接受经核对的 0.166/0.167 协议范围；本地实际二进制为 0.166.0-alpha.5.1，0.167 仍需目标环境复查。启动握手、工具目录及 schema 不兼容明确失败。依据 [官方 app-server 协议](https://developers.openai.com/codex/app-server/)及本地生成的 v2 类型；不把它等同于可从外部调用所有 Codex 能力。

| Float 工具 | 唯一实际调用 | 参数限制 |
| --- | --- | --- |
| float_xinchao_context | xinchao_context | 固定 mode=inspect；仅允许 max_tokens 整数 200–2400，默认1200；无 session_id/force |
| float_memory_pulse | pulse | 固定 include_archive=false；不接收模型参数 |

接口依据公开 `tianyupaipai-cmd/xinchao-nian/xinchao/src/mcp-protocol.js`（blob eba7f5b7f5a98b623c61cdc46084169f15da3301）及原生 pulse；这是数据接口适配，没有复制心潮实现。MCP 配置还限制 enabled_tools；网关每次执行只使用服务器固定映射。其他心潮写入、记忆写工具、shell、事件回传和主动消息尚不开放。原有默认 AI 自动记忆仍走共享正式库原链路，可选审核行为不变。

运行需要 Node 20.6+、已核对 Codex、独立低权限服务用户及私有状态目录。根据 `example.env` 配置独立长口令（网关与 MCP token 不同），用既有服务管理器启动：

```sh
node --env-file=/private/float-codex-gateway.env tools/float-codex-gateway/server.mjs
```

HTTP 只监听 127.0.0.1；不要公开端口。状态目录只供服务用户访问，CLI home 不指向现有官方账户目录；内部状态不是正式记忆或备份。worker 空闲5分钟退出，最多8个作用域（含检查连接）、每作用域最多4个排队请求；停服和取消只终止自己创建的进程树。状态目录的旧 executor-* 目录需停服后由管理员按私有运行状态清理，不提供自动删除或恢复入口。

Float 服务端单独填写 `FLOAT_CODEX_GATEWAY_URL`、`FLOAT_CODEX_GATEWAY_TOKEN`；受控内部 HTTP 才显式开启 `FLOAT_CODEX_GATEWAY_ALLOW_HTTP=true`。本人认证复用 `/api/shared-memory` 的 HttpOnly 会话，网关代理位于其 cookie 路径下；反向代理部署必须设置 `FLOAT_SHARED_MEMORY_PUBLIC_ORIGIN` 为 **Float 自身** HTTPS origin，不信任任意转发头。网关服务 token 与本人访问口令、Ombre review token 分开，全部不加 NEXT_PUBLIC。

Float 与网关须共享可访问本机地址的网络环境；Docker 的127.0.0.1不能直接访问宿主机loopback。当前服务刻意只监听loopback，发布时需由部署任务审核共用网络命名空间或受控主机网络方案，不能只把宿主机地址写进容器 env 后声称接通，也不要为省事绑定公网。代码任务没有改服务器网络、创建服务或发布镜像。

用户在原记忆设置的“心潮与 Codex 只读工具”先检查连接，再选择允许本设备聊天使用。默认关闭；仅共享记忆来源、chat/group_chat 上下文暴露，不给自定义应用。所选 API 须开启且支持原生工具调用，禁用原生协议会明确报错。未对任意硅基流动/中转模型承诺兼容；切换模型仍使用 Float 现有 provider 适配。旧云端 bailout 不能运行这个私有工具循环，启用网关的回合不发送该无工具兜底快照；主动与离线生成另行开发。

8 KiB 请求、48 KiB 正文结果、64 KiB 代理响应上限；超限报错而不截断。执行整体35秒，代理40秒，浏览器45秒；取消终止该作用域当前 worker，后续请求重新握手。相同 scope/requestId/实际参数在当前进程内共用回执，10分钟/1000条上限；同ID异参409，取消结果不永久缓存。重启、淘汰后可能重读，但只读工具不会产生重复写入。工具结果仍会进入原聊天工具历史，不自动删除既有调试日志。

模型请求继续由原 usage 采集；Codex 只读工具单列请求状态/耗时，不重复算模型 token，不把工具回执当 usage 缺失。上游心潮/OB 内部可能消耗的模型调用不在本机账本范围，留待后台用量阶段。

```sh
npm run test:codex-gateway
# Real binary is explicit; tests create isolated empty homes and synthetic HTTP MCP.
FLOAT_TEST_CODEX_BIN=/absolute/path/to/codex npm run test:codex-gateway
```

本地真实 CLI + 合成 HTTP MCP + 实际 Float 本人代理/客户端/执行器/原生模型循环已通过 JSON 与 SSE 参数增量及工具结果回传同一模型、模型用量与工具回执分列、认证/同源/白名单/幂等/冲突/超时/取消恢复测试。模型 HTTP 为虚构响应，没有调用付费模型或私人 API；浏览器设置另用虚构状态做开关与手机布局验证，不把它当真实 VPS 验收。
