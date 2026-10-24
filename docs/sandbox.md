# embuddies 命令沙箱

状态：2026-10-24。两种模式：**标准**（Job Object，工作区可写）与**严格**（`WRITE_RESTRICTED` + capability SID，只限写工作区）。均免提权。

## 分层

| 层 | 做什么 | 状态 |
|---|---|---|
| **路径策略** | 文件工具只允许工作区内；跟随符号链接后越界即拒 | ✅ 已验证 |
| **命令策略** | 拒绝 `format`/`diskpart`/`shutdown`/`reg`/`net user`/`takeown`/`icacls` 等 | ✅ 已验证 |
| **环境剥离** | 子进程环境去掉 `API_KEY`/`SECRET`/`TOKEN`/`PASSWORD`/`EMBUDDIES_` | ✅ 已验证 |
| **Job Object（标准）** | 内存 512MB、进程数 32、`KILL_ON_JOB_CLOSE`、超时、进程树清理 | ✅ 已验证 |
| **WRITE_RESTRICTED + capability SID（严格）** | 只允许写工作区，读不受限 | ✅ 已验证 |
| **AppContainer** | 文件/网络级隔离 | ⚠️ 需提权，未采用 |

## 执行器

- 源码：`launcher/SandboxRunner.cs`
- 产物：`launcher/sandbox-run.exe`（构建脚本会编译并复制到包内 `bin/`）
- 调用：`runtime/sandbox-runner.mjs` → `runSandboxedCommand`
- 接入：`EmbuddiesRuntime` 的 `pwsh` 工具

命令行：

```
sandbox-run.exe --workspace <dir> [--timeout <ms>] [--mode auto|token|job|low|write] --command <powershell command>
```

| 模式 | 行为 |
|---|---|
| `auto`（标准默认） | 先试降权 token，失败回退 Job Object |
| `token` | 只用降权 token（失败返回 3） |
| `job` | 只用 Job Object |
| `low` | 低完整性 token（历史方案，见下方教训） |
| `write`（严格） | `WRITE_RESTRICTED` + capability SID |

## 严格模式原理（与 DSH 一致）

```
1. 派生 capability SID：
     workspace: S-1-4-<sha256(workspace)[0..4] % (2^30-1) + 1>-<...>
     temp:      S-1-4-<sha256("temp\0" + tempDir)[0..4] % ...>-<...>-1
2. CreateRestrictedToken(WRITE_RESTRICTED)
     restricting SIDs = [logon SID, Everyone, workspaceSid, tempSid]
     flags = 13 (DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED)
3. 合并 default DACL（logon + Everyone + workspaceSid + tempSid），不是替换
4. SetNamedSecurityInfoW 给工作区和私有 temp 各加 capability SID 的 allow ACE
     GRANT_MASK = 1114454（写/删/删子项，不含 WRITE_DAC/WRITE_OWNER）
5. 子进程的 TEMP/TMP 指向私有 temp 目录
6. CreateProcessAsUserW 启动（创建时不带 CREATE_NO_WINDOW）
7. 命令结束后删除私有 temp 目录
```

实测：

| 操作 | 结果 |
|---|---|---|
| 写工作区 | ✅ `WROTE` |
| 写桌面 | ✅ `BLOCKED` |
| 读桌面 | ✅ 可读 |
| 超时 | ✅ `124` |
| 非零退出 | ✅ 透传 |

工作区 ACL 只多一条 capability ACE，例如：

```
S-1-4-579379898-53248329:(OI)(CI)(W,D,DC)
```

## 教训：不要降级工作区的完整性

早期严格模式用「低完整性」：把工作区 `icacls /setintegritylevel L` 降为 Low，再让命令以 Low 运行。

**这有严重副作用**：Windows 的规则是**从 Low 完整性文件启动的进程，自身也以 Low 运行**。
一旦项目目录被降级，从里面启动的任何 exe（包括 `sandbox-run.exe` 自己）都会以 Low 运行，
而 Low 进程不能修改 Medium 对象的 ACL —— 于是 `SetNamedSecurityInfoW` 全部返回 5，
capability SID 方案被自己的降级行为破坏。

修复：

1. 不再降低工作区完整性。
2. 把被降级的目录恢复为 Medium：`icacls <dir> /setintegritylevel (OI)(CI)M`
3. 严格模式只走 capability SID。

## 标准模式 vs 严格模式

| | 标准 | 严格 |
|---|---|---|
| 命令能写工作区 | ✅ | ✅ |
| 命令写桌面/文档 | ✅（不拦） | ❌ 拒绝 |
| 读 | ✅ | ✅ |
| 网络 | ✅ | ✅ |
| 资源限制 | Job Object | Job Object |
| 免提权 | ✅ | ✅ |

## 已知限制

- **读隔离**：capability SID 只限制写，读不受限（DSH 的免提权后端也一样）。
- **网络隔离**：未做（需 WFP / 提权）。
- **ACL 残留**：capability ACE 会留在工作区（避免每次重写整棵树），换机器/换路径会留下惰性 ACE。
- **私有 temp 的撤销**：命令结束即删除目录，但 ACE 随目录一起消失；workspace 的 ACE 按设计保留。
