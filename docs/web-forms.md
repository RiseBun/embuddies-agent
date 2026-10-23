# 网页填表

目标是让 Agent 根据用户提供的资料填写网页中的真实字段。模型负责理解字段与资料的对应关系；浏览器负责执行填写和读回校验。执行层使用 Chromium 的 DOM 与无障碍树，不需要逐字段截图或调用视觉模型。

## 使用

开发版启动后，在工作台的「浏览器」中打开目标网页，登录后交还 Agent。在同一工作区发起任务，例如：

> 根据以下资料填写当前网页的申请表。没有提供的信息先询问我。填写完成后检查，提交前停下。资料：……

现有候选包不会因源码修改自动更新；通过 `启动embuddies.cmd` 打开源码开发版，或重新构建候选包后使用。

## 工具调用

`embuddies_browser` 负责打开网页与导航。新增 `embuddies_web_form` 负责填表：

1. `observe(tabId)`：返回 `version` 和字段列表，每项包含 `ref`、名称、类型、当前值、可用动作、必填状态；原生下拉框还包含选项的标签与值。
2. `fill(tabId, version, fields)`：传入 `[{ref, value}]`，一次审批覆盖这一份明确清单，随后顺序填写、触发 input/change 事件并读回核对。下拉框传选项的 `value`，日期使用 `YYYY-MM-DD`。
3. `act(tabId, version, ref, operation, value?, expected?)`：支持 `set_value`、`toggle`、`select`、`invoke`。复选框用 `toggle` 并核对 `checked`；单选按钮用 `select`；按钮用 `invoke`。
4. `verify(tabId, ref, expected)`：重新观察并核对指定控件的值或状态。

每批最多 100 个字段，每个值最多 10000 字符。批次在 20 秒边界检查是否停止；一个正在执行的浏览器命令可能使实际耗时超过此边界。完成数、未执行的 `remaining`、结果不确定的 `uncertainRef` 和最新快照分别返回。继续前重新观察，只处理尚未执行的字段。已尝试但读回不符的字段保留在 `completed` 中且 `verified:false`，需检查原因。

提交必须单独调用按钮的 `invoke`。返回 `dispatched` 只代表发送了操作；`verified` 表示指定字段值/状态符合预期，不代表服务端已接收或业务办理完成。提交后的成功状态需另行读取验证。

## 验证与边界

运行 `node runtime/scripts/verify-web-form.mjs`，使用独立 Chromium profile 和本地测试网页，覆盖 63 字段长表单、原生下拉框、日期、多行文本、复选框、独立渲染进程中的跨域 iframe、React 受控字段与提交状态，以及过期引用、动态字段、值被应用改写和手动接管。测试不会访问真实网站或提交真实数据。

目前只控制应用内浏览器，不能接管用户已打开的 Chrome/Edge 标签页。密码、文件上传、验证码、无可访问结构的自绘控件，以及依赖可信键盘事件的页面需要人工或额外适配。快照最多 300 个可见语义节点、24 个 frame；`truncated:true` 表示不完整。尚未验证真实目标网站的字段匹配准确率、跨页流程或服务器校验。
