# Orbis 独立记忆导出适配来源

核对日期：2026-11-08。公开上游：[fenglian4321-del/Orbis](https://github.com/fenglian4321-del/Orbis)。适配依据是实际导出及 DTO，不是猜测聊天备份。

| 源码路径（仓库根起） | Git blob SHA |
| --- | --- |
| app/src/main/java/me/rerere/rikkahub/data/orbis/memory/OrbisMemoryRepository.kt | 577940a6dc950512a30247a19cf71ed1d5520822 |
| app/src/main/java/me/rerere/rikkahub/data/orbis/memory/OrbisMemoryModels.kt | 107899c4e2104976cc2922ca97db5ff647cefb20 |
| app/src/main/java/me/rerere/rikkahub/data/orbis/memory/OrbisMemoryEntity.kt | bec05765af3ff21560eabac6faba0b4b03f26485 |

根对象为 `schema: orbis_memory_export_v1`、`assistantId`、当前 `notes` 及历史 `revisions`。只上传选中的当前 note。note 的原标识、助手、正文、摘要、state/previousState、tags/keywords、important、minIntervalTurns、createdAt/updatedAt、revision/deleted 均验证。未知字段拒绝，避免静默丢弃未来格式。

当前适配不会复刻 Orbis 的逐轮条件判断、minIntervalTurns 或人格作用域；这些字段作为来源原件保留。静态及暂停记忆不自动注入，conditional 的后续检索由当前共享库策略处理；pinned 映射永久记忆。原助手身份不构成 Float 的角色权限隔离，导入前明确提示所有连接该私人库的设备/角色共用。没有原聊天证据，不生成虚构出处。

当前代码是数据协议适配，不复制 Android 应用实现。未来格式或原生源码变化应重新核对并扩展验证，不放宽为任意 JSON 上传。
