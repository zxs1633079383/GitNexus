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
  genFixDiagnostic?: string;
  genFixReasoning?: string;
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
  if (args.genFixReasoning) {
    lines.push('### 🤖 LLM patch reasoning (R-14)');
    lines.push(args.genFixReasoning.slice(0, 1500));
    lines.push('');
    if (args.genFixDiagnostic) lines.push(`> ${args.genFixDiagnostic}`);
    lines.push('');
  } else if (args.genFixDiagnostic) {
    lines.push(`> ${args.genFixDiagnostic}`);
    lines.push('');
  }
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

/**
 * 把 SpanInput 里的 errorEvent (logs[].fields with exception.* / events[] OTel) 拼成
 * 给 LLM 的 errorContext 文本.
 */
function stringifySpanError(span: unknown): string {
  if (!span || typeof span !== 'object') return '(no span)';
  const sp = span as {
    operationName?: string;
    logs?: Array<{ fields?: Array<{ key?: string; value?: unknown }> }>;
    events?: Array<{ name?: string; attributes?: Record<string, unknown> }>;
    process?: { serviceName?: string };
    tags?: Array<{ key?: string; value?: unknown }>;
  };
  const lines: string[] = [];
  if (sp.process?.serviceName) lines.push(`service: ${sp.process.serviceName}`);
  if (sp.operationName) lines.push(`op: ${sp.operationName}`);
  if (Array.isArray(sp.tags)) {
    for (const t of sp.tags) {
      if (typeof t.key === 'string' && /^http\.(method|route|url|status_code)/.test(t.key)) {
        lines.push(`${t.key}: ${String(t.value).slice(0, 200)}`);
      }
    }
  }
  const exFields: Record<string, string> = {};
  for (const log of sp.logs ?? []) {
    for (const f of log.fields ?? []) {
      if (typeof f.key === 'string' && typeof f.value === 'string') {
        if (f.key.startsWith('exception.')) exFields[f.key] = f.value;
      }
    }
  }
  for (const ev of sp.events ?? []) {
    if (ev.name === 'exception' && ev.attributes) {
      for (const [k, v] of Object.entries(ev.attributes)) {
        if (k.startsWith('exception.') && typeof v === 'string') exFields[k] = v;
      }
    }
  }
  if (exFields['exception.type']) lines.push(`exception type: ${exFields['exception.type']}`);
  if (exFields['exception.message']) lines.push(`exception message: ${exFields['exception.message']}`);
  if (exFields['exception.stacktrace']) {
    lines.push('stacktrace:');
    lines.push(exFields['exception.stacktrace'].slice(0, 2000));
  }
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

  // ── 可选 LLM patch 生成 (R-14, deps.genFix 提供时启用) ────────────────
  // 不暴露成正式 stage (避免改 PipelineReport schema), 用本地变量传递给 S7.
  // 失败 / abort / 未实现 → 沿用 S5 scaffold + 诊断报告路径 (mvp/v1.2 行为).
  let genFixResult:
    | { fixFiles: Array<{ path: string; content: string }>; testFiles: Array<{ path: string; content: string }>; reasoning: string }
    | null = null;
  let genFixDiagnostic = '';
  if (deps.genFix && resolvedHandlerUids.length > 0 && input.spans.length > 0) {
    try {
      const firstUid = resolvedHandlerUids[0];
      const s2Match = s2_resolve.find(
        (r) => r.status === 'ok' && extractHandlerUid(r.output) === firstUid,
      );
      const handlerFile = s2Match ? extractHandlerFile(s2Match.output) : null;
      const s3Match = s3_blast.find((r) => r.status === 'ok' && r.output);
      const blastFiles = ((s3Match?.output as { files?: string[] } | undefined)?.files ?? []).filter(
        (f): f is string => typeof f === 'string',
      );
      const errorContext = stringifySpanError(input.spans[0]);
      // 把 S4 Top1 嫌疑 commit + diff 喂给 LLM (H-3 修): 没有就传 undefined
      const s4Output = s4_forensics.status === 'ok' ? (s4_forensics.output as {
        topSuspectHash?: string;
        topSuspectSubject?: string;
        topSuspectDiff?: string;
      } | undefined) : undefined;
      const suspectCommit = s4Output?.topSuspectHash
        ? {
            hash: s4Output.topSuspectHash,
            subject: s4Output.topSuspectSubject,
            diff: s4Output.topSuspectDiff,
          }
        : undefined;
      if (handlerFile) {
        const t0 = now();
        const fix = await deps.genFix({
          handlerSymbolUid: firstUid,
          handlerFilePath: handlerFile,
          errorContext,
          blastRadiusFiles: blastFiles.slice(0, 30),
          suspectCommit,
          issueRef: input.prTarget?.issueRef,
        });
        const dur = now() - t0;
        if (fix.ok && (fix.fixFiles.length > 0 || fix.testFiles.length > 0)) {
          genFixResult = {
            fixFiles: fix.fixFiles,
            testFiles: fix.testFiles,
            reasoning: fix.reasoning,
          };
          genFixDiagnostic = `LLM patch ok in ${dur}ms cost=$${(fix.costUsd ?? 0).toFixed(4)} fix=${fix.fixFiles.length} tests=${fix.testFiles.length}`;
        } else {
          genFixDiagnostic = `LLM patch abort: ${fix.reason ?? '(no reason)'} (cost=$${(fix.costUsd ?? 0).toFixed(4)}, ${dur}ms)`;
        }
      } else {
        genFixDiagnostic = 'LLM patch skipped: handler filePath not extractable from S2';
      }
    } catch (e) {
      genFixDiagnostic = `LLM patch threw: ${(e as Error).message}`;
    }
  } else if (deps.genFix) {
    genFixDiagnostic = 'LLM patch skipped: no resolved handler / no spans';
  }

  // ── S7 · auto_pr (默认 dryRun) ────────────────────────────────────────
  let s7_autopr: StageResult<S7Output>;
  if (!input.prTarget) {
    s7_autopr = skipped<S7Output>('S7', 'no prTarget (caller did not provide owner/repo/baseBranch)');
  } else {
    s7_autopr = await runStage<S7Output>('S7', async () => {
      const stage6Pass = s6_preview.status === 'ok' && !!s6_preview.output?.pass;
      const s5Files = extractS5GeneratedFiles(s5_testgen);
      const issueRef = input.prTarget!.issueRef ?? '';
      const issueNum = issueRef.replace(/^#/, '') || `auto-${Date.now().toString(36)}`;
      const prBodyMd = buildPRBody({
        header: input.prTarget!.bodyHeader,
        inputSpanCount: input.spans.length,
        resolvedHandlerUids,
        s4_forensics,
        s5_files: s5Files,
        s6: s6_preview,
        issueRef: input.prTarget!.issueRef,
        genFixDiagnostic,
        genFixReasoning: genFixResult?.reasoning,
      });

      // 让 MR/PR 真带 commit + diff —— 写一份 7 阶段诊断报告 + S5 测试脚手架 stub
      // 路径走 .gitnexus/reports/ 不污染业务源码；R-12 policy 默认允许该路径
      const candidateFiles: PRCandidate['files'] = [
        {
          path: `.gitnexus/reports/auto-pr-issue-${issueNum}.md`,
          content: buildAutoPRReportFile({
            issueRef,
            inputSpanCount: input.spans.length,
            resolvedHandlerUids,
            s2_resolve,
            s3_blast,
            s4_forensics,
            s5_testgen,
            s6_preview,
            genFixDiagnostic,
            genFixReasoning: genFixResult?.reasoning,
          }),
          op: 'create',
        },
      ];

      // 优先用 LLM 真补丁 + 真断言测试 (R-14); 没有就走 S5 scaffold (R-1)
      // fixFiles 是改既有文件 → op=update; testFiles 一般是新建 → op=create
      if (genFixResult) {
        for (const f of genFixResult.fixFiles) {
          candidateFiles.push({ path: f.path, content: f.content, op: 'update' });
        }
        for (const f of genFixResult.testFiles) {
          candidateFiles.push({ path: f.path, content: f.content, op: 'create' });
        }
      } else {
        for (const path of s5Files.slice(0, 5)) {
          candidateFiles.push({
            path,
            content: buildTestScaffoldStub(path, issueRef, input.prTarget!.bodyHeader ?? ''),
            op: 'create',
          });
        }
      }

      const candidate: PRCandidate = {
        owner: input.prTarget!.owner,
        repo: input.prTarget!.repo,
        baseBranch: input.prTarget!.baseBranch,
        title: `${input.prTarget!.titlePrefix ?? 'fix(auto):'} GitNexus 7 阶段闭环自动 PR`,
        bodyMarkdown: prBodyMd,
        files: candidateFiles,
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

/** 让 PR/MR 真带 diff: 把 7 阶段诊断报告写成 markdown 文件 */
function buildAutoPRReportFile(args: {
  issueRef: string;
  inputSpanCount: number;
  resolvedHandlerUids: string[];
  s2_resolve: StageResult<S2Output>[];
  s3_blast: StageResult<S3Output>[];
  s4_forensics: StageResult<S4Output>;
  s5_testgen: StageResult<S5Output>[];
  s6_preview: StageResult<S6Output>;
  genFixDiagnostic?: string;
  genFixReasoning?: string;
}): string {
  const L: string[] = [];
  L.push(`# Auto-PR 诊断报告 — ${args.issueRef || '(no issue ref)'}`);
  L.push('');
  L.push(`> 由 GitNexus Pipeline Orchestrator 自动生成`);
  L.push(`> 生成时间: ${new Date().toISOString()}`);
  L.push(`> 输入 spans: ${args.inputSpanCount}`);
  L.push(`> 解析 handlers: ${args.resolvedHandlerUids.length}`);
  L.push('');
  if (args.genFixReasoning || args.genFixDiagnostic) {
    L.push('## 🤖 LLM patch reasoning (R-14)');
    if (args.genFixReasoning) L.push(args.genFixReasoning);
    if (args.genFixDiagnostic) {
      L.push('');
      L.push(`> ${args.genFixDiagnostic}`);
    }
    L.push('');
  }

  L.push('## S2 · Trace2Code Resolver');
  for (const r of args.s2_resolve.slice(0, 30)) {
    if (r.status !== 'ok' || !r.output) continue;
    const o = r.output as any;
    L.push(`- \`${o.contractId ?? o.handler?.name ?? '?'}\` → \`${o.handler?.uid ?? '?'}\``);
    if (o.handler?.filePath) L.push(`  - 文件: \`${o.handler.filePath}\``);
  }
  L.push('');

  L.push('## S3 · Blast Radius');
  for (const r of args.s3_blast.slice(0, 10)) {
    if (r.status !== 'ok' || !r.output) continue;
    const o = r.output as any;
    L.push(`### ${o.target_uid ?? '?'}`);
    if (Array.isArray(o.files)) {
      L.push('受影响文件:');
      for (const f of o.files.slice(0, 20)) L.push(`- \`${typeof f === 'string' ? f : (f as any).filePath ?? JSON.stringify(f)}\``);
    }
    if (Array.isArray(o.cross) && o.cross.length > 0) {
      L.push('');
      L.push('跨仓影响:');
      for (const c of o.cross.slice(0, 10)) L.push(`- \`${(c as any).repo}\` → \`${(c as any).uid}\` (${(c as any).risk ?? '?'})`);
    }
    if (o.note) L.push(`> _${o.note}_`);
  }
  L.push('');

  L.push('## S4 · Auto Regression Forensics');
  if (args.s4_forensics.status === 'ok' && args.s4_forensics.output) {
    const o = args.s4_forensics.output as any;
    const suspects = Array.isArray(o.suspects) ? o.suspects : [];
    if (suspects.length === 0) L.push('_无嫌疑 commit_' + (o.note ? ` (${o.note})` : ''));
    else {
      L.push('| commit | confidence | symbol | 多久前 |');
      L.push('|---|---|---|---|');
      for (const s of suspects.slice(0, 10)) {
        const time = s.timeAgoSec ? `${(s.timeAgoSec / 3600).toFixed(1)}h` : '?';
        L.push(`| \`${(s.commitHash ?? '?').slice(0, 8)}\` | ${(s.confidence ?? 0).toFixed(2)} | \`${s.symbolUid ?? '?'}\` | ${time} |`);
      }
    }
  }
  L.push('');

  L.push('## S5 · E2E Test Generator (R-1 scaffold)');
  for (const r of args.s5_testgen) {
    if (r.status !== 'ok' || !r.output) continue;
    const o = r.output as any;
    const fs: any[] = Array.isArray(o.files) ? o.files : [];
    for (const f of fs) L.push(`- \`${typeof f === 'string' ? f : (f as any).path ?? '?'}\``);
  }
  L.push('');

  L.push('## S6 · K8s Preview Env');
  if (args.s6_preview.output) {
    const o = args.s6_preview.output;
    L.push(`- jobId: \`${o.jobId}\``);
    L.push(`- namespace: \`${o.ns}\``);
    L.push(`- finalStatus: \`${o.finalStatus}\``);
    L.push(`- pass: **${o.pass ? '✅ true' : '❌ false'}**`);
    const tr = o.testResult as any;
    if (tr) {
      L.push(`- testResult source: \`${tr.source ?? 'unknown'}\``);
      L.push(`- pass=${tr.passed ?? 0} fail=${tr.failed ?? 0} skip=${tr.skipped ?? 0}`);
    }
  } else {
    L.push(`status: ${args.s6_preview.status}, ${args.s6_preview.reason ?? ''}`);
  }
  L.push('');
  L.push('---');
  L.push('<sub>本文件由 GitNexus Pipeline 自动写入 PR/MR 让 diff 真实可见。可安全删除 — 仅作诊断快照。</sub>');
  return L.join('\n');
}

function buildTestScaffoldStub(path: string, issueRef: string, header: string): string {
  const isJava = path.endsWith('.java');
  const isGo = path.endsWith('.go');
  const isTs = path.endsWith('.ts');
  const isPy = path.endsWith('.py');
  const fnHint = path.split('/').pop()?.replace(/\.\w+$/, '') ?? 'test';

  if (isJava) {
    return `// AUTO-GENERATED by GitNexus E2E Test Generator (R-1 scaffold)
// 关联 issue: ${issueRef}
// ${header.split('\n')[0] || ''}
// TODO: 由开发者补全 assertion (GitNexus 当前阶段只产生脚手架，不调 LLM 生成断言以避免幻觉)

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ${fnHint} {
    @Test
    void shouldHandle_${fnHint.replace(/[^a-zA-Z0-9_]/g, '_')}() {
        // TODO: arrange
        // TODO: act
        // TODO: assert
        fail("TODO: implement test by developer");
    }
}
`;
  }
  if (isGo) {
    return `// AUTO-GENERATED by GitNexus E2E Test Generator (R-1 scaffold)
// issue: ${issueRef}
// TODO: 由开发者补全 assertion

package autogen

import "testing"

func Test${fnHint.replace(/[^a-zA-Z0-9]/g, '_')}(t *testing.T) {
    // TODO: arrange
    // TODO: act
    // TODO: assert
    t.Skip("TODO: implement test by developer")
}
`;
  }
  if (isTs) {
    return `// AUTO-GENERATED by GitNexus E2E Test Generator (R-1 scaffold)
// issue: ${issueRef}
// TODO: 由开发者补全 assertion

import { describe, it, expect } from 'vitest';

describe('${fnHint}', () => {
  it.todo('should handle ${fnHint}');
});
`;
  }
  if (isPy) {
    return `# AUTO-GENERATED by GitNexus E2E Test Generator (R-1 scaffold)
# issue: ${issueRef}
# TODO: 由开发者补全 assertion

import pytest

@pytest.mark.skip(reason="TODO: implement test by developer")
def test_${fnHint.replace(/[^a-zA-Z0-9_]/g, '_')}():
    pass
`;
  }
  return `# Auto-generated test scaffold\n# issue: ${issueRef}\n# TODO: implement\n`;
}

/** 暴露给单测 — 便于校验 PR body 拼接逻辑 */
export const __test = {
  buildPRBody,
  buildAutoPRReportFile,
  buildTestScaffoldStub,
  extractHandlerUid,
  extractHandlerFile,
  extractS5GeneratedFiles,
};
