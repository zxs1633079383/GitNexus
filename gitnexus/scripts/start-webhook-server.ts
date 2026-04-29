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
//   GITNEXUS_AUTOPR_TOKEN     单 repo 时必需 - GitLab PAT
//   GITNEXUS_AUTOPR_TOKEN_MAP 多 repo 时必需 - JSON {"owner/repo": "<pat>", ...}
//                             (优先级高于 GITNEXUS_AUTOPR_TOKEN)
//   GITLAB_API_BASE           默认 http://git.yundiz.com/api/v4
//   JAEGER_QUERY_BASE         默认 http://192.168.6.66:32281
//   GITNEXUS_AUTOPR_LIVE      默认 0 (dryRun); =1 真发 MR
//   GITNEXUS_PROVIDER         默认 gitlab
//   PORT                      默认 3034
//   GITNEXUS_EVAL_BASE        默认 http://localhost:4848 (bridge 目标)
//   GITNEXUS_BRIDGE_REPO      默认 cses-java (eval-server 里的 repo alias)
//   GITNEXUS_BRIDGE_REPO_MAP  可选 JSON {"owner/repo": "<eval-server alias>"}
//                             — 让多个 GitLab repo 走对应索引
//   GITNEXUS_REPO_PATH_MAP    可选 JSON {"owner/repo": "<本地 clone 路径>"}
//                             — 启用 LLM patch 时必需; claude cwd 在这, 出真改代码补丁
//   GITNEXUS_LLM_BUDGET_USD   单次 LLM 调用预算 (默认 1.0)
//   CLAUDE_BIN                claude CLI 路径 (默认 PATH 找 'claude')

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
import { runPatch, violatesSafetyPolicy } from './patch-runner.js';
import type { OrchestratorDeps } from '../src/core/pipeline/types.js';

const SECRET = process.env.GITNEXUS_GITLAB_SECRET ?? '';
const SINGLE_TOKEN = process.env.GITNEXUS_AUTOPR_TOKEN ?? '';
const TOKEN_MAP_RAW = process.env.GITNEXUS_AUTOPR_TOKEN_MAP ?? '';
const API_BASE = process.env.GITLAB_API_BASE ?? 'http://git.yundiz.com/api/v4';
const PORT = Number(process.env.PORT ?? 3034);
const PROVIDER_KIND = process.env.GITNEXUS_PROVIDER ?? 'gitlab';
const BRIDGE_REPO_DEFAULT = process.env.GITNEXUS_BRIDGE_REPO ?? 'cses-java';
const BRIDGE_REPO_MAP_RAW = process.env.GITNEXUS_BRIDGE_REPO_MAP ?? '';

function parseJsonEnv<T = Record<string, string>>(raw: string, name: string): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    console.error(`FATAL: ${name} 不是合法 JSON: ${(e as Error).message}`);
    process.exit(1);
  }
}

const TOKEN_MAP = parseJsonEnv<Record<string, string>>(TOKEN_MAP_RAW, 'GITNEXUS_AUTOPR_TOKEN_MAP');
const BRIDGE_REPO_MAP =
  parseJsonEnv<Record<string, string>>(BRIDGE_REPO_MAP_RAW, 'GITNEXUS_BRIDGE_REPO_MAP') ?? {};
const REPO_PATH_MAP =
  parseJsonEnv<Record<string, string>>(
    process.env.GITNEXUS_REPO_PATH_MAP ?? '',
    'GITNEXUS_REPO_PATH_MAP',
  ) ?? {};
const LLM_BUDGET_USD = Number(process.env.GITNEXUS_LLM_BUDGET_USD ?? '1.0');

function pickToken(fullName: string): string {
  if (TOKEN_MAP) {
    const t = TOKEN_MAP[fullName];
    if (t) return t;
    if (SINGLE_TOKEN) return SINGLE_TOKEN;
    throw new Error(`No token configured for repo "${fullName}" (TOKEN_MAP 未命中且无 fallback TOKEN)`);
  }
  if (!SINGLE_TOKEN) throw new Error('GITNEXUS_AUTOPR_TOKEN / TOKEN_MAP 都未设置');
  return SINGLE_TOKEN;
}

function pickBridgeRepo(fullName: string): string {
  return BRIDGE_REPO_MAP[fullName] ?? BRIDGE_REPO_DEFAULT;
}

if (!SECRET) {
  console.error('FATAL: GITNEXUS_GITLAB_SECRET env required');
  process.exit(1);
}
if (!SINGLE_TOKEN && !TOKEN_MAP) {
  console.error('FATAL: GITNEXUS_AUTOPR_TOKEN 或 GITNEXUS_AUTOPR_TOKEN_MAP 至少要设一个');
  process.exit(1);
}

// providerCache: 避免给同一 repo 反复 new GitLabPRProvider
const providerCache = new Map<string, GitLabPRProvider>();
function getProvider(fullName: string): GitLabPRProvider {
  let p = providerCache.get(fullName);
  if (!p) {
    p = new GitLabPRProvider({ token: pickToken(fullName), apiBase: API_BASE });
    providerCache.set(fullName, p);
  }
  return p;
}
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

// ─── Pipeline deps factory (per-issue: 选 token + 选 bridge repo) ────
function buildDeps(fullName: string): OrchestratorDeps {
  const repo = pickBridgeRepo(fullName);
  const provider = getProvider(fullName);
  return {
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
              repo,
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
          bridgeNote: `bridge hit via ${resolved.resolvedBy} (candidate=${usedCandidate}, repo=${repo})`,
        } as any;
      }

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
          ? `bridge miss for [${candidates.join(',')}] in repo=${repo}`
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
          repo,
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
        strategy: r.strategy,
        risk: r.risk,
        processesAffected: r.processesAffected,
        modulesAffected: r.modulesAffected,
        files: r.files,
        callers: r.callers.slice(0, 50),
        affectedProcesses: r.affectedProcesses,
        affectedModules: r.affectedModules,
        note:
          r.strategy === 'gitnexus-impact-cli'
            ? `gitnexus impact CLI: risk=${r.risk}, ${r.total} impacted`
            : r.strategy === 'cypher-fallback'
              ? `cypher walk fallback (CLI 0 impactedCount): ${r.total} callers`
              : 'no callers found (isolated symbol)',
      };
    },

    regressionForensics: async (p) => {
      return {
        suspects: [],
        spanCount: p.spans.length,
        note: bridgeOk
          ? `bridge ok (repo=${repo}) — forensics 需仓盘 git log, 待 Stage 4 后续实现`
          : 'mock - bridge offline',
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
        note:
          bridgeOk && parsed
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

    // ── 可选: 真 LLM 补丁 + 真断言 (R-14, claude-cli 实现) ──
    // 触发条件: 该 repo 在 REPO_PATH_MAP 里有本地 clone 路径
    genFix: REPO_PATH_MAP[fullName]
      ? async (p) => {
          const t0 = Date.now();
          const repoPath = REPO_PATH_MAP[fullName];
          console.log(
            `  → genFix start: repoPath=${repoPath} handler=${p.handlerFilePath} blast=${p.blastRadiusFiles.length}`,
          );
          try {
            const r = await runPatch({
              repoPath,
              handlerFilePath: p.handlerFilePath,
              handlerSymbolUid: p.handlerSymbolUid,
              errorContext: p.errorContext,
              blastRadiusFiles: p.blastRadiusFiles,
              suspectCommit: p.suspectCommit,
              issueRef: p.issueRef,
              maxBudgetUsd: LLM_BUDGET_USD,
              onProgress: (line) => console.log(`     ${line}`),
            });
            // R-14 路径白名单: 任何违反 → 整体 abort, 不让"半个安全的 patch"过
            for (const f of [...r.fixFiles, ...r.testFiles]) {
              const v = violatesSafetyPolicy(f.path);
              if (v) {
                console.error(`  ✗ genFix 拒绝: ${f.path} 违反 ${v}`);
                return {
                  ok: false,
                  fixFiles: [],
                  testFiles: [],
                  reasoning: r.reasoning,
                  abort: true,
                  reason: `policy violation: ${v} on ${f.path}`,
                  costUsd: r.costUsd,
                  durationMs: r.durationMs,
                };
              }
            }
            console.log(
              `  ← genFix done: ok=${r.ok} fix=${r.fixFiles.length} tests=${r.testFiles.length} cost=$${r.costUsd.toFixed(4)} dur=${Date.now() - t0}ms`,
            );
            return r;
          } catch (e) {
            console.error(`  ✗ genFix threw: ${(e as Error).message}`);
            return {
              ok: false,
              fixFiles: [],
              testFiles: [],
              reasoning: '',
              abort: true,
              reason: `genFix exception: ${(e as Error).message}`,
              costUsd: 0,
              durationMs: Date.now() - t0,
            };
          }
        }
      : undefined,
  };
}

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
    const provider = getProvider(event.fullName);
    const deps = buildDeps(event.fullName);
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
            `  → pipeline spans=${input.spans.length} preview=${!!input.preview} prTarget=${!!input.prTarget} dryRun=${input.prTarget?.dryRun} bridgeRepo=${pickBridgeRepo(event.fullName)}`,
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
  } else if (!bridgeRepos.includes(BRIDGE_REPO_DEFAULT)) {
    console.warn(
      `⚠️  eval-server 已通但 GITNEXUS_BRIDGE_REPO=${BRIDGE_REPO_DEFAULT} 不在已索引列表; 可用: ${bridgeRepos.join(', ')}`,
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
    `  bridge       ${bridgeOk ? `✅ eval-server 通 (default repo=${BRIDGE_REPO_DEFAULT}, ${bridgeRepos.length} indexed)` : '⚠️ offline (mock fallback)'}`,
  );
  console.log(
    `  tokens       ${TOKEN_MAP ? `${Object.keys(TOKEN_MAP).length} per-repo (TOKEN_MAP)` : 'single (TOKEN)'}`,
  );
  if (Object.keys(BRIDGE_REPO_MAP).length > 0) {
    console.log(`  repoMap      ${JSON.stringify(BRIDGE_REPO_MAP)}`);
  }
  console.log(
    `  llmPatch     ${Object.keys(REPO_PATH_MAP).length > 0 ? `✅ ${Object.keys(REPO_PATH_MAP).length} repo (claude -p budget=$${LLM_BUDGET_USD})` : '⚪ disabled (no GITNEXUS_REPO_PATH_MAP)'}`,
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
