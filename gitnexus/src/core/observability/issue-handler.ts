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
  /** 是否实际走 live 路径（issue 含 'gitnexus:auto-pr-live' 标签时 caller 设 true）*/
  liveAutoPR: boolean;
  defaultBaseBranch?: string;
}

export function buildPipelineInput(args: BuildPipelineInputArgs): PipelineInput | null {
  if (!args.block.spans || !Array.isArray(args.block.spans) || args.block.spans.length === 0) {
    return null;
  }
  const repoStr = args.block.repo ?? args.fullName;
  const [owner, repo] = repoStr.split('/');
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
    };
  }
  return input;
}

// ─── PipelineReport → issue comment markdown ───────────────────────────

export function renderReportToComment(
  report: PipelineReport,
  args: { issueNumber: number; traceUrl?: string },
): string {
  const lines: string[] = [];
  lines.push(`## GitNexus 7 阶段闭环报告 — issue #${args.issueNumber}`);
  lines.push('');
  if (args.traceUrl) lines.push(`- Trace: ${args.traceUrl}`);
  lines.push(`- 总耗时: \`${report.totalDurationMs}ms\``);
  lines.push(`- overall: **${report.overall}**`);
  lines.push(`- handlers: \`${report.resolvedHandlerUids.length}\``);
  lines.push('');
  lines.push('| Stage | Status | Duration | Note |');
  lines.push('|---|---|---|---|');
  const stageRow = (
    name: string,
    status: string,
    ms: number,
    note?: string,
  ) => `| ${name} | ${status} | ${ms}ms | ${note ?? ''} |`;
  lines.push(
    stageRow(
      'S2 resolve',
      report.s2_resolve.every((r) => r.status === 'ok')
        ? 'ok'
        : 'mixed',
      report.s2_resolve.reduce((a, r) => a + r.durationMs, 0),
      `${report.s2_resolve.length} spans`,
    ),
  );
  lines.push(
    stageRow(
      'S3 blast',
      report.s3_blast.every((r) => r.status === 'ok')
        ? 'ok'
        : 'mixed',
      report.s3_blast.reduce((a, r) => a + r.durationMs, 0),
      '',
    ),
  );
  lines.push(stageRow('S4 forensics', report.s4_forensics.status, report.s4_forensics.durationMs));
  lines.push(
    stageRow(
      'S5 testgen',
      report.s5_testgen.every((r) => r.status === 'ok')
        ? 'ok'
        : 'mixed',
      report.s5_testgen.reduce((a, r) => a + r.durationMs, 0),
    ),
  );
  lines.push(
    stageRow(
      'S6 preview',
      report.s6_preview.status,
      report.s6_preview.durationMs,
      report.s6_preview.output ? `pass=${report.s6_preview.output.pass}` : report.s6_preview.reason ?? '',
    ),
  );
  lines.push(
    stageRow(
      'S7 auto-pr',
      report.s7_autopr.status,
      report.s7_autopr.durationMs,
      report.s7_autopr.output?.pr
        ? `[#${report.s7_autopr.output.pr.prNumber}](${report.s7_autopr.output.pr.url})`
        : report.s7_autopr.reason ?? 'dryRun',
    ),
  );
  lines.push('');
  if (report.s7_autopr.output?.pr) {
    lines.push(`✅ 自动 PR/MR 已开: ${report.s7_autopr.output.pr.url}`);
  } else {
    lines.push(
      '_(S7 默认 dryRun；给 issue 加标签 `gitnexus:auto-pr-live` + 配 `GITNEXUS_AUTOPR_TOKEN` 后下次重开 issue 即真发)_',
    );
  }
  return lines.join('\n');
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

  const live = args.issueLabels.includes(LIVE_LABEL);
  const input = buildPipelineInput({
    block,
    fullName: args.fullName,
    issueNumber: args.issueNumber,
    issueTitle: args.issueTitle,
    liveAutoPR: live,
    defaultBaseBranch: args.defaultBaseBranch,
  });
  if (!input) {
    return { ok: false, pipelineStarted: false, reason: 'invalid metadata: spans missing' };
  }

  let report: PipelineReport;
  try {
    report = await deps.runPipeline(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 即便 pipeline 抛错，也要回评一条让开发者知道
    const [owner, repo] = (block.repo ?? args.fullName).split('/');
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
  const [owner, repo] = (block.repo ?? args.fullName).split('/');
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
