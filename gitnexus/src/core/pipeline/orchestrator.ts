// 横切 · Pipeline Orchestrator 实现 (v0.2.0 收官版)
//
// 设计要点：
//  1) 每个 stage 独立 try-catch，单 stage 失败不阻断后续（自身 stageResult 标 error）
//  2) 单条 span resolve 失败 → 该 span 不进 handler set；不影响其他 spans
//  3) S2 全部失败（resolvedHandlerUids 空） → S3/S5 直接 skipped；S4 仍跑
//  4) S6: caller 没给 preview 输入 → skip；给了 → 异步 enqueue + 轮询直到 terminal
//  5) S7: caller 没给 prTarget → skip；给了 → 拼 PRCandidate 调 autoPR (dryRun 默认)

import type { PRCandidate } from '../auto-pr/types.js';
import type {
  OrchestratorDeps,
  PipelineInput,
  PipelineReport,
  S2Output,
  S3Output,
  S4Output,
  S5Output,
  S6Output,
  S7Output,
  StageResult,
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
  const o = outcome as { resolved?: boolean; handler?: { uid?: string } };
  if (o?.resolved && typeof o.handler?.uid === 'string') {
    return o.handler.uid;
  }
  return null;
}

/** 提取 handler 的 file path（用于 S5 testgen 的 entry） */
function extractHandlerFile(outcome: S2Output): string | null {
  const o = outcome as { handler?: { filePath?: string } };
  return typeof o?.handler?.filePath === 'string' ? o.handler.filePath : null;
}

/** 异步轮询直到 status ∈ {done, failed}，超时返回当前状态。 */
async function pollPreviewToTerminal(
  deps: OrchestratorDeps,
  jobId: string,
  pollTimeoutSec: number,
  pollIntervalMs = 3000,
): Promise<{ status: string; testResult: unknown; error: string | null; ns?: string }> {
  const t0 = now();
  while (true) {
    const r = await deps.checkPreviewStatus({ job_id: jobId });
    const st = r.status ?? 'unknown';
    if (st === 'done' || st === 'failed') {
      return {
        status: st,
        testResult: r.testResult ?? null,
        error: r.error ?? null,
        ns: r.ns,
      };
    }
    if ((now() - t0) / 1000 > pollTimeoutSec) {
      return {
        status: st,
        testResult: null,
        error: `poll timeout after ${pollTimeoutSec}s (last status=${st})`,
        ns: r.ns,
      };
    }
    await new Promise((res) => setTimeout(res, pollIntervalMs));
  }
}

/** 把 S2-S6 摘要拼成给 PR body 用的 markdown。 */
function buildPRBody(args: {
  header?: string;
  inputSpanCount: number;
  resolvedHandlerUids: string[];
  s4_forensics: StageResult<S4Output>;
  s5_files: string[];
  s6: StageResult<S6Output>;
  issueRef?: string;
}): string {
  const lines: string[] = [];
  if (args.header) lines.push(args.header, '');
  lines.push('## Agentic DevOps 自动 PR 报告');
  lines.push('');
  lines.push('> 由 GitNexus Pipeline Orchestrator 7 阶段闭环自动生成。');
  lines.push('');
  if (args.issueRef) lines.push(`- 关联 Issue/Trace: \`${args.issueRef}\``);
  lines.push(`- 输入 span 数: \`${args.inputSpanCount}\``);
  lines.push(`- 解析到 handler 数: \`${args.resolvedHandlerUids.length}\``);
  lines.push('');
  lines.push('### S4 嫌疑提交');
  lines.push('```json');
  lines.push(JSON.stringify(args.s4_forensics.output ?? args.s4_forensics.reason ?? null, null, 2).slice(0, 1500));
  lines.push('```');
  lines.push('');
  if (args.s5_files.length > 0) {
    lines.push('### S5 生成的测试脚手架');
    for (const f of args.s5_files.slice(0, 20)) lines.push(`- \`${f}\``);
    lines.push('');
  }
  lines.push('### S6 Preview 验证结果');
  lines.push(`- status: \`${args.s6.status}\``);
  if (args.s6.output) {
    lines.push(`- pass: \`${args.s6.output.pass}\``);
    lines.push(`- jobId: \`${args.s6.output.jobId}\``);
    lines.push(`- ns: \`${args.s6.output.ns}\``);
  }
  if (args.s6.reason) lines.push(`- reason: ${args.s6.reason}`);
  return lines.join('\n');
}

/** 从 S5 stages 摘出已生成测试文件路径，作为 PR 的 PRFilePatch。 */
function extractS5GeneratedFiles(s5: StageResult<S5Output>[]): string[] {
  const out: string[] = [];
  for (const r of s5) {
    if (r.status !== 'ok' || !r.output) continue;
    const o = r.output as { files?: Array<{ path: string }>; scaffolds?: Array<{ path: string }> };
    const files = o.files ?? o.scaffolds ?? [];
    for (const f of files) {
      if (f && typeof f.path === 'string') out.push(f.path);
    }
  }
  return [...new Set(out)];
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
  const s2_resolve = await Promise.all(
    input.spans.map((span) => runStage<S2Output>('S2', () => deps.resolveSpan(span))),
  );

  const handlerUidSet = new Set<string>();
  for (const r of s2_resolve) {
    if (r.status === 'ok' && r.output) {
      const uid = extractHandlerUid(r.output);
      if (uid) handlerUidSet.add(uid);
    }
  }
  const resolvedHandlerUids = [...handlerUidSet];

  // ── S3 · api_blast_radius ─────────────────────────────────────────────
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

  // ── S4 · regression_forensics ─────────────────────────────────────────
  const s4_forensics = await runStage<S4Output>('S4', () =>
    deps.regressionForensics({ spans: input.spans, lookback }),
  );

  // ── S5 · gen_e2e_tests ────────────────────────────────────────────────
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

  // ── S6 · preview env (异步入队 + 轮询) ────────────────────────────────
  let s6_preview: StageResult<S6Output>;
  if (!input.preview) {
    s6_preview = skipped<S6Output>('S6', 'no preview input (caller did not provide serviceImage)');
  } else if (resolvedHandlerUids.length === 0) {
    s6_preview = skipped<S6Output>('S6', 'no handler to validate');
  } else {
    s6_preview = await runStage<S6Output>('S6', async () => {
      const enq = await deps.validateInPreview({
        service_image: input.preview!.serviceImage,
        service_name: 'svc-' + (resolvedHandlerUids[0]?.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12) || 'auto'),
        service_command: input.preview!.serviceCommand,
        test_image: input.preview!.testImage ?? input.preview!.serviceImage,
        test_command: input.preview!.testCommand,
        ttl_seconds: input.preview!.ttlSeconds,
      } as any);
      if (enq.error || !enq.jobId) {
        throw new Error(enq.error ?? 'validate_in_preview returned no jobId');
      }
      const polled = await pollPreviewToTerminal(
        deps,
        enq.jobId,
        input.preview!.pollTimeoutSec ?? 300,
      );
      const tr = polled.testResult as { passed?: number; failed?: number } | null;
      const pass =
        polled.status === 'done' &&
        !!tr &&
        (tr.passed ?? 0) > 0 &&
        (tr.failed ?? 0) === 0;
      return {
        jobId: enq.jobId,
        ns: polled.ns ?? enq.ns ?? '',
        finalStatus: polled.status === 'done' ? 'done' : 'failed',
        testResult: polled.testResult,
        pass,
      };
    });
  }

  // ── S7 · auto_pr (默认 dryRun) ────────────────────────────────────────
  let s7_autopr: StageResult<S7Output>;
  if (!input.prTarget) {
    s7_autopr = skipped<S7Output>('S7', 'no prTarget (caller did not provide owner/repo/baseBranch)');
  } else {
    s7_autopr = await runStage<S7Output>('S7', async () => {
      const stage6Pass = s6_preview.status === 'ok' && !!s6_preview.output?.pass;
      const s5Files = extractS5GeneratedFiles(s5_testgen);
      // S5 输出的 path 是相对路径但没文件内容；这里只把脚手架名贴进 PR body 描述。
      // 真实 patch 由 patch-llm（R-14）产生 — 当前 stub 不产 file patch，故 files=[]。
      const candidate: PRCandidate = {
        owner: input.prTarget!.owner,
        repo: input.prTarget!.repo,
        baseBranch: input.prTarget!.baseBranch,
        title: `${input.prTarget!.titlePrefix ?? 'fix(auto):'} GitNexus 7 阶段闭环自动 PR`,
        bodyMarkdown: buildPRBody({
          header: input.prTarget!.bodyHeader,
          inputSpanCount: input.spans.length,
          resolvedHandlerUids,
          s4_forensics,
          s5_files: s5Files,
          s6: s6_preview,
          issueRef: input.prTarget!.issueRef,
        }),
        files: [], // 真实 patch 接 patch-llm 后填；当前阶段保持 dry-run 友好
        labels: input.prTarget!.labels ?? ['auto-fix', 'gitnexus-pipeline'],
        issueRef: input.prTarget!.issueRef,
      };
      return await deps.autoPR({
        candidate,
        provider: input.prTarget!.provider,
        dryRun: input.prTarget!.dryRun !== false,
        stage6Pass,
      });
    });
  }

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
      s5_testgen.some((r) => r.status === 'error') ||
      s6_preview.status === 'error' ||
      s7_autopr.status === 'error';
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

/** 暴露给单测 — 便于校验 PR body 拼接逻辑 */
export const __test = {
  buildPRBody,
  extractHandlerUid,
  extractHandlerFile,
  extractS5GeneratedFiles,
};
