# Phase15：实际 Android 构建和验签

2026-11-09。用户本人明确接受 Android SDK 许可，限定本次本机测试构建所需下载、安装和许可确认。随后使用任务目录内官方工具完成实际APK；不修改phase13/phase14冻结包，不触碰VPS、真实模型或手机，不安装/卸载App、打开权限或读取私人文件。

## 实际结果

- Temurin17.0.21+9、Gradle8.11.1；官方固定存档SHA-256已验证。
- 官方command-line tools15859902存档SHA-256验证后提取，运行sdkmanager核对并确认同一标准android-sdk-license。
- 安装platform android-36 revision2、build-tools35.0.0；Gradle自动安装所需platform-tools37.0.1。没有运行adb或连接设备。
- `assembleDebug` 成功，36项任务执行，Kotlin/Java/DEX/资源/签名/打包均通过。原生源码相对phase13/phase14没有修改；现有未使用参数和deprecated API等编译警告保留，不扩散修改。
- 实际APK：`app.floatphone.shell`，versionName1.0.30、versionCode29；compileSdk36、targetSdk34、minSdk26。
- 站点为`https://float.fanqielove.duckdns.org`，已在编译DEX中核对；ScopedFilesBridge及六个固定桥方法也实际存在。
- 大小6233261 bytes，SHA-256 `79be60256ef6e15273dc88338bb47bc4acf3d980ddb45b80ff9aa86c6e456dd5`。
- 官方apksigner实际verify成功，单签名者，v2=true。公开证书SHA-256 `351389dd01e2248f1d5390e1a5360c74525838ba7b1388ac7b8e72995278fb0e`。

此包是**新任务调试签名**，debuggable=true。新生成的私钥留在任务私有Android用户目录，不导出，也未读取现有发布签名。现有手机App签名未知，不能保证覆盖兼容；不得以卸载清数据解决。

## 必要构建工具修复

官方SDK依赖文件名在当前长工作区路径触发Windows MAX_PATH。解压入口改为任务内长路径前缀，不改系统注册表或全局PATH；校验整份ZIP不含越界/符号链接，再解压，全部成功后才写完成标记。中途失败没有标记，下次不会把半成品当成功。7组离线测试（含真实长路径提取/清理）通过。

新增`verify_apk.py`：先用实际官方工具验签和检查产物，再导出APK+公开manifest；拒绝已有同名输出，复制后复核哈希。支持所安装aapt2的minSdkVersion及布尔/十六进制输出格式，检查实际XML权限，避免将badging附带的平台隐含项错误当成声明。

实际合并权限与源码逐项一致，原`WRITE_EXTERNAL_STORAGE`仍限maxSdk28；aapt2报告其隐含READ也仅限28，没有显式READ_EXTERNAL_STORAGE或MANAGE_EXTERNAL_STORAGE声明。AndroidX增加的固定接收器权限已经检查为signature-only。自动备份false，未因构建新增或授予设备权限。

## 交付边界

phase15独立固定源码包包含phase14默认关闭的网页AI工具原型、构建工具修复、验签入口与说明。Android和后端overlay源码均不变；只读/新建、不覆盖、不跨生活区、不做网络文件执行回退的边界不变。

APK与源码分开交付；源码包不含SDK/JDK/Gradle存档、缓存、APK、调试密钥、许可确认私有记录、真实数据或凭据。公开APKmanifest只有包信息、哈希、公开证书与权限状态。Web生产构建/三协议及界面验证沿用完全未改的phase14源码结果；没有为了构建工具改动反复跑无关测试。

仍未通过真实Android提供器/设备运行/桥nonce/目录授权/SAF撤权等人工验收；API工具往返仍是合成模型/Native测试。新APK加载的是服务器当前网页，本地phase14/phase15网页代码没有由本任务部署；不能据此称线上AI目录已启用。后续部署需另外比对服务器、备份和保留env/卷，再保留默认关闭。
