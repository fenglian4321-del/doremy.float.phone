# Float 共享写入与纠错扩展

**默认 AI 自动保存，用户随时查看和修改。逐条审核是可选项，默认关闭。**

2026-11-09 更新：共享聊天已改为按对话阈值、当前聊天模型同轮决策，详见 [第七阶段](../../docs/private-memory-phase-7-consolidation.md)。默认不再逐回复调用旧写入工具或独立总结 API；新的控制表和续聊缓存仍在同一 review SQLite，正式事实仍只有 Ombre Markdown。此新版本尚未部署。

第八阶段进一步新增[独立工作区](../../docs/private-memory-phase8-workspaces.md)：专用表保存工作对话/文字文件，固定工作工具不接BucketManager。全实例SQLite备份现在也包含工作原文；单工作区导出不包含生活记忆。需配套新前后端，尚未发布。

部署聊天随后报告第八阶段已配套上线；上面的“尚未发布”保留为该阶段交付时记录。当前第九阶段另增[AI私人空间与文字附件](../../docs/private-memory-phase9-private-spaces.md)，以及Docker/源码清单依赖检查，尚未发布。既有第八阶段ZIP和清单不改写。

这是给 `tianyupaipai-cmd/xinchao-nian` 自带 Ombre 的可选源码覆盖层，不是另一套正式记忆数据库。部署聊天已独立验收旧版基础同库 API；本目录新网关/语义召回代码尚未发布到该冻结快照。本代码任务的测试不访问真实记忆、私人凭据或私人 API。

## 正式来源与使用范围

- 正式正文仍由原 `BucketManager.create/update` 写入 Ombre Markdown；索引继续走其原有 outbox。读取始终重读正式正文，不从历史快照回填事实。
- `.float-review/review.sqlite3` 保存幂等提交编号、未决操作、可选待审核记录、来源、导入原件和不可直接编辑的历史快照，用来恢复和撤销；不会独立参与正式召回。
- 仅支持单个 Ombre 进程，协调该进程已知的 BucketManager 写方法。不得同时运行多个预加载/分叉 worker 或其他文件写进程；外部直接编辑、迁移、整库恢复不在锁保护范围，须在维护状态处理。
- 对接 Float 的所有通用记忆写入均走本扩展；Ombre 原生 MCP 和其他直接调用仍保留其原有权限与写入行为。可选审核不是全库的安全隔离层，未统一拦截其他入口。机器适配器应只把 `record` 等窄工具暴露给模型，不把服务端密钥交给模型或浏览器。

## 安装准备（未在真实服务执行）

安装器只接受已核对的四份源码 Git blob SHA（原三份及 `web/_shared.py`）；未知版本或已有私改一律拒绝，不强行覆盖。默认 `--check` 只读，`--apply` 才写源码，不启动服务，也不接触记忆卷。升级应基于干净的已核对原生镜像重建；不得用旧 Float 覆盖层镜像强行跳过模块差异。

```sh
python install_overlay.py --src /path/to/ombre/src --check
```

可在**已审阅的本地 Ombre 基础镜像**上准备一个新镜像：

```sh
docker build -f Dockerfile.overlay \
  --build-arg OMBRE_BASE_IMAGE=my-reviewed-ombre:local \
  -t float-ombre-memory:local .
```

这是镜像构建示例；本任务没有执行 Docker 构建、替换容器或部署。覆盖层额外为原生 `BucketManager.create` 增加默认关闭的 `dont_surface` 参数，确保 Orbis 的静态/暂停条目在首次正式写入时已经隐藏；未知源码拒绝安装。部署前应停服一致性备份完整卷和配置。恢复时必须一起保留 `.float-review`，不能假定原有 OB 导出已经包含扩展状态。

Ombre 侧单独配置：

```env
FLOAT_REVIEW_SERVICE_TOKEN=<单独生成至少32字符的随机口令>
# 可选，默认关闭；启用后 Float 才允许选择 Latent
FLOAT_MEMORY_LATENT_ENABLED=true
```

Float 服务端配置（均不是 `NEXT_PUBLIC_` 变量）：

```env
FLOAT_SHARED_MEMORY_OMBRE_URL=https://your-controlled-ombre-origin.example
FLOAT_SHARED_MEMORY_OMBRE_PASSWORD=<Ombre Dashboard 密码>
FLOAT_SHARED_MEMORY_ACCESS_TOKEN=<另一份至少32字符的随机访问口令>
FLOAT_SHARED_MEMORY_REVIEW_TOKEN=<与 Ombre 的 FLOAT_REVIEW_SERVICE_TOKEN 一致>
FLOAT_SHARED_MEMORY_ALLOW_HTTP=false
FLOAT_SHARED_MEMORY_PUBLIC_ORIGIN=https://your-float-origin.example
```

三类凭据必须分开。仅在受控内部网络用 HTTP 时才显式开启 ALLOW_HTTP；Float 服务端必须能到达这个地址。不要把内部管理端口直接公开，不要使用公开可视化站点或 `/mcp` URL。

## 用户流程

1. 在 Float 的记忆设置打开共享记忆，输入 Float 独立访问口令；不用输入 Ombre 密码或模型 key。
2. 扩展握手成功后，选择“让 Float 使用这份共享记忆”。此选择只影响本设备；同一私人实例由该设备各角色共用，不提供多人或角色隔离。本机旧库保留，既有聊天不做整库上传。
3. AI 自动写入，不逐条要求批准。点击条目、修改正文、保存即可；历史中可撤销正文修改。另一设备下一次读取得到现行版本。
4. 只有主动开启“AI 写入前需要我确认”，未来 AI 写入才进入待确认区。手工纠错仍直接保存；暂停 AI 自动记忆也不会阻止手工纠错。

访问口令不进入浏览器持久存储；服务端授予 7 天、HttpOnly、SameSite=Strict 的站点会话，HTTPS 下设置 Secure。收起面板保留会话让 AI 能继续工作；“断开共享记忆”清除此设备会话。原口令、Ombre 会话和服务密钥不返回前端。轮换访问口令或服务密钥会使旧会话失效。断开不撤销已经获准且发出的请求。

## 安全写入与恢复

- 人工修改带原版本，待确认记录带自身版本。冲突不会覆盖新正文，也不会自动丢弃用户输入。
- 版本包含正文和事实元数据，排除召回次数/最后激活时间，正常召回不会阻止纠错；这些计数更新仍走原 touch_many。
- 先持久保存写入意图，再修改正式文件，最后落历史与回执。重复提交核对同一操作；崩溃/超时后可恢复，不盲目重复创建。
- 自动写入对相同正式正文做精确去重；不承诺识别所有语义近似或矛盾事实。纠正一条记录不会自动改写其他独立记录、旧聊天或调试日志。
- 撤销只撤销正文，保留当前其他元数据；如果之后有事实修改则拒绝覆盖。新增记忆不能通过正文撤销变成删除。
- 正文上限 12000 字符；HTTP 写请求上限 64 KiB、Float 读取响应上限 4 MiB。超限明确失败，不截断或假称成功。修改历史目前显示本入口最近 30 条，待处理显示前 100 条并提供总数。

## 协议与验证

`/float-memory/v2/{action}` 是本扩展定义的接口，**不是 Ombre 原生接口**。所有操作都要求服务端 Bearer token，不接受浏览器 Dashboard cookie。

| 方法 | action | 行为 |
| --- | --- | --- |
| GET | status | v2 协议、默认自动/可选审核策略 |
| GET | detail | 正式原正文、版本与可用来源 |
| GET | memories | 仅可自动使用的正式事实，走原 SurfacePolicy 的 importance 策略；排除私有类型、禁止浮现、归档和删除记录 |
| GET | candidates / history | 可选待审核/未决记录、正文历史 |
| GET | catalog / import_batches | 当前/归档/回收站分页列表及未决操作；Orbis 导入批次 |
| POST | record | AI 自动写入；只有 reviewRequired=true 时才等待审核 |
| POST | save / undo_save | 用户直接纠错/有版本保护的撤销 |
| POST | revise / approve / reject | 可选审核时修正、确认、忽略 |
| POST | recall / policy | 召回计数、版本化共享开关 |
| POST | manage | 有版本保护的归档、软删除、恢复及未决操作恢复 |
| POST | import_note / import_rollback | 单条幂等 Orbis 导入；分页撤销本批次未改动的新条目 |

测试：

```sh
python -m unittest discover -s tools/float-memory-review -p 'test_*.py' -v
npm run test:private-memory
```

本地已执行真实扩展逻辑、Float 代理、客户端存储/召回路由和 React 界面的串联测试；正式 BucketManager、模型和真实部署仍是合成边界。安装器另用读取的公共源码快照验证了兼容检查、补丁和 Python 编译。并未运行用户官方容器或发出真实模型请求。

## 归档、回收站与导入

归档通过正式元数据 `type=archived`、`dont_surface=true` 隐藏，不移动原文件；本入口可恢复自身创建的这种归档。原生物理归档不能通过此接口恢复。删除使用原生软删除及恢复，无永久清空接口。恢复和批量撤销均核对事实版本，后续人工修改不会被覆盖。召回不包含归档/删除/隐藏条目。

Orbis 只接收其独立记忆导出 `orbis_memory_export_v1`，不接收完整聊天备份。浏览器先本地预览、选择，再确认导入当前同一共享库。历史 revisions 和原库已删除条目不上传。来源标识、原正文、状态、时间、标签、关键词等保留于导入原件/来源元数据；正式 Markdown 的外层空白会按原生写入规则规范化，原件仍保留完整空白。`static/paused` 只保存不自动召回，`pinned` 映射为永久记忆。每个文件最多 20 MiB/1000 条，每条正文最多 12000 字符，来源元数据最多 3000 UTF-8 字节，超限拒绝，不截断。重导同一原件跳过；同源不同版本提示冲突，不覆盖；撤销只软删除该批次新建且未改动的条目，不删除原有重复条目，也不会自动复活撤销条目。详见 [Orbis 格式来源](ORBIS_SOURCE.md)。

## Latent 派生召回

可选启用后，设备在记忆偏好选择 Ombre / Latent / 关闭召回。Latent 复用保留 AGPL 许可的 `oliscatt/Latent-memory` 原引擎，默认 `lexical-graph-v1` 使用 `MemoryIndex(embed=False)` 词面/二元词/图谱，不调用模型。

显式选择服务器 `FLOAT_MEMORY_LATENT_MODE=semantic-hybrid-v1` 后，使用同一个上游引擎的 `embed=True`、配置化 OpenAI-compatible embedding 适配器和词面/图谱混合召回。配置见 [semantic-config.example.env](semantic-config.example.env)。查询与符合召回条件的正文会发到该供应商；未知模型必须明确提供已校准门槛和向量维度，不套用其他模型常数。未配置或非法配置拒绝启动此模式，不假称语义可用。

索引仅在内存派生，正式池最多 2000 条/200 万字符，语义索引另限 4000 块及 200 万向量分量（块数 × 维度）；超限在付费 embedding 前拒绝，不截断正文。HTTP 不跟随跳转，校验向量数量、索引、维度、有限数和非零范数；不保存 key、响应原文或向量文件。模型、端点完整路径、维度、前缀、门槛与配置 revision 参与索引身份，变更需重启配置，旧向量不混用。

首次或正式池变化后最多一个后台构建任务；未就绪返回 `latent_building`，客户端稍后显式重试，不回退旧库。构建预算 120 秒，单次 HTTP 最多 8 秒，查询预算 10 秒；失败冷却 30 秒避免反复计费。网络不占正式写锁，协调写入前失效，发布索引及查询结束均重新核对整个正式池。归档、删除、隐藏、待审核记录不进入向量；召回计数不触发重建。来源和精确 blob 版本见 [UPSTREAM.md](float_latent_vendor/UPSTREAM.md)。真实供应商质量、速度、门槛仍需实测；本地只用虚构向量验证流程。

## 保留已部署的模型配置持久化

`float_provider_state.py` 把部署阶段的等价修复纳入新覆盖层：显式配置 `FLOAT_MODEL_ENV_PATH=/app/buckets/.float-model.env` 时，Dashboard env 写入映射到私有卷文件，限制 0600；启动时只把四个固定 provider key/baseURL 字段按数据解析，不执行 shell，并去除旧 model 环境覆盖，让原生 config.yaml 管理模型选择。未设置该变量时保留原生入口行为。新镜像入口最终仍执行原 `/app/entrypoint.sh`。

此文件含凭据，不进入代码或本工具正文备份；完整停服备份需另外保留私有卷与配置。新覆盖层已经包含此等价修复，不要再叠旧部署文字补丁；也不要以旧 env1 镜像作为原生基础镜像。现有失效供应商 key 不能靠更新镜像修复；由用户通过既有私密配置入口补填有效 key，再验证重启与原生索引管线，本任务不读取它。

## 停服备份与新目录恢复

`vault_backup.py` 在离线维护时备份正式 Markdown 与扩展 SQLite 状态，含导入原件及撤销记录，不含配置、密钥、聊天、其他原生状态或可重建索引。它不是完整服务器备份，也没有备份 GUI。先停用所有原生/扩展/外部写入者；发现扩展进程锁会拒绝备份。文件包含私人正文，应放在受控备份目录。

```sh
python vault_backup.py backup --vault /path/to/stopped-vault --out /private-backups/float-memory.tar.gz
python vault_backup.py verify /private-backups/float-memory.tar.gz
python vault_backup.py restore /private-backups/float-memory.tar.gz --to /path/to/new-unused-vault
```

归档检查路径、大小及 SHA-256；恢复目的目录必须尚不存在，不替换当前卷，不启动服务。验证恢复正文及审计完整性后，再由运维按原生流程重建派生索引、检查配置并安排切换。失败时保留新目录为未启用状态，不把部分恢复目录接入服务。不要丢弃原始整卷备份。

## 用量与仍需联调

Float 请求账本仅在本设备记录可观察请求的供应商/模型/来源/状态及接口返回 token，不保存提示词、正文、响应、地址、密钥或错误原文。累计 SSE 用量不重复相加，缺失显示未知；缓存和推理字段不会重复计入供应商总数。保留最多 90 天/20000 条，可筛选、导出和清空；既有调试日志不迁移或自动删除。它不是供应商账单或跨设备完整审计；VPS 内部模型、图片/音频调用和其他未接入路径不计入。不提供未经核实的费用估算；余额仅对已核实的 DeepSeek 官方直连配置开放手工查询，中转、硅基流动与 Codex 订阅限额显示不支持/未知。

旧版基础同库 API 已由部署聊天实测；新网关/语义召回仍待单独发布和真实供应商验收，手机界面和模型自动记忆决策链、真实 Orbis 文件也待验收。Dawn 主动生成及锁屏离线推送、完整备份界面、后台用量、其他余额/费用与微信共享适配仍未完成。共享模式不向旧本机事实表复制新记录；既有聊天上下文/调试日志不自动删除。微信云端助手共享模式拒绝导出另一个可写记忆副本。Codex 固定只读网关见 `tools/float-codex-gateway/README.md`。
