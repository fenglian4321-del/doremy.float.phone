# Float 共享记忆：Ombre 只读适配

本文件为第二阶段历史记录；当前自动记忆与纠错实现及用户后续澄清见 [第三阶段](private-memory-phase-3.md)。

本阶段在 `private-custom` 本地实现共享正式库的浏览与搜索，没有连接真实 VPS、使用真实凭据、读取真实记忆、部署或推送。**代码适配可验证，不表示已与用户服务联通。**

## 使用与配置

入口：资源 → 记忆 → 更多设置 → 共享服务 → 心潮共享记忆。

服务端变量见 `.env.example`：

| 变量 | 含义 |
| --- | --- |
| `FLOAT_SHARED_MEMORY_OMBRE_URL` | 自有 Ombre 根地址，仅 origin，例如 `https://ombre.example`，不含 `/mcp` 或其他路径 |
| `FLOAT_SHARED_MEMORY_OMBRE_PASSWORD` | Ombre Dashboard 密码，仅服务端使用 |
| `FLOAT_SHARED_MEMORY_ACCESS_TOKEN` | Float 共享记忆独立访问口令，随机生成至少 32 字符，不复用 Ombre 密码；不使用 `NEXT_PUBLIC_` 前缀 |
| `FLOAT_SHARED_MEMORY_ALLOW_HTTP` | 默认 false；仅受控内部网络（如同一 Docker 网络）才显式设 true |

部署时仍需原有站点受控访问和 HTTPS。不要把 Ombre 18001 管理端口直接暴露到公网；Float 服务端需能到达它。当前只准备了示例配置，没有修改用户的真实环境文件。

页面口令是 Float 独立访问凭据，不是模型 key 或 Ombre 密码。浏览器只在已打开面板的 React 内存中持有它，收起/离开面板会清除引用和读取结果；不会写 localStorage、sessionStorage、IndexedDB 或 URL。收起面板不等于轮换或撤销服务端口令。

服务端地址与上游密码不接受客户端输入。未配置时不尝试访问网络；自部署免账号模式也不能绕过共享记忆独立口令。官方账号模式还受现有中间件门禁控制。知道此独立口令的人即可访问该私人共享库；本阶段不提供多租户/按角色隔离，Ombre 原本也是每位所有者独立实例。

## 已实现行为

- 列表直接读取正式 Ombre 库，包含其管理 API 返回的归档/禁止浮现条目；人工浏览不意味着自动召回。
- 搜索走 Ombre `/api/search`，最多 10 条，并遵从上游可展示策略；不是全库全文穷尽搜索。
- 点击条目读取正文与完整元数据，标明 Ombre ID 和本次读取时间。上游详情 API 会剥除 wikilink 标记，本阶段不把该响应宣称为原文件的无损导出。
- 刷新再次请求正式库，不把结果写入本机可写记忆库。浏览器与上游请求均禁缓存；关闭面板中断请求，并防止晚到响应重新显示私密数据。
- 固定端点服务端代理：请求只允许 status/list/search/detail。口令通过独立请求头校验，恒定时间比较摘要；不传给 Ombre。
- Ombre 登录会话仅在服务端内存短期保留，并发首次读取共用一次登录；上游 401 只续期一次。禁止跟随重定向，网络有超时，响应限制为 4 MiB，错误不会回显远端正文、地址、上游密码或 cookie。
- 未识别的协议、无效 ID、缺失服务配置、错误口令、跨站请求都明确失败，不回退本机记忆，也不虚构数据。

## 已核对的上游协议

来源：[tianyupaipai-cmd/xinchao-nian](https://github.com/tianyupaipai-cmd/xinchao-nian)，2026-11-08 读取 main。

| 文件 | Git blob SHA | 依据 |
| --- | --- | --- |
| [web/auth.py](https://github.com/tianyupaipai-cmd/xinchao-nian/blob/main/ombre-brain/src/web/auth.py) | `48676f0c38de09a543b15675193988be1808e479` | `POST /auth/login`，JSON password，响应 `ombre_session` cookie |
| [web/buckets.py](https://github.com/tianyupaipai-cmd/xinchao-nian/blob/main/ombre-brain/src/web/buckets.py) | `49da7c2e03ba9c0e7b40886b84539a522045235d` | `GET /api/buckets`，`GET /api/bucket/{id}`，字段与删除标记 |
| [web/search.py](https://github.com/tianyupaipai-cmd/xinchao-nian/blob/main/ombre-brain/src/web/search.py) | `4c7a6db42bc9406aafaedabd939469d5f111ad9f` | `GET /api/search?q=...`，最多 10 条，过滤可展示策略 |
| [web/_shared.py](https://github.com/tianyupaipai-cmd/xinchao-nian/blob/main/ombre-brain/src/web/_shared.py) | `64f84480d5b9141c3590b9e459b0bec7ec254993` | 管理 API 只认 Dashboard cookie，不能把 MCP Bearer token 当作通用管理凭据 |

Latent 源码与 README 也已查看；它原本有独立可写记忆和人格/撤回机制，不直接启用这些功能，以免形成第二套正式事实库。

## 验证与剩余范围

`node scripts/test-shared-memory.mjs` 加载真实适配器和路由，以合成 fetch 边界验证固定路径、口令、服务端登录、并发登录合并、一次会话续期、无效输入零网络调用、格式失败、删除隐藏、错误脱敏及自部署模式下的独立鉴权。没有真实服务调用。

验证结果：

- 全仓 `tsc --noEmit --incremental false` 通过。
- 本阶段新增和修改的 5 个 TS/TSX 文件 lint 通过，0 错误、0 代码警告。
- 完整生产构建通过，包含新 `/api/shared-memory` 服务端路由；沿用第一阶段的 webpack 缓存快照警告，不影响构建结果。
- `npm run test:private-memory` 的本机控制、用量解析、共享适配与路由测试均通过。共享测试还覆盖非 JSON、4 MiB 上限、详情 ID 不匹配和持续 401 的有界重试。
- 实际 React 组件在独立夹具中打包运行于 Chromium，采用生产 CSS、390×844 手机宽度和 Asia/Irkutsk 时区。验证：错误口令不显示条目、解锁、刷新读到新版、原生搜索、详情和元数据、关闭清空/重开需口令、请求未完成时关闭不会重新显示数据、未配置状态，以及不写 localStorage/sessionStorage。无页面 JS 错误、无横向溢出。测试响应均为合成数据，截图明确标明“隔离测试预览 · 非真实记忆”。

尚未完成真实服务端到端验收、真实数据跨设备读取和认证代理部署测试；这些必须在后续获准配置与部署后进行。本阶段没有为截图在正式应用中添加测试路由或绕过账号认证。

编辑、归档、删除、历史/撤销、候选写前审核和 Latent 召回仍未开放。已核对的管理路由虽有归档/删除操作，但没有正文编辑与候选审核，更没有跨 Ombre/Latent 的原子版本屏障；直接开放这些写操作会缺少冲突检测和旧索引禁返保障。后续需要确定受控写入入口、正式库版本条件更新与索引失效协议，然后再连接 AI 写入及自动召回。当前面板不改变 Float 原有本机召回来源，也不会将共享记忆自动注入 Float 模型请求；Ombre 搜索内部是否产生 embedding 调用由上游配置决定，本阶段尚未采集其用量。

Orbis 适配、心潮主动消息/离线推送、用量账本与余额展示仍按需求文档继续，均未因本阶段只读入口而宣称完成。
