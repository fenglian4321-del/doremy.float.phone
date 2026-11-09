# 可选生活对话在场反馈：内部候选

保留原心潮查看与聊天状态注入，新增独立的“对话互动反馈”设置，默认关闭。当前实现是内容为空的真实新消息在场与固定普通对话互动（companionship）回报，**不自动推断亲密、争执等语义类型**，不发送 exchange、用户/助手正文、note、情绪、关系标签或身体参数，也不调用 satisfy/body/now-lines。主动消息和离线送达另行开发，本候选没有开放其开关。

## 实际入口

在心潮 App 中手动检查反馈入口，明确选择一个生活私聊并开启。检查只核对 Float 反馈配置，不发送在场信号；实际回报前才验证心潮 /health。查看、聊天参考与反馈三组偏好独立。换反馈绑定会关闭开关，不能自动把另一个角色接入。当前浏览器及同源页面同步设置，不声称关闭其他设备的偏好或停止心潮后台。

实际 `generateChatCompletion` 在生成前捕获选择版本；当前用户消息的正常非空回复完成后，异步发送标识。未启用不请求此入口；群聊、黑名单、非 chat App、生活场景、离线/后台标签、追问、定时唤醒、临时系统任务、撤回/失败消息、生成失败/取消/空结果均不回报。生成中再启用不补报本轮，关闭再开启不会复活旧回调。聊天结果不等待反馈完成，失败不阻断聊天；生成结束后的控制器清理不会撤销已确认成功轮次的独立反馈，用户关闭反馈仍会取消等待。

浏览器仅发送 sessionId、characterId、messageId、createdAt。服务端再以独立 HMAC 转换为 opaque eventId/sessionId，向固定 `/v1/conversation-event` 发一次 `{eventId, sessionId, interactionType: "companionship"}`。原始 ID、正文与模型输出不进入心潮请求或反馈磁盘账本。服务端依靠已授权 Float 客户端的真实生成入口提供消息标识，不单凭这些字段声称能独立证明对话内容。

公开上游 [server.js](https://github.com/tianyupaipai-cmd/xinchao-nian/blob/main/xinchao/src/server.js) 已核对 blob `2abe7fa9d81407e84794290d23bacaf6a7027378`，[engine.js](https://github.com/tianyupaipai-cmd/xinchao-nian/blob/main/xinchao/src/engine.js) 已核对 blob `09d10d35a4755fabf5ab2fa99bdac902af1d3734`。本适配固定 4.3.0-2abe7fa9 合同；明确给出固定 companionship 的事件跳过 classifyExchange 分类模型；心潮按自身规则处理真实普通互动，不保证每个事件都改变驱力。在场信号也可能唤醒心潮、更新最近在场/心跳与原有作息学习。开启反馈不代表心潮其他后台行为停止计费或受 Float 控制，也不推断任何现实关系。上线前仍须核对实际服务器版本。

## 配置与回执

新增环境变量默认关闭、私有字段留空：

```text
FLOAT_XINCHAO_FEEDBACK_ENABLED=false
FLOAT_XINCHAO_FEEDBACK_STATE_DIR=
FLOAT_XINCHAO_FEEDBACK_LEDGER_KEY=
```

需独立绝对私有目录、32–512 字符高熵稳定 ledger key，不能与本人/审核/心潮服务凭据共用；服务端已有 FLOAT_XINCHAO_URL / DYNAMIC_MIND_TOKEN / REST_CONTRACT 继续生效。目录必须使用持久卷并随停写备份保存，所有副本共用同一账本；不能为每个容器创建独立回执目录。可信公网 origin 沿用 FLOAT_SHARED_MEMORY_PUBLIC_ORIGIN。浏览器永远不接收服务令牌或 ledger key。

本人 header/HttpOnly cookie、精确 origin 与跨站检查在读请求体前执行。仅接受 catalog/record/status，4 KiB 请求上限，不接受任意 URL、正文或互动类型。消息时间只允许最近 10 分钟和最多 1 分钟时钟提前，不补报历史。整个本人请求预算 3 秒，固定外部操作预算 2.2 秒，不跟随跳转或自动重试。

事件指纹不含设置 revision，重复生成、不同浏览器或重新开关同一消息不会产生新的远端事件。外部调用前持久化 reserved 回执，最终 recorded 仅含 revision；失败/丢失响应为 uncertain。原请求或进程中断后不自动再发，status 只读本地账本、不查询/再次调用心潮。每 20 秒最多一个新信号，限频消息也记回执而不延后补发。全局最多 4096 个事件，不自动裁剪；原生文件权限为目录 0700/文件 0600，Windows 还依赖目录 ACL。

账本身份绑定密钥与 origin，错配、坏文件、无身份的既有回执或残留 state.lock 均停止操作。元数据锁最多等待 500ms，绝不自动删除旧锁。维护前停写备份并核对未知事件；不能改 key、origin、私有目录或删除回执来“恢复重发”。服务 token 正常轮换不改变事件指纹；ledger key / origin 的迁移必须保留去重历史并单独设计。新候选未上线，不能读取旧 phase15 的不存在回执来推断已反馈。

## 验证与限制

新增 `scripts/test-xinchao-feedback.mjs`：实际本人 route、私有文件账本、固定 HTTP 适配器和实际导出的聊天生成包装函数，测试默认关闭、独立绑定、入口作用域、非阻断、消息去重、重开实例、账本错配/坏文件、限频、2.2 秒超时、丢失响应、跳转/版本拒绝、原回执读取和请求中关闭。390px 实际 React/client 同一网关走通检查、绑定、开启、模拟完成、再生成不重报、核对、换绑定关闭与服务端未启用；未见外部浏览器请求或横向溢出。截图仅保存在 work/internal-candidate。

`npm run test:xinchao` 包含原只读、聊天参考及新反馈测试；UI 测试用 `node scripts/test-xinchao-feedback.mjs --ui`，需要配置测试 Playwright/浏览器位置。全部服务、材料及模型完成结果均为合成；没有向真实心潮写入或调用真实模型/账户。未上传、部署、打新 APK、操作手机权限；phase15 在线站点和历史发布保持不变。
