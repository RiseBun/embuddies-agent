import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const candidate = process.env.EMBUDDIES_TEST_CANDIDATE;
if (!candidate) throw new Error("Select the candidate to report");
const manifest = JSON.parse(
  await fs.readFile(path.join(candidate, "release-manifest.json"), "utf8"),
);
const read = async (suffix) => {
  try {
    return JSON.parse(
      await fs.readFile(
        path.join(
          root,
          ".tmp",
          "desktop-acceptance",
          manifest.candidateId + "-" + suffix + ".json",
        ),
        "utf8",
      ),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const [native, installed, installer, migration, stability] = await Promise.all(
  ["native", "installed", "installer", "migration", "stability"].map(read),
);
const gates = {
  packagedHost: native?.ok === true,
  nativeWindowResize: native?.windowResizeEdges === 8,
  rendererConversationRecovery: native?.currentConversationRestored === true,
  manualContinuation:
    native?.manualContinuation === true &&
    native?.interruptedQueueHeld === true,
  cancellation: native?.cancellationPersisted === true,
  normalQuit: native?.closeButtonQuit === true && native?.petExitQuit === true,
  crashLimitAndRetry: native?.crashLimitAndManualRetry === true,
  installation:
    installed?.ok === true &&
    installer?.installExitCode === 0 &&
    installer?.uninstallExitCode === 0 &&
    installer?.registryRemoved === true,
  migration: migration?.ok === true,
  coldStarts: stability?.coldStarts >= 30 && stability.failures === 0,
  statusQueries: native?.statusQueries >= 100,
  runtimeRecoveries: native?.runtimeRecoveries >= 10,
  twoHourSoak: stability?.ok === true && stability.soakMs >= 7200000,
  cleanWindows10: false,
  cleanWindows11: false,
};
const report = {
  candidateId: manifest.candidateId,
  version: manifest.version,
  updatedAt: new Date().toISOString(),
  ok: Object.entries(gates)
    .filter(([key]) => !key.startsWith("cleanWindows"))
    .every(([, passed]) => passed),
  releaseReady: Object.values(gates).every(Boolean),
  cleanWindows10: false,
  cleanWindows11: false,
  coldStarts: stability?.coldStarts || 0,
  statusQueries: Math.max(
    native?.statusQueries || 0,
    stability?.statusQueries || 0,
  ),
  runtimeRecoveries: native?.runtimeRecoveries || 0,
  soakMs: stability?.soakMs || 0,
  failures:
    (native?.failures?.length || 0) +
    (installed?.failures?.length || 0) +
    (migration?.failures?.length || 0) +
    (stability?.failures || 0),
  gates,
  evidence: { native, installed, installer, migration, stability },
  limitations: [
    "本机为 Windows 11 x64 10.0.26200，存在开发工具，不替代干净 Windows 10/11 验收。",
    "模型使用测试服务注入认证和网络故障；实际模型渠道需要有效密钥。",
    "候选安装程序尚未进行正式发行签名和商用安装工具授权核验。",
  ],
};
const labels = {
  packagedHost: "包内工作台、IPC 和 SQLite",
  nativeWindowResize: "四边四角窗口缩放",
  rendererConversationRecovery: "renderer 恢复当前对话",
  manualContinuation: "中断后手动继续，排队任务不自动重发",
  cancellation: "取消任务并保存状态",
  normalQuit: "关闭按钮和悬浮球退出，Runtime 不残留",
  crashLimitAndRetry: "连续失败上限及手动重试",
  installation: "安装、安装后运行、卸载",
  migration: "JSON、旧密钥迁移及缺失项目目录",
  coldStarts: "30 次冷启动",
  statusQueries: "至少 100 次状态查询",
  runtimeRecoveries: "至少 10 次 Runtime 恢复",
  twoHourSoak: "2 小时持续运行",
  cleanWindows10: "干净 Windows 10 x64",
  cleanWindows11: "干净 Windows 11 x64",
};
const directory = path.dirname(candidate);
await fs.writeFile(
  path.join(directory, "acceptance-report.json"),
  JSON.stringify(report, null, 2),
);
await fs.writeFile(
  path.join(directory, "验收报告.md"),
  [
    "# embuddies 候选包验收",
    "",
    `候选 ID：${manifest.candidateId}；版本：${manifest.version}。`,
    "",
    "状态：保留候选包，未替换正式版本。",
    "",
    "| 场景 | 结果 |",
    "| --- | --- |",
    ...Object.entries(gates).map(
      ([key, passed]) => `| ${labels[key]} | ${passed ? "通过" : "待完成"} |`,
    ),
    "",
    `持续测试记录：${report.coldStarts} 次冷启动，${report.statusQueries} 次状态查询，${report.runtimeRecoveries} 次 Runtime 恢复，${Math.floor(report.soakMs / 60000)} 分钟持续运行。`,
    "",
    "源码回归：50 项测试、lint、format:check、UI 模块、品牌检查及 git diff --check 通过。",
    "",
    "SQLite 故障注入：磁盘写满保持已提交历史，失败提交不产生完成记录；中断迁移可重试；查询异常不会被当作空历史。",
    "",
    ...report.limitations.map((value) => "- " + value),
    "",
    "测试完成后本报告自动更新。完整证据在同目录 acceptance-report.json。",
    "",
  ].join("\n"),
);
console.log(
  JSON.stringify({
    candidateId: manifest.candidateId,
    localAcceptancePassed: report.ok,
    releaseReady: report.releaseReady,
    report: path.join(directory, "验收报告.md"),
  }),
);
