# Float 心潮独立 App：只读首版

原 Float 桌面第四页新增“心潮”原生入口，旧桌面布局使用已有缺省图标补齐机制。无需新APK，不嵌入第三方iframe，不放宽frame策略，也不复用原站cookie或basic认证。页面为浅苔绿的潮汐看板，支持当前状态、此刻原文、读取时间、状态/此刻版本和连接错误。

首次使用默认关闭，关闭时不请求上游。明确打开后读取一次，之后手动刷新；离开或关闭取消进行中请求，过时结果不能重新显示。关闭不停止心潮容器/后台引擎，不更改现有联动设置，不影响Ombre或删除数据。浏览器只持久化“允许查看”的选择，不保存令牌、心潮状态或此刻原文。

生活聊天使用状态、互动反馈、主动消息作为三个独立的关闭入口显示，当前尚未实现，控件禁用，不用无效的可操作开关假装已接通。本首版不增加聊天上下文，不上报对话、不订阅SSE、不触发模型、不操作身体或亲密配置，不向正式记忆写状态/心跳。工作/私人空间完全不接入。

## 核对来源与部署门槛

核对时间：2026-11-09。公开上游[tianyupaipai-cmd/xinchao-nian](https://github.com/tianyupaipai-cmd/xinchao-nian)当时版本为4.3.0；所读文件：

- `xinchao/package.json` blob `da688f15e3be1c72a3141a9c24d40832ae555a67`。
- `xinchao/src/version.js` blob `135e019c0b3d13462e6f5214b86f3f4f6cec73c3`。
- `xinchao/src/server.js` blob `2abe7fa9d81407e84794290d23bacaf6a7027378`：`/health`返回system/version；`/v1/state`和`/v1/now`在Bearer服务令牌校验之后，只读。上游`config.js`使用SERVICE_TOKEN，Float服务端的DYNAMIC_MIND_TOKEN应指向同一服务令牌，不修改上游变量。
- `xinchao/src/engine.js` blob `09d10d35a4755fabf5ab2fa99bdac902af1d3734`：状态schemaVersion10、revision、consciousness、lastSettledAt及drives。
- `xinchao/src/context-envelope.js` blob `6fe8d2b3d7e1b1128e415a202074cf5b80c33a4c`：此刻返回ok/text/reason/revision/generatedAt；服务渲染拒绝可以返回ok:false和空text，不能假装是连接失败或伪造一段状态。

以上是公开4.3.0源码证据，**并未读取VPS实际源码，也没有声称VPS接通**。部署任务须先比对实际运行源码及鉴权/字段。如果实际代码有定制，需先重新核对适配和测试，不能只凭版本字符串勾选。

需要由部署端提供的服务端变量（全部无NEXT_PUBLIC前缀）：

```
FLOAT_XINCHAO_URL=<心潮服务根地址>
DYNAMIC_MIND_TOKEN=<服务令牌>
FLOAT_XINCHAO_ALLOW_HTTP=false
FLOAT_XINCHAO_REST_CONTRACT=
```

最后一项仅在实际源码比对一致后填`4.3.0-2abe7fa9`，否则请求明确报告尚未核对，不访问上游。容器内可信HTTP如确有需要需显式ALLOW_HTTP=true；地址不接受路径、查询、账号密码、片段或客户端覆盖。原env不自动改，不读取密钥来替用户填写。

每次刷新先读取health，版本/system不符就停止；随后读取固定state/now。总10秒超时，每响应2MiB上限、拒绝跳转及非JSON，错误只返回固定中文提示。严格校验已知字段，输出白名单切片，不转发原始状态、thoughtPool、令牌或上游原始错误。维度只显示六个中性标签；此刻显示服务原文，并标明来源，不据此推断现实关系。

固定本人代理为`POST /api/shared-memory/xinchao`，无请求体/可选操作/任意路径。沿用共享记忆的可信公网origin、本人HttpOnly cookie或独立访问口令。先验证本人，再读取配置，避免匿名探测服务情况。缺少会话时可在App内建立同一本人会话；令牌输入仅临时在组件中，成功或关闭即清空。共享记忆本人的服务配置仍为会话授权前提。

## 验证与尚未完成

`node scripts/test-xinchao.mjs`使用临时本地HTTP假服务验证真实fetch、固定只读路径、版本/格式/鉴权/大小/重定向失败、私密字段裁剪、本人cookie、origin伪造与参数拒绝。手机宽度本地界面测试走真实React、客户端、Next handler、本人cookie与假心潮，验证首次零请求、连接、手动刷新、断连清除旧成功状态、请求中关闭和无正文KV缓存。所有数据虚构，没有真实模型请求。

真实VPS验收仍待部署任务比对后进行；此首版不涵盖生活聊天状态注入、真实对话反馈、satisfy/body/now-lines写入、SSE/主动唤醒或后台任务。后续需独立开关、去重、限频、失败不阻断聊天，不每个状态tick调用模型，不自动引入身体/亲密模拟，不把状态写正式记忆。已发送上下文不能通过关闭功能撤回。
