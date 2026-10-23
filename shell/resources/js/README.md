# 前端结构

前端按职责拆成四个模块，`main.js` 只负责装配和窗口生命周期：

- `agent-client.js`：只处理本地运行层 HTTP 请求。
- `local-store.js`：只处理颜色、大小和历史对话的本地存储。
- `pet-controller.js`：只处理embuddies动画、眼睛跟随、点击、双击、拖拽和眩晕反馈。
- `panel-controller.js`：处理聊天、历史对话、设置表单和运行状态。
- `run-activity.js`：渲染单次任务的工具过程、审批和最终结果。
- `main.js`：连接 Neutralino、模块和窗口尺寸，不承载业务细节。

新增交互或设置时，优先修改对应模块，不要继续把逻辑堆回 `main.js`。

