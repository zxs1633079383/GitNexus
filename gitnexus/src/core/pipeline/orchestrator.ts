// 横切 · Pipeline Orchestrator 实现
//
// 设计要点：
//  1) 每个 stage 独立 try-catch，单 stage 失败不阻断后续（只在自身 stageResult 标 error）
//  2) 单条 span resolve 失败 → 该 span 不进 handler set；不影响其他 spans
//  3) S2 全部失败（resolvedHandlerUids 空） → S3/S5 直接 skipped；S4 仍跑（forensics 自己拿 spans）
//  4) S6 / S7 永远 skipped 直到后续 stage 解锁

import type {
  OrchestratorDeps,
  PipelineInput,
  PipelineReport,
  StageResult,
  S2Output,
  S3Output,
  S4Output,
  S5Output,
} from './types.js';

const now = (): number => Date.now();

async function runStage<T>(
  stage: StageResult<T>['stage'],
  fn: () => Promise<T>,
): Promise<StageResult<T>> {
  const t0 = now();
  try {
    const output = await fn();
    return { stage, status: 'ok', durationMs: now() - t0, output };
  } catch (err) {
    return {
      stage,
      status: 'error',
      durationMs: now() - t0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function skipped<T>(stage: StageResult<T>['stage'], reason: string): StageResult<T> {
  return { stage, status: 'skipped', durationMs: 0, reason };
}

/** 从 ResolveOutcome 中提取 handler UID（兼容 outcome 字段） */
function extractHandlerUid(outcome: S2Output): string | null {
  // ResolveOutcome 形态：{ resolved: true, handler: { uid, ... }, ... }
  // 容错读 — 不强依赖具体内部 schema，避免 Phase 0 schema 微调时连锁断裂
  const o = outcome as { resolved?: boolean; handler?: { uid?: string } };
  if (o?.resolved && typeof o.handler?.uid === 'string') {
    return o.handler.uid;
  }
  return null;
}

export async function runPipeline(
  input: PipelineInput,
  deps: OrchestratorDeps,
): Promise<PipelineReport> {
  const startedAt = now();
  const lookback = input.forensicsLookback ?? 50;
  const blastDepth = input.blast?.depth ?? 2;
  const blastCross = input.blast?.crossDepth ?? 1;

  // ── S2 · resolve_span（每条 span 一次） ───────────────────────────────
  const s2Promises = input.spans.map((span) =>
    runStage<S2Output>('S2', () => deps.resolveSpan(span)),
  );
  const s2_resolve: StageResult<S2Output>[] = await Promise.all(s2Promises);

  // 收集 handler UID（去重）
  const handlerUidSet = new Set<string>();
  for (const r of s2_resolve) {
    if (r.status === 'ok' && r.output) {
      const uid = extractHandlerUid(r.output);
      if (uid) handlerUidSet.add(uid);
    }
  }
  const resolvedHandlerUids = [...handlerUidSet];

  // ── S3 · api_blast_radius（每个 handler 一次，并行） ─────────────────
  let s3_blast: StageResult<S3Output>[];
  if (resolvedHandlerUids.length === 0) {
    s3_blast = [skipped<S3Output>('S3', 'no resolved handler from S2')];
  } else {
    s3_blast = await Promise.all(
      resolvedHandlerUids.map((uid) =>
        runStage<S3Output>('S3', () =>
          deps.apiBlastRadius({
            target_uid: uid,
            direction: 'both',
            depth: blastDepth,
            cross_depth: blastCross,
          }),
        ),
      ),
    );
  }

  // ── S4 · regression_forensics（一次，整批 spans） ────────────────────
  // 即使 S2 全失败，forensics 仍可跑：内部会再 normalize 一次拿 errorEvent + symbolUid
  const s4_forensics: StageResult<S4Output> = await runStage<S4Output>('S4', () =>
    deps.regressionForensics({ spans: input.spans, lookback }),
  );

  // ── S5 · gen_e2e_tests（每个 handler 一次，并行） ────────────────────
  let s5_testgen: StageResult<S5Output>[];
  if (resolvedHandlerUids.length === 0) {
    s5_testgen = [skipped<S5Output>('S5', 'no resolved handler from S2')];
  } else {
    s5_testgen = await Promise.all(
      resolvedHandlerUids.map((uid) =>
        runStage<S5Output>('S5', () =>
          deps.genE2ETests({
            target_uid: uid,
            language: input.testLanguageHint,
          }),
        ),
      ),
    );
  }

  // ── S6 / S7 占位（解锁后切真实实现） ─────────────────────────────────
  const s6_preview = skipped<never>('S6', 'stage-6 not yet wired (R-2/R-3 locked, impl pending)');
  const s7_autopr = skipped<never>('S7', 'stage-7 not yet wired (R-4 locked, impl pending)');

  const finishedAt = now();

  // ── overall 判定 ──────────────────────────────────────────────────────
  let overall: PipelineReport['overall'];
  if (resolvedHandlerUids.length === 0) {
    overall = 'no-handler';
  } else {
    const hasError =
      s2_resolve.some((r) => r.status === 'error') ||
      s3_blast.some((r) => r.status === 'error') ||
      s4_forensics.status === 'error' ||
      s5_testgen.some((r) => r.status === 'error');
    overall = hasError ? 'partial' : 'success';
  }

  return {
    startedAt,
    finishedAt,
    totalDurationMs: finishedAt - startedAt,
    inputSpanCount: input.spans.length,
    s2_resolve,
    resolvedHandlerUids,
    s3_blast,
    s4_forensics,
    s5_testgen,
    s6_preview,
    s7_autopr,
    overall,
  };
}
