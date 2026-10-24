import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EmbuddiesRuntime } from "./embuddies-runtime.mjs";
import {
  createEvolutionToolPolicy,
  evolutionTier,
} from "./self-improve-policy.mjs";
import {
  applyWorktree,
  computeDiff,
  createProposalStore,
  createWorktree,
  rejectWorktree,
  repositoryHead,
  selfImproveRoot,
  verify,
} from "./self-improve.mjs";

function selfImprovePrompt(intent) {
  return `你是 embuddies 的自改进模式。当前工作区是源码的隔离副本。
请先检查相关文件，再直接修改，实现下面的意图。
只允许修改 frontend/src 内前端源码、docs 下的文档，或 runtime/starter-skills 下的 Markdown。
新增 Skill 必须放在 runtime/starter-skills/<名称>.md，包含一级标题和明确的使用说明；合入后自动进入资源库。
只提供文件工具，不提供命令、浏览器或本机控制；不能修改内核、安全核心和 Git 元数据。
保持改动最小，不需要提交；系统计算 diff 和基础检查，最后由用户决定是否应用。
若无法完成，如实说明。你的说明不作为验证证据。
改进意图：${intent}`;
}

export function createSelfImproveService({
  configStore,
  dataRoot,
  engine = new EmbuddiesRuntime(configStore),
  maxFiles = 50,
  maxCalls = 100,
  maxDurationMs = 10 * 60_000,
  repoRoot = selfImproveRoot,
}) {
  const store = createProposalStore(dataRoot);
  const freezeFile = path.join(dataRoot, "evolution-frozen");
  let active = null;
  let run = null;
  let deciding = false;
  let inFlight = null;
  let closed = false;

  async function frozen() {
    try {
      await fs.access(freezeFile);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  function validateIntent(intent) {
    if (closed) throw new Error("自改进服务已关闭");
    if (typeof intent !== "string" || !intent.trim())
      throw new Error("改进意图不能为空");
    if (intent.length > 8000) throw new Error("改进意图不能超过 8000 字符");
    if (active || deciding)
      throw new Error("已有自改进任务正在执行或应用，请稍候");
  }

  async function start({ intent }) {
    validateIntent(intent);
    const controller = new AbortController();
    const sessionId = `evo-${crypto.randomUUID()}`;
    active = { controller, sessionId };
    run = {
      id: sessionId,
      intent: intent.trim(),
      status: "running",
      startedAt: new Date().toISOString(),
    };
    const timer = setTimeout(() => {
      controller.abort(new Error("自改进超过时间预算，已停止"));
      Promise.resolve(engine.cancel?.(sessionId)).catch(() => {});
    }, maxDurationMs);
    let worktree;
    try {
      if (await frozen()) throw new Error("自进化已冻结，请先恢复");
      const config = await configStore.read();
      if (!config.active?.apiKey) throw new Error("请先配置模型 API Key");
      controller.signal.throwIfAborted();
      worktree = await createWorktree({ repoRoot });
      const result = await engine.run(selfImprovePrompt(intent.trim()), {
        sessionId,
        workspace: worktree.dir,
        permissionMode: "workspace-write",
        channel: config.active,
        signal: controller.signal,
        toolPolicy: createEvolutionToolPolicy(worktree.dir, {
          maxCalls,
          onBudgetExceeded: () =>
            controller.abort(new Error("自改进工具调用预算已用尽")),
        }),
      });
      controller.signal.throwIfAborted();
      if (result.toolRoundLimitReached)
        throw new Error("自改进达到模型循环预算，已停止并丢弃未完成改动");
      const head = await repositoryHead(worktree.dir);
      if (
        head.commit !== worktree.baseCommit ||
        head.branch !== worktree.branch
      )
        throw new Error("隔离分支基线发生变化，已停止并丢弃改动");
      const diff = await computeDiff(worktree.dir);
      const evidence = await verify(worktree.dir, {
        signal: controller.signal,
        maxFiles,
      });
      controller.signal.throwIfAborted();
      const tier = evidence.files.length ? evolutionTier(evidence.files) : "E3";
      const oversized = evidence.changedCount > maxFiles;
      const blockedReasons = [];
      if (!evidence.changedCount || !diff.trim())
        blockedReasons.push("没有产生代码改动");
      if (!evidence.ok) blockedReasons.push("基础检查未通过");
      if (oversized) blockedReasons.push(`改动超过 ${maxFiles} 个文件的预算`);
      if (!["E2", "E3"].includes(tier))
        blockedReasons.push(`${tier} 内核或安全核心改动，必须使用独立人工流程`);
      const proposal = await store.add({
        intent: intent.trim(),
        tier,
        ...worktree,
        sessionId,
        diff,
        evidence,
        oversized,
        blockedReasons,
        finalResponse: result.finalResponse || "",
      });
      run = { ...run, status: "completed", proposalId: proposal.id };
      worktree = null;
      return { proposal: publicProposal(proposal) };
    } catch (error) {
      run = { ...run, status: "failed", error: error.message };
      if (worktree) {
        try {
          await rejectWorktree({ repoRoot, ...worktree });
        } catch (cleanupError) {
          run.error += `；隔离目录清理失败：${cleanupError.message}`;
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
      active = null;
      run = { ...run, finishedAt: new Date().toISOString() };
    }
  }

  // Return immediately: desktop requests otherwise time out after 35 seconds.
  function launch(input) {
    validateIntent(input.intent);
    inFlight = start(input);
    inFlight.catch(() => {}); // start records failures for list().
    return { run: { ...run } };
  }

  async function decide({ id, decision }) {
    if (!["apply", "reject"].includes(decision))
      throw new Error("决定必须是 apply 或 reject");
    if (active || deciding)
      throw new Error("已有自改进任务正在执行或应用，请稍候");
    deciding = true;
    try {
      const proposal = (await store.list()).find((p) => p.id === id);
      if (!proposal) throw new Error("提案不存在");
      if (proposal.status !== "pending") throw new Error("提案已处理");
      if (decision === "apply") {
        if (await frozen()) throw new Error("自进化已冻结，不能应用提案");
        if (
          !proposal.evidence?.ok ||
          proposal.oversized ||
          proposal.blockedReasons?.length ||
          !proposal.diff?.trim()
        )
          throw new Error("提案不满足应用条件，请查看检查结果并拒绝后重新生成");
        if (!proposal.baseCommit || !proposal.baseBranch)
          throw new Error("旧提案缺少源码基线，请拒绝并重新生成");
        const head = await repositoryHead(proposal.dir);
        if (
          head.commit !== proposal.baseCommit ||
          head.branch !== proposal.branch
        )
          throw new Error("隔离分支基线已改变，请拒绝并重新生成");
        const evidence = await verify(proposal.dir, { maxFiles });
        if (
          !evidence.ok ||
          evidence.changedCount > maxFiles ||
          !["E2", "E3"].includes(evolutionTier(evidence.files))
        )
          throw new Error("重新检查未通过，不能应用");
        const result = await applyWorktree({
          repoRoot,
          branch: proposal.branch,
          dir: proposal.dir,
          baseCommit: proposal.baseCommit,
          baseBranch: proposal.baseBranch,
          expectedDiff: proposal.diff,
          message: `evo: ${proposal.intent.slice(0, 80)}`,
        });
        await store.decide(id, "applied", {
          appliedCommit: result.commit,
          cleanupError: result.cleanupError,
        });
      } else {
        await rejectWorktree({
          repoRoot,
          branch: proposal.branch,
          dir: proposal.dir,
        });
        await store.decide(id, "rejected");
      }
      return { ok: true, id, decision };
    } finally {
      deciding = false;
    }
  }

  async function setFrozen(value) {
    if (typeof value !== "boolean") throw new Error("冻结状态必须是布尔值");
    if (deciding) throw new Error("正在完成提案决定，请稍后冻结");
    if (value) {
      await fs.mkdir(dataRoot, { recursive: true });
      await fs.writeFile(freezeFile, "frozen\n", "utf8");
      active?.controller.abort(new Error("用户已冻结自进化"));
      if (active) await engine.cancel?.(active.sessionId);
    } else await fs.rm(freezeFile, { force: true });
    return { frozen: value };
  }

  async function list() {
    return {
      proposals: (await store.list()).map(publicProposal),
      run: run ? { ...run } : null,
      frozen: await frozen(),
    };
  }

  async function close() {
    closed = true;
    active?.controller.abort(new Error("应用关闭，自改进已停止"));
    if (active) await engine.cancel?.(active.sessionId);
    await inFlight?.catch(() => {});
    await engine.close?.();
  }

  return { start, launch, decide, list, setFrozen, close };
}

function publicProposal(proposal) {
  const rest = { ...proposal };
  delete rest.dir;
  delete rest.branch;
  return rest;
}
