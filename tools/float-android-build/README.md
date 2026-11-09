# Float 本任务隔离 Android 测试构建

此入口服务于本机测试 APK，不改变系统 Java/PATH，不安装手机 APK，不访问 VPS，也不读取现有签名环境变量。phase13 的冻结 ZIP 不因新增此工具而重打。

## 已验证与待完成

- 已准备官方 Temurin 17.0.21+9 与 Gradle 8.11.1，核对 SHA-256 并实际运行。
- `test_local_build.py` 的 7 组离线测试通过，包括许可前零下载、宿主环境不枚举/不读签名变量、HTTPS 站点限制、归档越界/符号链接/Windows长路径、子进程失败。
- phase14 曾实际调用 `build` 验证缺少许可时退出码 3。之后用户明确接受本次本机测试所需 SDK 许可，才建立任务私有确认记录并下载/安装 SDK；sdkmanager实际提示的标准android-sdk-license逐项核对后确认，未使用批量yes或复制许可标记。
- phase15 已安装 SDK 命令行工具、platform 36 revision2、build-tools 35.0.0；Gradle另自动安装platform-tools37.0.1，未运行adb或访问设备。
- `assembleDebug` 实际成功，Kotlin/Java/DEX/打包通过，无需修改Android源码。APK验签及包名/版本/站点/权限检查通过；使用本任务新生成调试签名，旧签名兼容性未知，没有手机安装/SAF真机验收。

## 工具来源

- JDK：Adoptium 官方固定 release，版本和 SHA-256 存于任务目录 `official-lock.json`。
- Gradle：<https://services.gradle.org/distributions/gradle-8.11.1-bin.zip>，SHA-256 `f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6`。
- SDK：<https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip>，已核对官方 SHA-256 `90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a`，以任务JDK17实际运行成功。
- SDK 许可：<https://developer.android.com/studio/terms> 第 2.1–2.2 条要求同意后才能使用；官方下载页 <https://developer.android.com/studio#command-tools> 要求下载前同意。必须先得到用户本人明确接受，不能把“继续工作”默认当作接受协议。

## 运行入口

在仓库根目录运行，`TASK_ROOT` 指本任务的 `work/android-toolchain` 绝对路径：

```text
python -X utf8 -B -m unittest discover -s tools/float-android-build -p test_local_build.py -v
python -X utf8 -B tools/float-android-build/local_build.py status --toolchain-root TASK_ROOT
```

`status` 仅验证已准备的 JDK/Gradle 存档并运行 Gradle 版本检查，不下载或使用 SDK。`sdk-prepare`、`sdk-install`、`build` 均要求 `--consent-record`；确认记录只能在用户实际接受后建立，程序不会生成记录或许可哈希，也不使用批量 `yes`/`--licenses`。

顺序为 SDK 官方存档校验、检查工具所需 Java 版本、安装稳定 SDK 包、`assembleDebug`。SDKmanager 的真实许可提示必须逐项核对；其他许可不在当前标准 Android SDK 确认范围内。若包版本或工具不兼容，按真实错误处理，不改用不明 SDK 镜像。Windows解压使用进程内长路径前缀，不改系统注册表；解压全部完成才写本任务校验标记，失败后不会跳过半成品。

进程环境使用允许名单，仅为本进程设置 JDK/SDK/Gradle 路径。Gradle 缓存、Android 用户目录、Java 用户目录和临时文件放在任务目录，Java 属性对包含空格的路径有引号。`SHELL_KEYSTORE_*`、任意宿主 JVM/Gradle 参数不传入。未来新调试密钥留在任务私有目录，不随交付或源码打包。

默认站点为 `https://float.fanqielove.duckdns.org`。只允许无凭据、无路径/查询/片段的 HTTPS 根地址及标准端口。不会调用部署或设备安装命令。

## APK 完成条件

`assembleDebug` 成功仅生成待验签结果 `build-result.json`。再执行本地验签导出入口：

```text
python -X utf8 -B tools/float-android-build/verify_apk.py --toolchain-root TASK_ROOT --apk ABSOLUTE_BUILD_APK --outdir ABSOLUTE_OUTPUT_DIR --stage phase15
```

`verify_apk.py` 使用官方apksigner核验签名和公开证书SHA-256；aapt2核对包名、版本、compile/min/target SDK、debuggable与备份标志，逐项比较实际合并XML权限和源码（只允许额外的AndroidX signature-only接收器权限），分列旧WRITE_EXTERNAL_STORAGE max28导致的平台隐含READ max28，不把隐含项混成新增声明。另检查站点与六个目录桥方法实际存在DEX、APK无私钥文件、ZIP完整性及复制前后SHA-256。全部通过才以不覆盖方式导出APK和公开manifest，私有签名密钥不导出。

未知旧包签名时不得声称能够覆盖安装，也不得用卸载清数据解决。已编译和验签只代表构建产物通过，不代表手机运行验收。

phase14 网页新增默认关闭、需明确选目录并逐轮启用的受控 AI 工具原型，假 Native 与三模型协议验证通过；实际设备的原生构建与 SAF 验收仍未完成，不能把网页模拟结果称作手机已可用。正式验收仍依赖实际 APK 和人工真机验证。
