// 横切 · Pipeline Orchestrator types (v0.2.0 收官版)
//
// 把 6 个 MCP 工具串成一条命令：
//   spans
//     → S2 resolve_span         → handler symbols
//     → S3 api_blast_radius     → impacted file set
//     → S4 regression_forensics → suspect commits
//     → S5 gen_e2e_tests        → test scaffolds
//     → S6 validate_in_preview  → preview env + test result（异步轮询）
//     → S7 auto_pr              → PR/MR 草稿（默认 dryRun）
//
// S6 / S7 现已真接（不再 stub）。caller 缺 serviceImage / prTarget 时该 stage 自动 skip。

import type {
  SpanInput,
  ResolveOutcome,
} from '../observability/jaeger-span-types.js';
import type { AutoPRResult, PRCandidate } from '../auto-pr/types.js';

// ─── Stage 单次结果 ───────────────────────────────────────────────────────

export type StageStatus = 'ok' | 'skipped' | 'error';

export interface StageResult<T> {
  stage: 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7';
  status: StageStatus;
  /** 单 stage 耗时（毫秒），便于看哪一步成瓶颈 */
  durationMs: number;
  /** 成功时填，错误/跳过时可空 */
  output?: T;
  /** error / skipped 时填 */
  reason?: string;
}

// ─── S6 输入: 候选 service image + test 命令（caller 提供） ────────────

export interface S6PreviewInput {
  /** 候选 fix 的服务镜像（已确认可拉的 tag） */
  serviceImage: string;
  /** 可选: 覆盖 deployment 容器 command (busybox 等需要 sleep 持续 ready) */
  serviceCommand?: string[];
  /** 测试 runner 镜像；省略则与 serviceImage 一致 */
  testImage?: string;
  /** 测试启动命令；推荐 sh -c 输出 ===JUNIT-XML=== marker */
  testCommand: string[];
  /** preview ns TTL，默认 1800 */
  ttlSeconds?: number;
  /** 轮询超时（秒），默认 300 */
  pollTimeoutSec?: number;
}

// ─── S7 输入: 目标仓 + PR 模板（caller 提供）─────────────────────────

export interface S7AutoPRInput {
  owner: string;
  repo: string;
  baseBranch: string;
  /** 默认 'github' */
  provider?: 'github' | 'gitlab';
  /** 默认 true — 永远不会真发；caller 通过 GITNEXUS_AUTOPR_LIVE 切换 */
  dryRun?: boolean;
  /** PR title / body 模板会自动拼上 S2-S6 摘要 */
  titlePrefix?: string;
  bodyHeader?: string;
  /** 关联 issue 引用（PR body 注一行） */
  issueRef?: string;
  /** PR 标签 */
  labels?: string[];
  /**
   * cross-repo/v1.0.0: partner 仓的 PR target.
   * key = bridge alias (跟 GITNEXUS_CROSS_REPO_PARTNERS 一致), e.g. 'mattermost'
   * value = 该 partner 仓在 GitLab/GitHub 的实际 owner/repo/baseBranch
   *
   * LLM 给某 partner 产出 patch (fixFiles[i].repo = alias) 时, S7 用这里的 target 发 partner 仓 MR.
   * 缺这条 entry → partner patch 被丢弃 + 日志告警 (caller 没配齐).
   */
  crossRepoTargets?: Record<
    string,
    { owner: string; repo: string; baseBranch: string }
  >;
}

// ─── Pipeline 输入 ────────────────────────────────────────────────────────

export interface PipelineInput {
  /** 一组 trace spans，至少 1 条；通常是同一 traceId 下 error=true 的若干 */
  spans: SpanInput[];
  /** forensics 用：往前看几个 commit。默认 50。 */
  forensicsLookback?: number;
  /** blast radius depth / crossDepth；默认 (2, 1)。 */
  blast?: { depth?: number; crossDepth?: number };
  /** 生成测试时使用的语言提示（兼容 detectLanguage 推断） */
  testLanguageHint?: string;
  /** 提供 → 跑 S6；省略 → S6 skip 'no serviceImage provided' */
  preview?: S6PreviewInput;
  /** 提供 → 跑 S7；省略 → S7 skip 'no PR target provided' */
  prTarget?: S7AutoPRInput;
  /**
   * cross-repo/v1.0.0: partner alias → 本地 clone 路径.
   * orchestrator 把它转给 deps.genFix → patch-runner 用 add-dir 让 LLM Read partner 源码.
   * key 跟 GITNEXUS_CROSS_REPO_PARTNERS 一致 (e.g. 'mattermost').
   */
  crossRepoLocalPaths?: Record<string, string>;
}

// ─── 各 stage 输出别名 ───────────────────────────────────────────────────

export type S2Output = ResolveOutcome;
export type S3Output = unknown;
export type S4Output = unknown;
export type S5Output = unknown;

/** S6 输出：测试结果摘要 + jobId（便于 caller 后续追溯） */
export interface S6Output {
  jobId: string;
  ns: string;
  finalStatus: 'done' | 'failed';
  testResult: unknown | null; // EnrichedTestResult，留 unknown 避免循环依赖
  pass: boolean; // testResult.passed > 0 && failed == 0
}

/** S7 输出：直接复用 AutoPRResult */
export type S7Output = AutoPRResult;

// ─── 整条 pipeline 报告 ──────────────────────────────────────────────────

export interface PipelineReport {
  startedAt: number;
  finishedAt: number;
  totalDurationMs: number;

  /** 输入 spans 数，便于报告头一行 */
  inputSpanCount: number;

  /** S2: 每条 span 一份 resolve 结果（与 input 同序） */
  s2_resolve: StageResult<S2Output>[];

  /** 去重后的 handler UID 列表（S2 ok 的并集） */
  resolvedHandlerUids: string[];

  /** S3: 每个 handler 一份 blast radius */
  s3_blast: StageResult<S3Output>[];

  /** S4: 整批 spans 共享一份 forensics 结果 */
  s4_forensics: StageResult<S4Output>;

  /** S5: 每个 handler 一份 test scaffold */
  s5_testgen: StageResult<S5Output>[];

  /** S6: 整批一份 preview 验证结果（异步轮询完成后落定） */
  s6_preview: StageResult<S6Output>;

  /** S7: 整批一份 PR 创建报告（默认 dryRun） */
  s7_autopr: StageResult<S7Output>;

  /** 整体执行结论：所有 stage 都 ok 才算 success；只要有一个 error 即 partial。 */
  overall: 'success' | 'partial' | 'no-handler';
}

// ─── Orchestrator 依赖注入（便于 unit test mock） ─────────────────────────

/** S3 增量 — 跨仓 contract link, 给 cross-repo/v1.0.0 用. */
export interface CrossLinkOutput {
  primaryRepo: string;
  partnerRepo: string;
  contractId: string;
  partnerHandler: {
    uid: string;
    filePath: string;
    name: string;
    startLine?: number;
    label?: 'Method' | 'Function';
  };
  /**
   * matchType 来源:
   *  - 'exact' / 'wildcard' / 'manifest' — 主流标准链路 (bridge.lbug ContractLink, conf=1.0)
   *  - 'cypher-name+path' / 'cypher-name-only' — DIY fallback (mcp-bridge.crossBlastRadius, conf=0.4-0.7)
   *
   * 兼容性扩展 (lbug-切换-回归测试-环境清单-v1.md D1): 旧 mock 路径仍用 'cypher-name+path',
   * 新主路径用 'exact' / 'manifest' / 'wildcard'. union 加成员, 不破坏现有 caller.
   */
  matchType:
    | 'exact'
    | 'wildcard'
    | 'manifest'
    | 'cypher-name+path'
    | 'cypher-name-only';
  confidence: number;
}

export interface OrchestratorDeps {
  resolveSpan: (span: SpanInput) => Promise<ResolveOutcome>;
  apiBlastRadius: (params: {
    target_uid: string;
    direction?: 'upstream' | 'downstream' | 'both';
    depth?: number;
    cross_depth?: number;
  }) => Promise<S3Output>;

  /**
   * 跨仓 contract link 查询 — cross-repo/v1.0.0 加. Optional, 不提供时 orchestrator
   * 跳过跨仓段, 退化到原单仓行为. 为保兼容 mock 路径, 这是 optional.
   *
   * 输入只有 contractId; primaryRepo + partnerRepos 由 dep 工厂闭包持有
   * (webhook server 启动时根据 GITNEXUS_BRIDGE_REPO + GITNEXUS_CROSS_REPO_PARTNERS 装入).
   *
   * 输出: 对每个 partner 各返一条命中 (没命中时不返条目)
   */
  crossBlastRadius?: (params: {
    contractId: string;
  }) => Promise<CrossLinkOutput[]>;
  regressionForensics: (params: {
    spans: SpanInput[];
    lookback?: number;
    /**
     * cross-repo/v1.0.0: S3 算出的跨仓 ContractLink. 让 S4 也对每个 partner 仓的 handler 文件
     * 跑 git log → 多仓 suspects 合并按时间排序. dep 实现可选; 实现忽略此字段就退化到单仓 S4.
     */
    crossLinks?: CrossLinkOutput[];
  }) => Promise<S4Output>;
  genE2ETests: (params: {
    target_uid: string;
    language?: string;
  }) => Promise<S5Output>;

  // ─── S6 接入 (validate_in_preview + check_preview_status) ────────────
  /** 异步入队，返回 jobId + 初始状态 */
  validateInPreview: (params: {
    service_image: string;
    service_name: string;
    test_image: string;
    test_command: string[];
    ttl_seconds?: number;
  }) => Promise<{ jobId?: string; status?: string; ns?: string; error?: string }>;
  /** 查 jobId 状态；orchestrator 会自己轮询直到 terminal */
  checkPreviewStatus: (params: { job_id: string }) => Promise<{
    status?: string;
    ns?: string;
    testResult?: unknown;
    error?: string | null;
  }>;

  // ─── S7 接入 (auto_pr) ────────────────────────────────────────────────
  /** 调 auto_pr；orchestrator 自己拼 PRCandidate */
  autoPR: (params: {
    candidate: PRCandidate;
    provider?: 'github' | 'gitlab';
    dryRun?: boolean;
    stage6Pass?: boolean;
  }) => Promise<AutoPRResult>;

  // ─── 可选: LIVE patch + 真断言生成 (R-14, claude-cli 实现) ────────────
  /**
   * 给一个 handler + 错误上下文 + blast radius (+ 可选嫌疑 commit), 让 LLM 出真补丁 + 真测试.
   *
   * 不存在时, orchestrator 走旧 R-1 scaffold + 诊断报告路径 (现 mvp/v1.2 行为, 不破).
   * 存在并 ok=true 时, 返回的 fixFiles + testFiles 会被 R-14 policy 过一遍后塞进 PRCandidate.files.
   *
   * 必须由 caller 自己保证 R-14 安全约束已注入 system prompt.
   */
  genFix?: (params: {
    handlerSymbolUid: string;
    handlerFilePath: string;
    errorContext: string;
    blastRadiusFiles: string[];
    suspectCommit?: { hash: string; subject?: string; diff?: string };
    issueRef?: string;
    /** cross-repo/v1.0.0: 跨仓 partner. 空数组 = 单仓 (默认). */
    crossRepoPartners?: Array<{
      repoAlias: string;
      localPath: string;
      handlerFilePath: string;
      handlerName: string;
      contractId: string;
      confidence: number;
    }>;
  }) => Promise<{
    ok: boolean;
    /** 主仓的 patch repo 字段省略; 跨仓 patch 填 partner alias */
    fixFiles: Array<{ path: string; content: string; repo?: string }>;
    testFiles: Array<{ path: string; content: string; repo?: string }>;
    reasoning: string;
    abort?: boolean;
    reason?: string;
    costUsd?: number;
    durationMs?: number;
  }>;
}
