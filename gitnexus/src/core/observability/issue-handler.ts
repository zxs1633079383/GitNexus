// Loop 闭环 · issue-handler
//
// /observe 自动建 issue → webhook 收 issues.opened → 调本模块。
// 本模块解析 issue body 里嵌入的 metadata 块，转 PipelineInput，调用 caller 注入的
// runPipeline + postIssueComment 完成自动闭环。

import type { SpanInput } from './jaeger-span-types.js';
import type {
  PipelineInput,
  PipelineReport,
  S7AutoPRInput,
} from '../pipeline/types.js';

// ─── /observe 嵌入 issue body 的 metadata 块 ──────────────────────────

const META_BEGIN = '<!-- gitnexus:trace -->';
const META_END = '<!-- /gitnexus:trace -->';

export interface GitNexusTraceBlock {
  /** 触发自动 PR/MR 的目标仓 owner/name；省略则默认走 webhook 上下文仓 */
  repo?: string;
  baseBranch?: string;
  /** Jaeger / OTel spans 数组（直接传 normalize 输入）*/
  spans?: SpanInput[];
  /** Jaeger 链路 URL，便于贴回 issue 评论 */
  traceUrl?: string;
  /** 候选 fix 的服务镜像（S6 用）；省略则 S6 skip */
  serviceImage?: string;
  /** S6 测试 runner 镜像；省略则与 serviceImage 一致 */
  testImage?: string;
  /** S6 测试启动命令 */
  testCommand?: string[];
  /** issue 编号（caller 通常已在外层有，这里冗余存便于 PR 自动 link） */
  issueNumber?: number;
}

/** 从 issue body 抠出 ===gitnexus:trace=== JSON 块；找不到 / parse 失败返 null。 */
export function parseGitNexusBlock(body: string | undefined): GitNexusTraceBlock | null {
  if (!body) return null;
  const i = body.indexOf(META_BEGIN);
  const j = body.indexOf(META_END);
  if (i < 0 || j < 0 || j < i) return null;
  const raw = body.slice(i + META_BEGIN.length, j).trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as GitNexusTraceBlock;
  } catch {
    // JSON 错 — 返 null 由 caller 决定要不要回评 "metadata block invalid"
  }
  return null;
}

// ─── 把 metadata + issue 信息拼成 PipelineInput ───────────────────────

export interface BuildPipelineInputArgs {
  block: GitNexusTraceBlock;
  fullName: string; // owner/repo from webhook payload
  issueNumber: number;
  issueTitle: string;
  /** 是否实际走 live 路径（label + env GITNEXUS_AUTOPR_LIVE === '1' 都满足时为 true; S6 那条由 orchestrator 把关）*/
  liveAutoPR: boolean;
  defaultBaseBranch?: string;
}

export function buildPipelineInput(args: BuildPipelineInputArgs): PipelineInput | null {
  if (!args.block.spans || !Array.isArray(args.block.spans) || args.block.spans.length === 0) {
    return null;
  }
  const repoStr = args.block.repo ?? args.fullName;
  // GitLab 支持多级 namespace (group/subgroup/project)，如 cses/java/cses/cses
  // 用 lastIndexOf('/') 拆: owner = 前 N-1 段, repo = 最后一段
  const slashIdx = repoStr.lastIndexOf('/');
  if (slashIdx <= 0) return null;
  const owner = repoStr.slice(0, slashIdx);
  const repo = repoStr.slice(slashIdx + 1);
  if (!owner || !repo) return null;

  const prTarget: S7AutoPRInput = {
    owner,
    repo,
    baseBranch: args.block.baseBranch ?? args.defaultBaseBranch ?? 'main',
    dryRun: !args.liveAutoPR,
    titlePrefix: `fix(auto): [#${args.issueNumber}]`,
    bodyHeader: `## 自动 PR 来自 issue #${args.issueNumber}\n\n> ${args.issueTitle}\n\n> Trace: ${args.block.traceUrl ?? '(none)'}`,
    issueRef: `#${args.issueNumber}`,
    labels: ['auto-fix', 'gitnexus-pipeline'],
  };

  const input: PipelineInput = {
    spans: args.block.spans,
    prTarget,
  };
  if (args.block.serviceImage && args.block.testCommand) {
    input.preview = {
      serviceImage: args.block.serviceImage,
      testImage: args.block.testImage,
      testCommand: args.block.testCommand,
      ...((args.block as any).serviceCommand
        ? { serviceCommand: (args.block as any).serviceCommand }
        : {}),
    };
  }
  return input;
}

// ─── PipelineReport → issue comment markdown (产物详细版) ────────────

export function renderReportToComment(
  report: PipelineReport,
  args: { issueNumber: number; traceUrl?: string },
): string {
  const L: string[] = [];
  L.push(`## 🤖 GitNexus 自动巡检报告 — issue #${args.issueNumber}`);
  L.push('');
  L.push('> 由 `/observe` → `webhook` → **Pipeline Orchestrator 7 阶段闭环** 自动生成');
  if (args.traceUrl) L.push(`> Trace: <${args.traceUrl}>`);
  L.push(
    `> 输入 \`${report.inputSpanCount}\` spans → 解析 \`${report.resolvedHandlerUids.length}\` handlers · overall=**${report.overall}** · 总耗时 \`${report.totalDurationMs}ms\``,
  );
  L.push('');

  // ─── 各阶段执行总览 ──────────────────────────────────
  L.push('### 📋 各阶段执行总览');
  L.push('');
  L.push('| Stage | Status | Duration | 产物简述 |');
  L.push('|---|---|---|---|');
  const sumDur = (arr: readonly { durationMs: number }[]) =>
    arr.reduce((a, r) => a + r.durationMs, 0);
  const allOk = (arr: readonly { status: string }[]) =>
    arr.every((r) => r.status === 'ok');
  L.push(
    `| S2 resolve | ${allOk(report.s2_resolve) ? '✅ ok' : '⚠️ mixed'} | ${sumDur(report.s2_resolve)}ms | ${report.s2_resolve.length} spans → ${report.resolvedHandlerUids.length} handlers |`,
  );
  L.push(
    `| S3 blast | ${allOk(report.s3_blast) ? '✅ ok' : '⚠️ mixed'} | ${sumDur(report.s3_blast)}ms | ${countBlastFiles(report)} 文件影响 / ${countBlastCross(report)} 跨仓边 |`,
  );
  L.push(
    `| S4 forensics | ${report.s4_forensics.status === 'ok' ? '✅ ok' : '⚠️ ' + report.s4_forensics.status} | ${report.s4_forensics.durationMs}ms | ${countS4Suspects(report)} 条嫌疑 commit |`,
  );
  L.push(
    `| S5 testgen | ${allOk(report.s5_testgen) ? '✅ ok' : '⚠️ mixed'} | ${sumDur(report.s5_testgen)}ms | ${countS5Files(report)} 个测试脚手架 |`,
  );
  L.push(
    `| S6 preview | ${s6StatusIcon(report)} | ${report.s6_preview.durationMs}ms | ${s6Brief(report)} |`,
  );
  L.push(
    `| S7 auto-pr | ${s7StatusIcon(report)} | ${report.s7_autopr.durationMs}ms | ${s7Brief(report)} |`,
  );
  L.push('');

  // ─── S2 详情 ─────────────────────────────────────────
  // 只展示真接到 handler 的 span. 子 span (pulsar/app.* 内部 / DB query
  // 等) 没 handler 是预期行为 (E-deep: resolved=false), 不该污染报告.
  L.push('---');
  L.push('### 🎯 S2 · Trace2Code Resolver');
  L.push('');
  const resolvedRows = report.s2_resolve.filter((r) => {
    if (r.status !== 'ok' || !r.output) return false;
    const o = r.output as any;
    return o.resolved === true && typeof o.handler?.uid === 'string';
  });
  const totalSpans = report.s2_resolve.length;
  const skippedNonHandler = totalSpans - resolvedRows.length;

  L.push(
    `共 \`${totalSpans}\` 条 spans, 真接到 handler \`${resolvedRows.length}\` 条` +
      (skippedNonHandler > 0
        ? `, \`${skippedNonHandler}\` 条非 handler span (子 span / 内部操作 / 无 contractId) 省略`
        : ''),
  );
  L.push('');
  let s2Shown = 0;
  for (const r of resolvedRows.slice(0, 10)) {
    const o = r.output as any;
    const uid = o.handler?.uid ?? '(unknown)';
    const file = o.handler?.filePath ?? '';
    const contract = o.contractId ?? o.handler?.name ?? '';
    L.push(`- \`${contract}\` → \`${uid}\`${file ? ` _(${file})_` : ''}`);
    s2Shown++;
  }
  if (resolvedRows.length > s2Shown) {
    L.push(`- _… 还有 ${resolvedRows.length - s2Shown} 条已解析 handler 省略_`);
  }
  if (resolvedRows.length === 0) {
    L.push(
      '_⚠️ 0 个 span 接到 handler — trace 可能全是子 span 或 contractId 不在已索引仓._',
    );
  }
  L.push('');

  // ─── S3 详情 ─────────────────────────────────────────
  L.push('---');
  L.push('### 💥 S3 · Blast Radius (depth=2, crossDepth=1)');
  L.push('');
  if (report.s3_blast[0]?.status === 'skipped') {
    L.push(`_skipped: ${report.s3_blast[0].reason ?? '(no handler)'}_`);
  } else {
    for (const r of report.s3_blast.slice(0, 5)) {
      if (r.status !== 'ok' || !r.output) continue;
      const o = r.output as any;
      const uid = o.target_uid ?? '(unknown)';
      const files: string[] = Array.isArray(o.files) ? o.files : [];
      // crossLinks (cross-repo/v1.0.0 真 DIY bridge 输出) + cross (旧字段, 兼容)
      const crossLinks: any[] = Array.isArray(o.crossLinks) ? o.crossLinks : [];
      const crossOld: any[] = Array.isArray(o.cross) ? o.cross : [];
      L.push(`**${uid}**`);
      if (files.length > 0) {
        L.push(`- 受影响文件 (${files.length}):`);
        for (const f of files.slice(0, 8)) {
          const fp = typeof f === 'string' ? f : (f as any).filePath ?? JSON.stringify(f);
          L.push(`  - \`${fp}\``);
        }
        if (files.length > 8) L.push(`  - _… ${files.length - 8} more_`);
      }
      if (crossLinks.length > 0) {
        L.push(`- 🌐 跨仓 ContractLink (${crossLinks.length}):`);
        for (const c of crossLinks.slice(0, 5)) {
          const ph = c.partnerHandler ?? {};
          const conf = typeof c.confidence === 'number' ? c.confidence.toFixed(2) : '?';
          L.push(
            `  - \`${c.partnerRepo}\` → \`${ph.filePath ?? '?'}:${ph.startLine ?? '?'}\` (${ph.name ?? '?'}, ${c.matchType}, conf=${conf})`,
          );
          if (c.contractId) L.push(`    contract: \`${c.contractId}\``);
        }
      }
      if (crossOld.length > 0) {
        L.push(`- 跨仓影响 (旧 schema, ${crossOld.length} 边):`);
        for (const c of crossOld.slice(0, 5)) {
          L.push(
            `  - \`${(c as any).repo ?? '?'}\` → \`${(c as any).uid ?? '?'}\` (${(c as any).risk ?? '?'})`,
          );
        }
      }
      if ((o.note ?? '').length > 0) L.push(`- _注: ${o.note}_`);
    }
  }
  L.push('');

  // ─── S4 详情 ─────────────────────────────────────────
  L.push('---');
  L.push('### 🔬 S4 · Auto Regression Forensics');
  L.push('');
  if (report.s4_forensics.status !== 'ok' || !report.s4_forensics.output) {
    L.push(`_status: ${report.s4_forensics.status}, ${report.s4_forensics.reason ?? ''}_`);
  } else {
    const o = report.s4_forensics.output as any;
    const suspects: any[] = Array.isArray(o.suspects) ? o.suspects : [];
    const partnerSuspects: any[] = Array.isArray(o.partnerSuspects) ? o.partnerSuspects : [];
    if (suspects.length === 0 && partnerSuspects.length === 0) {
      L.push('_无嫌疑 commit_' + (o.note ? ` (${o.note})` : ''));
    } else {
      if (suspects.length > 0) {
        L.push('**主仓嫌疑 commit**');
        // 兼容两种 suspect 形态:
        //  · v1.0.2 真 git log: { hash, subject, author, date }
        //  · 旧 mock: { commitHash, confidence, symbolUid, timeAgoSec }
        L.push('| commit | subject / symbol | author / 时间 |');
        L.push('|---|---|---|');
        for (const s of suspects.slice(0, 5)) {
          const hash = s.hash ?? s.commitHash ?? '?';
          const subject = (s.subject ?? s.symbolUid ?? '?').toString().slice(0, 80).replace(/\|/g, '\\|');
          const author = s.author ?? (s.confidence != null ? `(conf ${(s.confidence ?? 0).toFixed(2)})` : '?');
          const when = s.date ?? (s.timeAgoSec ? `${(s.timeAgoSec / 3600).toFixed(1)}h ago` : '?');
          L.push(`| \`${String(hash).slice(0, 8)}\` | ${subject} | ${author} · ${when} |`);
        }
        if (o.handlerFile) L.push(`> _git log -- ${o.handlerFile}_`);
      }
      // cross-repo/v1.0.0: partner 仓嫌疑 commit (按 partner 分组)
      for (const grp of partnerSuspects) {
        const ps: any[] = Array.isArray(grp.suspects) ? grp.suspects : [];
        if (ps.length === 0) continue;
        L.push('');
        L.push(`**🌐 partner \`${grp.partnerRepo}\` 嫌疑 commit** (${grp.partnerFilePath})`);
        L.push('| commit | subject | author / 时间 |');
        L.push('|---|---|---|');
        for (const s of ps.slice(0, 5)) {
          const hash = s.hash ?? '?';
          const subject = (s.subject ?? '?').toString().slice(0, 80).replace(/\|/g, '\\|');
          const author = s.author ?? '?';
          const when = s.date ?? '?';
          L.push(`| \`${String(hash).slice(0, 8)}\` | ${subject} | ${author} · ${when} |`);
        }
      }
      if (o.note) L.push(`> _${o.note}_`);
    }
  }
  L.push('');

  // ─── S5 详情 ─────────────────────────────────────────
  L.push('---');
  L.push('### 🧪 S5 · E2E Test Generator (R-1 scaffold)');
  L.push('');
  if (report.s5_testgen[0]?.status === 'skipped') {
    L.push(`_skipped: ${report.s5_testgen[0].reason ?? '(no handler)'}_`);
  } else {
    const allFiles: string[] = [];
    for (const r of report.s5_testgen) {
      if (r.status !== 'ok' || !r.output) continue;
      const o = r.output as any;
      const fs: any[] = Array.isArray(o.files) ? o.files : [];
      for (const f of fs) {
        const fp = typeof f === 'string' ? f : (f as any).path ?? '';
        if (fp) allFiles.push(fp);
      }
    }
    if (allFiles.length === 0) L.push('_无测试脚手架_');
    else {
      L.push(`生成 ${allFiles.length} 个脚手架 (unit + contract + integration):`);
      for (const f of allFiles.slice(0, 12)) L.push(`- \`${f}\``);
      if (allFiles.length > 12) L.push(`- _… ${allFiles.length - 12} more_`);
    }
  }
  L.push('');

  // ─── S6 详情 ─────────────────────────────────────────
  L.push('---');
  L.push('### 🚀 S6 · K8s Preview Env');
  L.push('');
  if (report.s6_preview.status === 'skipped') {
    L.push(`_skipped: ${report.s6_preview.reason ?? '(no preview input)'}_`);
  } else if (report.s6_preview.status === 'error') {
    L.push(`_error: ${report.s6_preview.reason}_`);
  } else if (report.s6_preview.output) {
    const o = report.s6_preview.output;
    L.push(`- jobId: \`${o.jobId}\``);
    L.push(`- namespace: \`${o.ns}\` (TTL 30min, 自动 GC)`);
    L.push(`- finalStatus: \`${o.finalStatus}\``);
    L.push(`- pass: **${o.pass ? '✅ true' : '❌ false'}**`);
    const tr = o.testResult as any;
    if (tr) {
      L.push(`- testResult source: \`${tr.source ?? 'unknown'}\``);
      L.push(`- pass=${tr.passed ?? 0} / fail=${tr.failed ?? 0} / skip=${tr.skipped ?? 0} / exit=${tr.exitCode ?? '?'}`);
      if (tr.junit?.failures?.length > 0) {
        L.push(`- 失败用例 (${tr.junit.failures.length}):`);
        for (const fl of tr.junit.failures.slice(0, 5)) {
          L.push(`  - \`${fl.classname}.${fl.name}\`: ${fl.message?.slice(0, 100) ?? ''}`);
        }
      }
      if ((tr.stdoutTail ?? '').length > 0) {
        L.push('- stdout (tail):');
        L.push('  ```');
        L.push('  ' + (tr.stdoutTail ?? '').split('\n').slice(-5).join('\n  '));
        L.push('  ```');
      }
    }
  }
  L.push('');

  // ─── S7 详情 ─────────────────────────────────────────
  L.push('---');
  L.push('### 📤 S7 · Auto-PR/MR Creator');
  L.push('');
  if (report.s7_autopr.status === 'skipped') {
    L.push(`_skipped: ${report.s7_autopr.reason ?? '(no prTarget)'}_`);
  } else if (report.s7_autopr.output) {
    const o = report.s7_autopr.output;
    L.push(`- finalBranch: \`${o.finalBranch}\``);
    if (o.rejectedReason) L.push(`- ❌ rejected: ${o.rejectedReason}`);
    L.push('- stages 详情:');
    for (const st of o.stages ?? []) {
      const icon = st.status === 'ok' ? '✅' : st.status === 'skipped' ? '⚪' : st.status === 'rejected' ? '🚫' : '❌';
      L.push(`  - ${icon} \`${st.name}\` (${st.durationMs}ms)${st.reason ? ` — ${st.reason}` : ''}`);
    }
    if (o.pr) {
      L.push('');
      L.push(`### ✅ MR/PR 真创建: [!${o.pr.prNumber}](${o.pr.url})`);
    } else {
      L.push('');
      L.push(
        '_(默认 dryRun。要真发: ① issue 加标签 `gitnexus:auto-pr-live` ② server 配 `GITNEXUS_AUTOPR_LIVE=1` ③ S6 必须绿勾。三个条件都满足才真发，少一个都安全兜底)_',
      );
    }
  }
  L.push('');

  // ─── 末尾说明 ─────────────────────────────────────
  L.push('---');
  L.push(
    '<sub>由 [GitNexus Pipeline Orchestrator](https://github.com/abhigyanpatwari/GitNexus) v0.3 自动生成。如果这条评论本不该出现，请联系运维移除 webhook 配置。</sub>',
  );
  return L.join('\n');
}

// ─── 辅助：统计各阶段产物 ────────────────────────────

function countBlastFiles(report: PipelineReport): number {
  let n = 0;
  for (const r of report.s3_blast) {
    if (r.status !== 'ok' || !r.output) continue;
    const o = r.output as any;
    if (Array.isArray(o.files)) n += o.files.length;
  }
  return n;
}

function countBlastCross(report: PipelineReport): number {
  let n = 0;
  for (const r of report.s3_blast) {
    if (r.status !== 'ok' || !r.output) continue;
    const o = r.output as any;
    if (Array.isArray(o.crossLinks)) n += o.crossLinks.length;
    if (Array.isArray(o.cross)) n += o.cross.length;
  }
  return n;
}

function countS4Suspects(report: PipelineReport): number {
  if (report.s4_forensics.status !== 'ok' || !report.s4_forensics.output) return 0;
  const o = report.s4_forensics.output as any;
  return Array.isArray(o.suspects) ? o.suspects.length : 0;
}

function countS5Files(report: PipelineReport): number {
  let n = 0;
  for (const r of report.s5_testgen) {
    if (r.status !== 'ok' || !r.output) continue;
    const o = r.output as any;
    if (Array.isArray(o.files)) n += o.files.length;
  }
  return n;
}

function s6StatusIcon(report: PipelineReport): string {
  const s = report.s6_preview;
  if (s.status === 'skipped') return '⚪ skipped';
  if (s.status === 'error') return '❌ error';
  return s.output?.pass ? '✅ ok' : '⚠️ ok (pass=false)';
}

function s6Brief(report: PipelineReport): string {
  const s = report.s6_preview;
  if (s.status === 'skipped') return s.reason ?? 'skipped';
  if (s.status === 'error') return (s.reason ?? '').slice(0, 60);
  if (!s.output) return '';
  const tr = s.output.testResult as any;
  const passFail = tr ? `pass=${tr.passed ?? 0} fail=${tr.failed ?? 0}` : 'no junit';
  return `\`${s.output.ns}\` · ${passFail}`;
}

function s7StatusIcon(report: PipelineReport): string {
  const s = report.s7_autopr;
  if (s.status === 'skipped') return '⚪ skipped';
  if (s.status === 'error') return '❌ error';
  if (s.output?.pr) return '✅ MR opened';
  return s.output?.rejectedReason ? '🚫 rejected' : '⚪ dryRun';
}

function s7Brief(report: PipelineReport): string {
  const s = report.s7_autopr;
  if (s.status === 'skipped') return s.reason ?? 'skipped';
  if (s.status === 'error') return (s.reason ?? '').slice(0, 60);
  if (s.output?.pr) return `[!${s.output.pr.prNumber}](${s.output.pr.url})`;
  return s.output?.rejectedReason?.slice(0, 80) ?? 'dryRun';
}

// ─── 主流程：webhook → handler 调本函数 ─────────────────────────────

export interface HandleIssueDeps {
  /** 调 orchestrator (LocalBackend.runPipeline) */
  runPipeline: (input: PipelineInput) => Promise<PipelineReport>;
  /** 把 markdown 评论贴回 issue */
  postIssueComment: (args: {
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
  }) => Promise<{ url?: string }>;
}

export interface HandleIssueArgs {
  fullName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueLabels: string[];
  defaultBaseBranch?: string;
}

export interface HandleIssueResult {
  ok: boolean;
  pipelineStarted: boolean;
  reason?: string;
  commentUrl?: string;
}

const LIVE_LABEL = 'gitnexus:auto-pr-live';

export async function handleIssueOpened(
  args: HandleIssueArgs,
  deps: HandleIssueDeps,
): Promise<HandleIssueResult> {
  const block = parseGitNexusBlock(args.issueBody);
  if (!block) {
    // 没 metadata block — 不是 /observe 建的 issue，安静跳过
    return { ok: true, pipelineStarted: false, reason: 'no gitnexus:trace metadata block' };
  }

  // L.5: 如 block.spans 缺但有 traceUrl + JAEGER_QUERY_BASE 配了 → 自动从 Jaeger 拉
  if ((!block.spans || block.spans.length === 0) && block.traceUrl) {
    const jaegerBase = process.env.JAEGER_QUERY_BASE;
    if (jaegerBase) {
      const { resolveSpansFromBlock } = await import('./jaeger-fetcher.js');
      const r = await resolveSpansFromBlock(
        block as { spans?: any[]; traceUrl?: string },
        { jaegerBaseUrl: jaegerBase },
      );
      if (r) {
        block.spans = r.spans as SpanInput[];
      }
    }
  }

  // 三因子 LIVE 闸 (R-12):
  //   ① issue 含 LIVE_LABEL  ② env GITNEXUS_AUTOPR_LIVE === '1'  ③ S6 真绿勾 (orchestrator stage6Pass)
  // 这里负责前两条 (label + env); S6 那条由 orchestrator 在 autoPR.stage6Pass 处控.
  const labelOk = args.issueLabels.includes(LIVE_LABEL);
  const envOk = process.env.GITNEXUS_AUTOPR_LIVE === '1';
  const live = labelOk && envOk;
  const input = buildPipelineInput({
    block,
    fullName: args.fullName,
    issueNumber: args.issueNumber,
    issueTitle: args.issueTitle,
    liveAutoPR: live,
    defaultBaseBranch: args.defaultBaseBranch,
  });
  if (!input) {
    return { ok: false, pipelineStarted: false, reason: 'invalid metadata: spans missing (and Jaeger fetch failed)' };
  }

  let report: PipelineReport;
  try {
    report = await deps.runPipeline(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 即便 pipeline 抛错，也要回评一条让开发者知道
    const __r = (block.repo ?? args.fullName);
    const __i = __r.lastIndexOf('/');
    const owner = __i > 0 ? __r.slice(0, __i) : '';
    const repo = __i > 0 ? __r.slice(__i + 1) : '';
    if (owner && repo) {
      try {
        await deps.postIssueComment({
          owner,
          repo,
          issueNumber: args.issueNumber,
          body: `❌ GitNexus pipeline 启动失败: \`${msg}\``,
        });
      } catch {
        /* ignore comment failure */
      }
    }
    return { ok: false, pipelineStarted: true, reason: msg };
  }

  const md = renderReportToComment(report, {
    issueNumber: args.issueNumber,
    traceUrl: block.traceUrl,
  });
  const __r2 = (block.repo ?? args.fullName);
  const __i2 = __r2.lastIndexOf('/');
  const owner = __i2 > 0 ? __r2.slice(0, __i2) : '';
  const repo = __i2 > 0 ? __r2.slice(__i2 + 1) : '';
  let commentUrl: string | undefined;
  if (owner && repo) {
    try {
      const c = await deps.postIssueComment({
        owner,
        repo,
        issueNumber: args.issueNumber,
        body: md,
      });
      commentUrl = c.url;
    } catch (err) {
      // 评论失败不算闭环失败
      console.error('[issue-handler] postIssueComment failed:', err);
    }
  }

  return { ok: true, pipelineStarted: true, commentUrl };
}

// ─── 测试导出 ───────────────────────────────────────────────────────

export const __test = {
  META_BEGIN,
  META_END,
  LIVE_LABEL,
};
