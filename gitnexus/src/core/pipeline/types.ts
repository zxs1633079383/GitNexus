// 横切 · Pipeline Orchestrator types
//
// 负责把 4 个 MCP 工具串成一条命令：
//   spans
//     → S2 resolve_span      → handler symbols
//     → S3 api_blast_radius  → impacted file set
//     → S4 regression_forensics → suspect commits
//     → S5 gen_e2e_tests     → test scaffolds
//
// S6 / S7 由 stub 字段占位，等 stage-6/stage-7 落地后切换为真实调用。

import type {
  SpanInput,
  ResolveOutcome,
} from '../observability/jaeger-span-types.js';

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
}

// ─── 4 个 stage 的结果别名（unknown 是因为 backend 实现方法签名是 Promise<any>） ──

export type S2Output = ResolveOutcome;
export type S3Output = unknown;
export type S4Output = unknown;
export type S5Output = unknown;

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

  /** S6 / S7 占位 — 当前阶段固定 status='skipped'。 */
  s6_preview: StageResult<never>;
  s7_autopr: StageResult<never>;

  /** 整体执行结论：所有 stage 都 ok 才算 success；只要有一个 error 即 partial。 */
  overall: 'success' | 'partial' | 'no-handler';
}

// ─── Orchestrator 依赖注入（便于 unit test mock） ─────────────────────────

export interface OrchestratorDeps {
  resolveSpan: (span: SpanInput) => Promise<ResolveOutcome>;
  apiBlastRadius: (params: {
    target_uid: string;
    direction?: 'upstream' | 'downstream' | 'both';
    depth?: number;
    cross_depth?: number;
  }) => Promise<S3Output>;
  regressionForensics: (params: {
    spans: SpanInput[];
    lookback?: number;
  }) => Promise<S4Output>;
  genE2ETests: (params: {
    target_uid: string;
    language?: string;
  }) => Promise<S5Output>;
}
