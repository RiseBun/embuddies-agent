# embuddies

Windows 组合式 Agent 工作台。Electron 提供桌面窗口、原生文件夹选择、托盘及随包 Chromium；隔离应用服务运行自带的 model-agnostic Agent 循环（Anthropic Messages / OpenAI Completions 双协议），不再绑定 OpenAI 模型或 Rust 内核。自行编译的 Rust 内核作为可选回退保留，不编译也能运行。前端使用 React、TypeScript 和 Vite，通过受限 preload IPC 通信。生产启动不依赖 Node、Rust、外部 CLI、WebView2、本地 HTTP 端口或外部浏览器。

## 本机启动

日常双击桌面或源码目录的 `embuddies` 快捷方式，也可双击 `start-embuddies.vbs`，启动时不显示终端。运行 `install-shortcuts.ps1` 可创建或修复桌面、源码目录和候选版快捷方式；它们使用统一的透明品牌图标。固定读取 `%LOCALAPPDATA%\embuddies\data`。`启动embuddies.cmd` 保留为显示错误的诊断入口，直接双击 CMD 文件会出现终端；日常使用上述快捷方式。修改前端后需重新构建，旧的候选包需重新打包才能包含修复。启动失败显示提示并写入 `%LOCALAPPDATA%\embuddies\logs\startup.log`。

开发隔离测试使用 `start-development.ps1`，数据位于 `%LOCALAPPDATA%\embuddies-development\data`。不同数据目录各自保留历史，不会自动合并。

## 本机候选版

双击源码目录的 `embuddies 候选版` 快捷方式，或使用 `wscript start-embuddies.vbs /candidate`。它打开 `native-engine/desktop-candidate.json` 指定的独立候选包，试用记录保存在 `%LOCALAPPDATA%\embuddies-candidate\data`，浏览器和加密配置使用独立 profile。`启动候选embuddies.cmd` 保留为诊断入口。首次使用在输入框旁配置 gc 或 Responses 兼容渠道并测试连接。

候选 exe、安装程序和便携 ZIP 位于 `E:/embuddies-build/desktop/candidates/<版本>-<候选 ID>/`。便携版解压后直接打开 `windows/embuddies.exe`；安装版使用独立候选安装身份，不覆盖原有正式安装。原数据与原正式包保持不变。候选试用入口使用数据副本；候选 exe 默认也使用 `%LOCALAPPDATA%\embuddies-candidate\data` 与独立 profile，不会触发原软件的单实例锁。正式版本仍使用 `%LOCALAPPDATA%\embuddies\data`，升级前须保留备份。

候选不等于正式发布。自动验收报告保存于候选目录与 `E:/embuddies-build/verification/`；未完成的门槛明确保留为失败或待验证，绝不按测试已启动就算通过。

## 产品能力

- 工作区管理项目目录及对话，未选择目录时自动创建本地项目目录。
- 对话、Skill、Agent、MCP 插件可以挂载到工作区，并固定资源版本。
- 任务记录保存输入、模型、资源快照、原生工具事件、审批、子 Agent、文件变化及结果。
- 历史对话只在明确保存为资源后进入资源库。结果可导出或保存为资源。
- 复用配置恢复原资源版本、模型、模式和权限，创建新对话；用户发起任务后才执行。
- 原生读写、终端、上下文压缩、Skill、MCP、子 Agent、取消和会话恢复。
- 应用内浏览器支持标签页、导航、元素快照、iframe、点击、输入、等待、截图及手动接管。写入操作进入审批，不自动重试。验证码、文件上传下载和全桌面控制不属于首版。
- 网页表单工具 `embuddies_web_form` 读取字段名称、类型、当前值、必填/只读状态及下拉选项；一次生成填写清单，批量执行并逐项读回核对。支持原生输入框、文本域、日期、单选下拉框、复选框、单选按钮与 iframe；React 受控表单在测试中通过。填写不自动提交，动态字段变化或校验不符时返回进度并停止。详见 [网页填表说明](docs/web-forms.md)。
- 模型渠道 model-agnostic：Anthropic Messages（含 DeepSeek 官方）与 OpenAI Completions / Responses 兼容 API 均可直接使用，不再写死 OpenAI 模型目录。旧 YAML 插件需转换为 MCP 配置。

本轮结束与结果已验证分开表达，不使用模型文本中的结束标记驱动任务状态。

## 数据与恢复

SQLite 事务保存工作区、资源版本、对话、任务、执行事件和原生会话映射。先提交，再确认保存。JSON 迁移前备份并核对，升级前备份 SQLite；原文件不删除。缺失项目目录不删除历史。损坏数据报错并保留诊断，禁止当成空历史。

Windows 密钥通过 Electron safeStorage 加密；迁移保留其加密主密钥，不退回明文。用户数据与上游 Codex 的配置分离。

应用服务崩溃由宿主管理恢复，界面崩溃重新创建窗口。内核中断保留执行记录，需明确新指令继续；文件操作、命令及网页操作不自动重复。模型认证、限流及网络错误只影响任务。诊断位于数据目录 `logs/`，日志隐藏密钥。

## 执行引擎

默认引擎是 `runtime/embuddies-runtime.mjs` 里的 model-agnostic 循环：Anthropic Messages 与 OpenAI Completions 双协议、24 轮工具循环、审批与读写权限、流式输出。它不依赖任何固定模型目录或 Rust 二进制，因此不编译原生内核也能运行。

Rust 内核（OpenAI Codex 基线 `aa380897f67b91e1a47d530d7286d497b6726d3f`，产品源 `embuddies-core/`，补丁 `native-engine/patches/embuddies.patch`）作为可选回退保留：设置 `EMBUDDIES_ENGINE=native` 时启用。构建候选时传入 `-NativeCandidate` 才会把内核打进包；不传则生成纯 model-agnostic 包。

如需自行构建原生内核：

```powershell
.\prepare-native-source.ps1
.\build-native-engine.ps1 -ToolRoot E:\embuddies-build
```

原生构建需要 Rust 1.95.0、MSVC x64 与 Windows SDK。保留 Apache 2.0 开源声明、原作者及必要内部协议名。

## 前端开发与验证

```powershell
npm ci --prefix runtime
npm ci --prefix frontend
npm ci --prefix desktop
npm run build --prefix frontend
.\start-development.ps1
```

开发入口使用独立开发数据目录，选取已编译且通过哈希校验的内核；没有内核或前端产物时明确报错。

```powershell
npm test --prefix runtime
npm run lint --prefix runtime
npm run format:check --prefix runtime
npm run verify:ui --prefix runtime
npm run verify:desktop-recovery --prefix runtime
npm run verify:branding --prefix runtime
npm run verify:web-form --prefix runtime
node runtime/scripts/verify-desktop-pet.mjs
$env:EMBUDDIES_NATIVE_EXECUTABLE = '<已编译的 embuddies-runtime.exe>'
npm run verify:native-runtime --prefix runtime
```

`verify:native-runtime` 覆盖原生工具、资源分支、认证失败、取消、子 Agent、会话恢复及压缩。Rust 检查遵循源码仓库的 `just test`、`just fmt` 和 `just fix` 要求。

`verify-desktop-pet.mjs` 使用隔离数据验证真实 Electron 窗口的透明像素、呼吸眨眼、鼠标坐标、减少动态效果偏好、拖动及双击打开工作台。报告和截图保存在 `.tmp/pet-verification/`；设置 `EMBUDDIES_TEST_CANDIDATE` 为候选包的 `windows` 目录可验证打包版本。

## 构建候选与验收

```powershell
.\build-windows.ps1 -NativeCandidate '<原生候选目录>' -SkipArchive -SkipInstaller
$env:EMBUDDIES_TEST_CANDIDATE = '<桌面候选 windows 目录>'
npm run verify:windows-bundle --prefix runtime
$env:EMBUDDIES_TEST_FAULTS = '1'
$env:EMBUDDIES_TEST_PERMISSIONS = '1'
npm run verify:native-desktop --prefix runtime
node runtime/scripts/verify-native-platform.mjs
```

完整稳定性检查：

```powershell
$env:EMBUDDIES_FULL_ACCEPTANCE = '1'
npm run verify:native-desktop --prefix runtime
```

完整检查执行 30 次冷启动、至少 100 次状态查询、10 次内核中断恢复和 2 小时实际任务持续运行。测试期间更新 `progress.json`，结束后才生成通过报告。`verify-native-gc-desktop.mjs` 使用已有密钥的加密副本，在独立项目中完成真实 gc 文件读写、验证及重启会话恢复，原数据只读。

```powershell
.\package-candidate.ps1 -CandidateRoot '<候选 windows 目录>'
node runtime/scripts/verify-native-installer.mjs
```

安装版和便携版从同一不可变候选包生成；先核对所有文件哈希。安装验收使用独立安装身份、目录与数据，卸载后保留数据。

正式切换还要求干净 Windows 10/11 x64 验收。目前没有这两个环境，继续保留候选，不调用正式发布脚本。CI 对固定源码、React 前端和实际候选包执行检查，CI 尚须在远程环境实际运行后才能宣称通过。
