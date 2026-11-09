# FloatShell Shizuku 执行通道

2026-11-10；官方 dev.rikka.shizuku API/provider 13.1.5，最低 Shizuku 服务版本13，FloatShell 1.0.33/code32。

官方 SDK 为 MIT 项目：[集成指南](https://github.com/RikkaApps/Shizuku-API)、[手机启动说明](https://shizuku.rikka.app/guide/setup/)。

## 实际实现

ShizukuExecutor 实现 IShizukuExecutor.Stub，由官方 UserService 启动。执行代码位于实际 shell UID2000 或 root UID0 进程；attach 返回 Process.myUid，调用前后核对身份。实现官方 destroy 事务和非 daemon、版本化 bind/unbind，不使用弃用的 Shizuku.newProcess。

Manifest 注册官方 ShizukuProvider，由 INTERACT_ACROSS_USERS_FULL 保护；声明 API_V23 授权与 Shizuku 包查询。Float 没有申请 INTERACT_ACROSS_USERS_FULL。

| 模型工具 | 实际能力 | 限制 |
| --- | --- | --- |
| shizuku_system_info | UserService 读取执行 UID、shell/root 身份和 Android 版本 | 无用户内容；另有本页身份执行探测，不调用模型 |
| shizuku_app_info | 固定 argv 调用 cmd package resolve-activity/path | 仅系统选择器所选应用，返回安装状态、启动组件和 APK 数量，不返回路径或读取文件 |
| shizuku_launch_app | 固定 argv 调用 am start -W --user current -n 已解析组件 | 任务需允许启动，每次还须手机原生确认；系统报告不证明应用内业务成功 |

Android 当前用户、应用状态、工作资料、系统版本和厂商 ADB 限制可能使查询或启动失败。依据 AOSP PackageManagerShellCommand 与 ActivityManager 入口，失败时停止，不绕过限制。未实现任意 shell、任意包名、私有文件、截屏、坐标、输入、安装或卸载。系统权限、安全/设置、Shizuku 和 Float 自身不可选为任务应用。即使执行身份为 root 也不扩大工具目录。

## 授权与任务

工作区工具抽屉有独立入口，区分浏览器/旧 APK、未安装、未启动、未授权、拒绝/撤权、已授权未连接、连接中、就绪及断开。就绪时展示真实执行 UID。

挂载与状态刷新不申请权限、不连接 UserService、不执行命令。本人点击申请、连接、停止或读取身份；停止只解绑 Float 通道。Shizuku 的安装、无线调试和服务启动由本人完成。

系统选择器选应用后，原生框确认本区、任务文字摘要、只读/允许启动及10分钟期限。仅本次新消息暴露实际工具，直接使用当前所选模型，不要求经 Codex。复用组合会话 assistant 执行位置及 owner phone_lease，核对 scope、runId/claim、executionVersion1、原任务摘要和活动状态；不能切换旧任务的执行端。无障碍、SAF、MCP 保持独立授权，Shizuku 不可用时不静默回退。

官方 SDK 缓存授权成功决定；本实现通过官方 IShizukuService AIDL 在执行围栏重新检查活权限。Binder/UserService 死亡或断连、拒绝/撤权、换页/刷新、Activity 销毁、任务停止和授权过期都会使旧 epoch/授权失效。UserService 绑定调用 UID、随机 token 和 owner Binder；客户端死亡时销毁子进程和服务。执行期间轮询后端租约；已经发出的系统动作不能保证撤回。

浏览器先持久化元数据意图，原生同步提交防重回执后才执行。重复 requestId 只读原回执；丢失结果、断连、超时或取消保留待核对状态，不自动重做。正文和命令输出不写入回执/KV/可迁移备份。结果仅供当前模型轮次使用，最终回答仍按原会话保存。本页身份探测不调用模型。

单任务最多64调用，单 UserService 连接最多128个唯一请求，原生私有回执最多512项；容量满时拒绝，不自动删除防重记录。断开重连可重建 UserService；清除网页等待标记不会删除原生回执。

## 验证与真机边界

实际 JDK17/Gradle8.11.1/SDK36 构建 AIDL、Kotlin/Java、DEX 和 APK，并使用官方 apksigner 核对单一 v2 测试签名。新桥、协议及 Provider 包含在 APK 核验内。沿用本机既有调试证书，用户当前安装包的同签兼容仍未知。

针对性测试使用实际三协议适配器、工作/私人空间、Next owner 路由、SQLite 租约和 Shizuku TS 会话；覆盖默认关闭、原调用 ID、只读授权、范围/任务隔离、Binder 死亡、撤权/停止、旧 APK/浏览器、先持久化后动作及不重放。Binder、模型和手机动作均为模拟。JDK 策略测试验证固定 argv、UID、包名/组件注入拒绝；静态检查官方生命周期、nonce 和持久回执线路。390px 实际 React 页面验证申请、连接、身份结果与停止，设备数据仍为合成。

没有自动安装 APK、启动手机 Shizuku、开启无线调试、授予权限、读取私人文件或操作真机。本人启动授权后，仍需核对真实 UID、厂商限制、选择应用与启动确认/取消、Binder 重启/撤权、换页/断连回执和原应用功能。发布测试包不表示已连通用户设备或已部署 VPS。Latent 真实硅基流动校准按部署端实测记录，不能由 Shizuku 测试替代。
