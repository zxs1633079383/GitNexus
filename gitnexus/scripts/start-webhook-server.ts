// Production-grade webhook server (cses-pre 接入用)
//
// 不依赖 LocalBackend (lbug native 在某些环境无法启动)
// 直接挂 mountWebhookRoutes + issueTrigger，pipeline 用注入的 deps
//
// mvp/v1.2.0-bridge 起 — 通过 mcp-bridge 走全局 gitnexus eval-server (KuzuDB)
// 反查真索引数据。bridge 不可达时自动降级 mock。
// 详见 docs/backlog/gitnexus-version-sync.md.
//
// 启动:
//   gitnexus eval-server --port 4848 &      # 必需，全局 1.4.1 binary
//   npx tsx scripts/start-webhook-server.ts
//
// env:
//   GITNEXUS_GITLAB_SECRET    必需 - webhook 验签
//   GITNEXUS_AUTOPR_TOKEN     必需 - GitLab PAT
//   GITLAB_API_BASE           默认 http://git.yundiz.com/api/v4
//   JAEGER_QUERY_BASE         默认 http://192.168.6.66:32281
//   GITNEXUS_AUTOPR_LIVE      默认 0 (dryRun); =1 真发 MR
//   GITNEXUS_PROVIDER         默认 gitlab
//   PORT                      默认 3034
//   GITNEXUS_EVAL_BASE        默认 http://localhost:4848 (bridge 目标)
//   GITNEXUS_BRIDGE_REPO      默认 cses-java (eval-server 里的 repo alias)

import express from 'express';
import { mountWebhookRoutes } from '../src/server/webhook/handler.js';
import { handleIssueOpened } from '../src/core/observability/issue-handler.js';
import { runPipeline } from '../src/core/pipeline/orchestrator.js';
import { runAutoPR } from '../src/core/auto-pr/auto-pr.js';
import { GitLabPRProvider } from '../src/core/auto-pr/providers/gitlab.js';
import { PreviewJobManager } from '../src/core/preview/preview-job-manager.js';
import {
  validateInPreview,
  checkPreviewStatus,
} from '../src/core/preview/mcp-handlers.js';
import { normalizeJaegerSpan } from '../src/core/observability/jaeger-span-normalizer.js';
import {
  pingEvalServer,
  resolveHandler,
  blastRadius,
  parseMethodId,
} from './mcp-bridge.js';
import type { OrchestratorDeps } from '../src/core/pipeline/types.js';

const SECRET = process.env.GITNEXUS_GITLAB_SECRET ?? '';
const TOKEN = process.env.GITNEXUS_AUTOPR_TOKEN ?? '';
const API_BASE = process.env.GITLAB_API_BASE ?? 'http://git.yundiz.com/api/v4';
const PORT = Number(process.env.PORT ?? 3034);
const PROVIDER_KIND = process.env.GITNEXUS_PROVIDER ?? 'gitlab';
const BRIDGE_REPO = process.env.GITNEXUS_BRIDGE_REPO ?? 'cses-java';

if (!SECRET) {
  console.error('FATAL: GITNEXUS_GITLAB_SECRET env required');
  process.exit(1);
}
if (!TOKEN) {
  console.error('FATAL: GITNEXUS_AUTOPR_TOKEN env required');
  process.exit(1);
}

const provider = new GitLabPRProvider({ token: TOKEN, apiBase: API_BASE });
const previewMgr = new PreviewJobManager({ maxConcurrent: 3, autoReaper: true });

// ─── Bridge 状态 (启动时填) ────────────────────────────────────
let bridgeOk = false;
let bridgeRepos: string[] = [];

/** topFrame.classMethod 形如 "TaskMemberReader.loadSnapshot" — 切出 class + method. */
function splitClassMethod(cm: string | undefined): { method?: string; cls?: string } {
  if (!cm) return {};
  const idx = cm.lastIndexOf('.');
  if (idx <= 0) return { method: cm };
  return { cls: cm.slice(0, idx), method: cm.slice(idx + 1) };
}

/** contractId "http::POST::/Collaborate/loadWorkOrientForMember" → 末段 "loadWorkOrientForMember". */
function methodNameFromContract(contractId: string | undefined): string | undefined {
  if (!contractId) return undefined;
  const parts = contractId.split('::');
  const path = parts[parts.length - 1] ?? '';
  const last = path.split('/').filter(Boolean).pop();
  if (!last || last.startsWith('{') || /^\d+$/.test(last)) return undefined;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(last) ? last : undefined;
}

// ─── Pipeline deps (bridge-aware, 失败自动降级 mock) ─────────────
const deps: OrchestratorDeps = {
  resolveSpan: async (span) => {
    const norm = normalizeJaegerSpan(span);
    const top = norm.errorEvent?.topFrame;
    const { method: stackMethod, cls: stackClass } = splitClassMethod(top?.classMethod);
    const codeName =
      norm.codeFunction && norm.codeFunction !== top?.classMethod
        ? splitClassMethod(norm.codeFunction).method
        : undefined;
    const contractMethod = methodNameFromContract(norm.contractId);

    const candidates = [stackMethod, codeName, contractMethod].filter(
      (x): x is string => !!x,
    );
    let resolved: Awaited<ReturnType<typeof resolveHandler>> | null = null;
    let usedCandidate: string | undefined;
    if (bridgeOk) {
      for (const name of candidates) {
        resolved = await resolveHandler(
          {
            name,
            fileHint: top?.file ?? norm.codeFilePath,
            classHint: stackClass,
            repo: BRIDGE_REPO,
          },
          fetch,
        );
        if (resolved) {
          usedCandidate = name;
          break;
        }
      }
    }

    if (resolved) {
      return {
        resolved: true,
        handler: {
          uid: resolved.uid,
          filePath: resolved.filePath,
          name: resolved.name,
          startLine: resolved.startLine,
        },
        kind: norm.kind ?? 'http',
        contractId: norm.contractId,
        topFrame: top,
        resolvedBy: resolved.resolvedBy,
        bridgeNote: `bridge hit via ${resolved.resolvedBy} (candidate=${usedCandidate})`,
      } as any;
    }

    // bridge miss / down → fallback (跟 v1.1.0 行为一致, 但加诊断字段)
    const fallbackUid = norm.contractId
      ? `Method:${norm.contractId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60)}`
      : `Method:Unknown_${(span as any).spanID?.slice(0, 6) ?? 'x'}`;
    return {
      resolved: true,
      handler: {
        uid: fallbackUid,
        filePath: top?.file ?? norm.codeFilePath ?? 'src/main/java/Unknown.java',
        name: norm.contractId ?? candidates[0] ?? 'unknown',
      },
      kind: norm.kind ?? 'http',
      contractId: norm.contractId,
      topFrame: top,
      resolvedBy: 'fallback',
      bridgeNote: bridgeOk
        ? `bridge miss for [${candidates.join(',')}] in repo=${BRIDGE_REPO}`
        : 'bridge offline — mock fallback',
    } as any;
  },

  apiBlastRadius: async (p) => {
    const parsed = parseMethodId(p.target_uid);
    const name = parsed?.name;
    if (!bridgeOk || !name) {
      return {
        target_uid: p.target_uid,
        files: [],
        callers: [],
        note: bridgeOk
          ? 'bridge ok but target_uid not parsable as Method id (fallback handler)'
          : 'bridge offline — mock fallback',
      };
    }
    const r = await blastRadius(
      {
        name,
        repo: BRIDGE_REPO,
        direction: 'upstream',
        depth: p.depth ?? 2,
        limit: 100,
      },
      fetch,
    );
    return {
      target_uid: p.target_uid,
      target_name: name,
      depth: r.depth,
      total: r.total,
      truncated: r.truncated,
      files: r.files,
      callers: r.callers.slice(0, 50),
      note: r.total === 0 ? 'no callers found (isolated symbol)' : `bridge cypher upstream depth=${r.depth}`,
    };
  },

  regressionForensics: async (p) => {
    // 真 forensics 需要 git log + handler filePath 过滤; 当前 webhook server 不挂仓盘.
    // bridge 启用时至少标记真路径来源, 留给 Stage 4 后续实现.
    return {
      suspects: [],
      spanCount: p.spans.length,
      note: bridgeOk
        ? 'bridge ok — forensics 需仓盘 git log, 待 Stage 4 后续实现 (issue 上 trace 含真 spans)'
        : 'mock - 业务仓未 GitNexus 索引',
    };
  },

  genE2ETests: async (p) => {
    const parsed = parseMethodId(p.target_uid);
    const safeName = (parsed?.name ?? 'unknown').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);
    return {
      target_uid: p.target_uid,
      files: [
        { path: `src/test/auto-generated/Test_${safeName}.java` },
      ],
      sourceHandlerFile: parsed?.filePath ?? null,
      note: bridgeOk && parsed
        ? `R-1 scaffold + TODO 占位 (bridge: 引用真 handler ${parsed.filePath})`
        : 'R-1 scaffold + TODO 占位',
    };
  },

  validateInPreview: async (p) =>
    validateInPreview(previewMgr, p as any) as any,
  checkPreviewStatus: async (p) =>
    checkPreviewStatus(previewMgr, p as any) as any,
  autoPR: async (p) =>
    await runAutoPR({
      candidate: p.candidate,
      provider,
      dryRun: !!p.dryRun,
      stage6Pass: !!p.stage6Pass,
    }),
};

const app = express();

// 健康探活
app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    service: 'gitnexus-webhook-server',
    routes: ['/webhook', '/webhook/gitlab', '/health'],
    provider: PROVIDER_KIND,
    apiBase: API_BASE,
    liveMode: process.env.GITNEXUS_AUTOPR_LIVE === '1',
  }),
);

mountWebhookRoutes(app, {
  gitlabSecret: SECRET,
  trigger: async () => ({ jobId: 'noop', status: 'ignored' }),
  issueTrigger: async (event) => {
    console.log(
      `[issue] ${event.fullName} #${event.issueNumber} labels=${(event.issueLabels ?? []).join(',')}`,
    );
    const r = await handleIssueOpened(
      {
        fullName: event.fullName,
        issueNumber: event.issueNumber!,
        issueTitle: event.issueTitle!,
        issueBody: event.issueBody!,
        issueLabels: event.issueLabels!,
      },
      {
        runPipeline: async (input) => {
          console.log(
            `  → pipeline spans=${input.spans.length} preview=${!!input.preview} prTarget=${!!input.prTarget} dryRun=${input.prTarget?.dryRun}`,
          );
          return await runPipeline(input, deps);
        },
        postIssueComment: async (a) => await provider.postIssueComment(a),
      },
    );
    console.log(
      `  ← handler ok=${r.ok} pipelineStarted=${r.pipelineStarted} commentUrl=${r.commentUrl}`,
    );
    return {
      ok: r.ok,
      pipelineStarted: r.pipelineStarted,
      reason: r.reason,
      commentUrl: r.commentUrl,
    };
  },
});

// 启动: 先 ping bridge, 再监听端口
const httpServer = app.listen(PORT, '0.0.0.0', async () => {
  const ping = await pingEvalServer(fetch);
  bridgeOk = ping.ok;
  bridgeRepos = ping.repos;
  if (!bridgeOk) {
    console.warn(
      `⚠️  GitNexus eval-server 不可达 (${ping.error ?? 'unknown'}); ` +
        `S2-S5 走 mock fallback. 启动: gitnexus eval-server --port 4848 &`,
    );
  } else if (!bridgeRepos.includes(BRIDGE_REPO)) {
    console.warn(
      `⚠️  eval-server 已通但 GITNEXUS_BRIDGE_REPO=${BRIDGE_REPO} 不在已索引列表; 可用: ${bridgeRepos.join(', ')}`,
    );
  }
  console.log(
    '═══════════════════════════════════════════════════════════',
  );
  console.log(
    `🚀 GitNexus webhook server (cses-pre) listening on 0.0.0.0:${PORT}`,
  );
  console.log(
    '═══════════════════════════════════════════════════════════',
  );
  console.log(`  health   GET  http://localhost:${PORT}/health`);
  console.log(`  webhook  POST http://localhost:${PORT}/webhook (alias)`);
  console.log(`  webhook  POST http://localhost:${PORT}/webhook/gitlab`);
  console.log('');
  console.log(`  provider     ${PROVIDER_KIND}`);
  console.log(`  apiBase      ${API_BASE}`);
  console.log(`  jaegerBase   ${process.env.JAEGER_QUERY_BASE ?? 'unset'}`);
  console.log(
    `  autoPRLive   ${process.env.GITNEXUS_AUTOPR_LIVE === '1' ? '✅ LIVE 真发' : '⚠️ dryRun (默认安全)'}`,
  );
  console.log(
    `  bridge       ${bridgeOk ? `✅ eval-server 通 (repo=${BRIDGE_REPO}, ${bridgeRepos.length} indexed)` : '⚠️ offline (mock fallback)'}`,
  );
  console.log(
    '═══════════════════════════════════════════════════════════',
  );
});

process.on('SIGTERM', () => {
  console.log('SIGTERM, shutting down...');
  httpServer.close();
  previewMgr.dispose();
});
process.on('SIGINT', () => {
  console.log('SIGINT, shutting down...');
  httpServer.close();
  previewMgr.dispose();
  process.exit(0);
});
