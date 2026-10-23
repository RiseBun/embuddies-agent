# embuddies 应用服务

生产入口为 `utility-entry.mjs`，运行于 Electron utilityProcess；`application-service.mjs` 处理工作区、资源、对话、审批和任务保存。`native-runtime.mjs` 通过 `native-engine-client.mjs` 的 stdio 协议调用自编译 Rust 内核，Agent 主循环由原生内核承担。

`record-database.mjs` 提供 SQLite 事务、迁移备份及逐条执行事件。`native-capabilities.mjs` 将固定版本资源转换为 Skill、Agent 和 MCP 配置；`native-request-broker.mjs` 处理原生审批及补充信息。浏览器由桌面宿主的随包 Chromium 提供，通过 `native-browser.mjs` 注册为原生动态工具。

打包由 `scripts/stage-native-runtime.mjs` 计算生产入口的模块依赖，禁止旧自制 Agent 循环进入发行包。`server.mjs` 仅提供开发 HTTP 适配器，不参与桌面生产通信。历史参考执行器仍留在源码中以便核对旧数据测试，生产包不包含它们。

完整启动、构建与验收流程见根目录 README.md。
