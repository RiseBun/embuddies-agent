# embuddies 自进化框架（RSI）设计

> 目标：让 embuddies 成为「活在自己里面、能有限度进化自己」的工作台——既能进化前端、能力、插件、技巧，又把安全、证据、回滚焊死在比它更低的一层。

## 0. 核心原则

把「改进自己」做成和「读写文件」一样的一等公民能力；但「安全」「证据」「回滚」属于更低的、agent 永远碰不到的层。**agent 可以在受限、可验证、可撤销的沙箱里进化自己，却永远改不掉自己的笼子。**

## 1. 进化面分层（Evolution Surface）

| 层 | 内容 | 风险 | 默认审批 |
|---|---|---|---|
| E3 能力面 | Skill / 插件 / 提示词 / 填表规则 / 资源 | 低 | 测试通过即自动合入 |
| E2 表现面 | 前端组件 / 样式 / 交互 / 文案 | 中 | 人工审 diff 或严格自动审 |
| E1 内核面 | 运行时工具 / Agent 循环 / 模型抽象 | 高 | 强制人工逐行审 |
| E0 免疫核心 | 审批 / 加密 / 沙箱 / 单实例 / 自进化循环本身 | 最高 | 双人确认 + 独立流程 |

「眼前一亮」的主战场在 E3 + E2，而这两层恰好最安全，可放开更多。

## 2. 进化循环（The Loop）

```
Observe → Propose → Isolate → Verify → Review → Apply → Learn
```

- **Observe**：从对话、日志、测试失败、用户抱怨里提炼「该改什么」。
- **Propose**：生成改进意图 + 预期收益 + 影响范围。
- **Isolate**：在 git worktree / 临时分支里改，绝不碰运行中的活代码。
- **Verify**：tsc + vitest + eslint + 打包 + 冒烟，产出硬证据。
- **Review**：展示 diff + 测试结果 + 风险分级（复用审批卡）。
- **Apply**：git commit + 版本记录，可一键回滚。
- **Learn**：结果写进记忆，失败沉淀教训供下轮 Observe。

**证据原则**：审批展示的是「跑了多少测试、通过多少、diff 动了哪些文件」，不是模型的自述。模型的话不算证据。

## 3. 免疫核心（Immutable Core）

自改进系统默认连读都受控、改写必走 E0 流程的路径：

- `desktop/main.cjs` 的审批段、safeStorage 加密段
- `approval-broker.mjs` / `native-request-broker.mjs`
- `secret-store.mjs`
- 沙箱与权限策略（`permissions/`）
- **自进化循环自身的代码**

实现：`immutable-core.json` 清单 + 校验器；提案命中清单路径即升级为 E0 最高危流程。

## 4. 信任分级（Trust Tiers）

| 层 | 触发 | 处理 |
|---|---|---|
| T0 免疫 | 命中 E0 | 拒绝自动，双人确认 |
| T1 高危 | E1 + 改签名/协议 | 人工逐行审 |
| T2 中危 | E2 + 改运行时行为 | 人工审 diff |
| T3 低危 | E3 + 纯增量 + 测试全绿 | 自动合入并记录 |

信任是挣来的：连续失败/被拒则降权，历史干净且成功可申请升权（仍受 E0 上限）。

## 5. 安全不变量

1. **隔离**：worktree/分支，运行中的 runtime 只读；失败即丢弃。
2. **证据驱动**：无「测试通过 + diff 可查」就无合入资格。
3. **预算上限**：每次进化最多改 M 文件、N 轮、T 分钟，超限即停。
4. **可回滚**：每次 Apply 一个 commit，一条命令回退。
5. **全量审计**：提案/证据/决定/结果/来源全落 SQLite。
6. **Kill Switch**：人类可见的「冻结自进化」开关，一键退化成只读 agent；该开关不在 E0 清单、只属于人类。

## 6. 数据模型

```
evolution_proposals (id, source, intent, tier, impact_scope, status, created_at)
evolution_evidence  (proposal_id, kind, detail)
evolution_decisions (proposal_id, actor, decision, reason, applied_commit, rollback_of)
```

配合 `record-database.mjs` 事务，提案—证据—决定原子落库。

## 7. 前端呈现（Evolution UI）

- 进化时间线：像 commit 历史，每条是 agent 自己写的 changelog + 理由 + 前后对比。
- 提案卡：diff 摘要 + 测试徽章 + 风险分级色 + 「应用/拒绝/调整」。
- 记忆面板：可读可编辑。
- 状态行：「它正在给自己加一个 skill，测试 14/14 通过」。

## 8. 对话驱动进化

Observe 阶段加 **Reflector**：任务结束后静默问模型「刚才对话暴露了我缺什么能力/哪做得差/能沉淀成什么 skill」，产出「进化意图」进 backlog，不立即动手，等确认或攒够触发。

## 9. 分阶段落地

| 阶段 | 内容 | 验收 |
|---|---|---|
| A | `self-improve` 任务流 + worktree 隔离 + 测试证据 + 提案审批卡 + 人工合并 | 让它「给自己加个 skill」，全程自己跑、人点头 |
| B | 三张表 + 时间线 UI + 一键回滚 | 能查证据、能退回 |
| C | E3 信任分级 + 自动合入 + 免疫核心校验器 | skill/插件测试通过自动落 |
| D | Reflector + 进化 backlog + 夜里学习 | 它主动说「我该补 X」 |
| E | 允许改 E1 内部分，E0 永锁（默认关） | 谨慎灰度 |

## 10. 边界

「完全自主进化」没有安全实现——「关掉它的开关」也可能被它改掉。因此：放开 E3/E2，E1 谨慎、E0 永锁，信任靠挣。
