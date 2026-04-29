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
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { checkStaleness } from '../src/core/git-staleness.js';
import type { OrchestratorDeps } from '../src/core/pipeline/types.js';

const execFile = promisify(execFileCb);

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

// ─── LLM 并发闸 (H-2): 防止 N 个 issue 同时到 → N 个 claude 进程并行烧钱 ──
const LLM_MAX_CONCURRENT = Math.max(1, Number(process.env.GITNEXUS_LLM_MAX_CONCURRENT ?? 1));
let llmInFlight = 0;
const llmWaitQueue: Array<() => void> = [];
async function acquireLlmSlot(): Promise<void> {
  if (llmInFlight < LLM_MAX_CONCURRENT) {
    llmInFlight++;
    return;
  }
  await new Promise<void>((resolve) => llmWaitQueue.push(resolve));
  llmInFlight++;
}
function releaseLlmSlot(): void {
  llmInFlight = Math.max(0, llmInFlight - 1);
  const next = llmWaitQueue.shift();
  if (next) next();
}

/** topFrame.classMethod 形如 "TaskMemberReader.loadSnapshot" — 切出 class + method. */
function splitClassMethod(cm: string | undefined): { method?: string; cls?: string } {
  if (!cm) return {};
  const idx = cm.lastIndexOf('.');
  if (idx <= 0) return { method: cm };
  return { cls: cm.slice(0, idx), method: cm.slice(idx + 1) };
}

// ─── P1 Auto-reindex Webhook (push 事件) ─────────────────────────────
// 每 repo 单 slot dedup; 检 staleness 早退避免空跑.
// 读 <repoPath>/.gitnexus/meta.json 拿当前索引 commit, 跟 HEAD 比.
// stale → spawn `gitnexus analyze --path <repoPath>` 重建; 不阻塞 webhook 响应.

interface ReindexJob {
  jobId: string;
  startedAt: number;
  status: 'queued' | 'running' | 'done' | 'failed';
  commitsBehind?: number;
  error?: string;
}
const reindexJobs = new Map<string, ReindexJob>();

function readIndexedCommit(repoPath: string): string {
  try {
    const meta = JSON.parse(readFileSync(`${repoPath}/.gitnexus/meta.json`, 'utf8'));
    return typeof meta.lastCommit === 'string' ? meta.lastCommit : '';
  } catch {
    return '';
  }
}

async function p1Reindex(opts: {
  fullName: string;
  repoPath: string;
}): Promise<{ jobId: string; status: string; reason?: string }> {
  const { fullName, repoPath } = opts;
  // dedup 同 repo
  const existing = reindexJobs.get(fullName);
  if (existing && (existing.status === 'queued' || existing.status === 'running')) {
    return { jobId: existing.jobId, status: existing.status, reason: 'dedup' };
  }
  // git fetch + ff-pull (让本地 clone 跟上, LLM 后面要读最新源码)
  try {
    await execFile('git', ['-C', repoPath, 'fetch', '--quiet', 'origin'], { timeout: 60_000 });
    await execFile('git', ['-C', repoPath, 'pull', '--quiet', '--ff-only'], { timeout: 60_000 });
  } catch (e) {
    console.warn(`  → P1 git pull warn (${fullName}): ${(e as Error).message}; 继续走 staleness 检查`);
  }
  const indexed = readIndexedCommit(repoPath);
  if (!indexed) {
    return { jobId: 'noop', status: 'ignored', reason: 'meta.json 缺/坏 — 跑 gitnexus analyze 一次先' };
  }
  const stale = checkStaleness(repoPath, indexed);
  if (!stale.isStale) {
    return { jobId: 'noop', status: 'fresh', reason: '0 commits behind' };
  }
  const jobId = randomUUID();
  const startedAt = Date.now();
  reindexJobs.set(fullName, {
    jobId,
    startedAt,
    status: 'running',
    commitsBehind: stale.commitsBehind,
  });
  console.log(
    `  → P1 reindex start: jobId=${jobId.slice(0, 8)} repo=${fullName} path=${repoPath} ${stale.commitsBehind} commits behind`,
  );
  // detached: false 让 server 退出时一起干掉; stdio pipe 收 stderr 用于诊断
  const child = spawn('gitnexus', ['analyze', '--path', repoPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrTail = '';
  child.stdout?.on('data', () => { /* drain */ });
  child.stderr?.on('data', (b: Buffer) => {
    stderrTail = (stderrTail + b.toString('utf-8')).slice(-2000);
  });
  child.on('close', (code) => {
    const dur = Date.now() - startedAt;
    if (code === 0) {
      reindexJobs.set(fullName, { jobId, startedAt, status: 'done', commitsBehind: stale.commitsBehind });
      console.log(`  ← P1 reindex done: ${fullName} ${stale.commitsBehind} commits, dur=${dur}ms`);
    } else {
      reindexJobs.set(fullName, {
        jobId,
        startedAt,
        status: 'failed',
        commitsBehind: stale.commitsBehind,
        error: `exit ${code}; stderr tail: ${stderrTail.slice(-300)}`,
      });
      console.error(`  ✗ P1 reindex failed: ${fullName} exit=${code} stderr=${stderrTail.slice(-500)}`);
    }
  });
  child.on('error', (e) => {
    reindexJobs.set(fullName, { jobId, startedAt, status: 'failed', error: e.message });
    console.error(`  ✗ P1 reindex spawn error: ${e.message}`);
  });
  return { jobId, status: 'queued', reason: `${stale.commitsBehind} commits behind` };
}

/**
 * S4 真 git log forensics — 在 repoPath 跑 git log -p 找 handler.filePath 最近的 commits.
 *
 * 输出 Top N 嫌疑, 按时间倒序 (越近越嫌疑); rank by 时间近度 (简化版, 没接 blast radius 交叉,
 * 因为 cses-java 索引已经做了 blast 第一道筛). caller 拿 suspects[0] 喂 LLM.
 *
 * 静默失败兜底: repoPath 不存在 / 不是 git / git log 错 → 返 [] 不抛.
 */
async function realGitForensics(opts: {
  repoPath: string;
  filePath: string;
  lookback: number;
  topN: number;
}): Promise<Array<{ hash: string; subject: string; author: string; date: string; diff?: string; resolvedPath?: string }>> {
  if (!existsSync(opts.repoPath)) return [];
  // topFrame.file 通常是短名 'TaskMemberReader.java' (Java stack frame 不带包路径).
  // git pathspec 默认只在 cwd 匹配, 不会递归子目录, 所以短名命中不到.
  // 先用 `git ls-files '*<file>'` 把短名升成仓内完整路径; 没升上就维持原样.
  let resolvedPath = opts.filePath;
  if (!opts.filePath.includes('/')) {
    try {
      const { stdout: lsOut } = await execFile(
        'git',
        ['-C', opts.repoPath, 'ls-files', `*${opts.filePath}`],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      const matches = lsOut.split('\n').filter((l) => l.trim());
      // 优先精确末段匹配 (避免 OtherTaskMemberReader.java 这种前缀冲突)
      const exact = matches.find((m) => m.endsWith('/' + opts.filePath) || m === opts.filePath);
      if (exact) resolvedPath = exact;
      else if (matches.length === 1) resolvedPath = matches[0];
    } catch {
      /* 维持短名原样 */
    }
  }
  try {
    // 1. 拿最近 N 条 commit hash + subject + author + date
    const { stdout: logOut } = await execFile(
      'git',
      [
        '-C',
        opts.repoPath,
        'log',
        `-${Math.max(1, Math.min(opts.lookback, 200))}`,
        '--pretty=format:%H%x09%s%x09%an%x09%ad',
        '--date=iso-strict',
        '--',
        resolvedPath,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const lines = logOut.split('\n').filter((l) => l.trim());
    const suspects: Array<{ hash: string; subject: string; author: string; date: string; diff?: string }> = [];
    const top = lines.slice(0, Math.max(1, opts.topN));
    for (const line of top) {
      const [hash, subject, author, date] = line.split('\t');
      if (!hash) continue;
      // 2. 拉 Top1 的 diff (其他不拉, 省字数)
      let diff: string | undefined;
      if (suspects.length === 0) {
        try {
          const { stdout: diffOut } = await execFile(
            'git',
            ['-C', opts.repoPath, 'show', '--no-color', hash, '--', resolvedPath],
            { maxBuffer: 4 * 1024 * 1024 },
          );
          diff = diffOut.slice(0, 8000); // 截 8KB 防超长
        } catch {
          /* ignore, 留 undefined */
        }
      }
      suspects.push({ hash, subject, author, date, diff, resolvedPath });
    }
    return suspects;
  } catch {
    return [];
  }
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
      const repoPath = REPO_PATH_MAP[fullName];
      if (!repoPath || !existsSync(repoPath)) {
        return {
          suspects: [],
          spanCount: p.spans.length,
          note: `mock - repoPath 未配 (REPO_PATH_MAP[${fullName}] 缺失)`,
        };
      }
      // 从 spans[0] 拉出 handler 文件路径 — 走 normalizer 拿 errorEvent.topFrame.file
      // 没有 topFrame 则跳过 (S4 不抛错, 只返空)
      let handlerFile: string | undefined;
      for (const span of p.spans) {
        const norm = normalizeJaegerSpan(span);
        const f = norm.errorEvent?.topFrame?.file ?? norm.codeFilePath;
        if (f) {
          handlerFile = f;
          break;
        }
      }
      if (!handlerFile) {
        return { suspects: [], spanCount: p.spans.length, note: 'no topFrame.file in spans' };
      }
      // 短名 (Java stack: 'TaskMemberReader.java') 通过 git ls-files 自动升级成仓内完整路径
      const fileGlob = handlerFile.split(/[\\/]/).pop() ?? handlerFile;
      const t0 = Date.now();
      const suspects = await realGitForensics({
        repoPath,
        filePath: fileGlob,
        lookback: p.lookback ?? 50,
        topN: 3,
      });
      const elapsed = Date.now() - t0;
      const resolvedPath = suspects[0]?.resolvedPath ?? fileGlob;
      console.log(
        `  → S4 git log: repo=${repoPath} resolved=${resolvedPath} found=${suspects.length} (${elapsed}ms)`,
      );
      return {
        suspects: suspects.map((s) => ({
          hash: s.hash,
          subject: s.subject,
          author: s.author,
          date: s.date,
          hasDiff: !!s.diff,
        })),
        topSuspectDiff: suspects[0]?.diff,
        topSuspectHash: suspects[0]?.hash,
        topSuspectSubject: suspects[0]?.subject,
        spanCount: p.spans.length,
        handlerFile: resolvedPath,
        note: suspects.length > 0
          ? `git log -- ${resolvedPath} 找到 ${suspects.length} 个嫌疑 commit (Top1 含 diff)`
          : `git log -- ${resolvedPath} 没找到 commit (lookback=${p.lookback ?? 50})`,
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
    // 触发条件:
    //   ① REPO_PATH_MAP 配了本地 clone 路径
    //   ② 路径真存在 (M-4 修, 不让 claude 拿空目录跑)
    genFix: REPO_PATH_MAP[fullName] && existsSync(REPO_PATH_MAP[fullName])
      ? async (p) => {
          const t0 = Date.now();
          const repoPath = REPO_PATH_MAP[fullName];
          // H-2: 走全局 semaphore, 同时 N 个 issue 到也只 LLM_MAX_CONCURRENT 并发
          await acquireLlmSlot();
          console.log(
            `  → genFix start: repoPath=${repoPath} handler=${p.handlerFilePath} blast=${p.blastRadiusFiles.length} suspect=${p.suspectCommit?.hash?.slice(0, 8) ?? 'none'} (slot ${llmInFlight}/${LLM_MAX_CONCURRENT})`,
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
          } finally {
            releaseLlmSlot();
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
  // P1 Auto-reindex (push 事件): git pull + staleness 检查 + 异步 spawn gitnexus analyze
  trigger: async (event) => {
    if (event.kind !== 'push') {
      return { jobId: 'noop', status: 'ignored', reason: `kind=${event.kind} not push` };
    }
    const repoPath = REPO_PATH_MAP[event.fullName];
    if (!repoPath || !existsSync(repoPath)) {
      console.log(`[push] ${event.fullName} → skip (REPO_PATH_MAP 未配)`);
      return { jobId: 'noop', status: 'ignored', reason: 'no REPO_PATH_MAP entry' };
    }
    console.log(`[push] ${event.fullName} headSha=${(event.headSha ?? '').slice(0, 12)} ref=${event.ref ?? '?'}`);
    return await p1Reindex({ fullName: event.fullName, repoPath });
  },
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

// 启动顺序 (H-2 修): 先 ping eval-server 设 bridgeOk → 再 listen, 不留盲窗.
async function startServer(): Promise<void> {
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

  // 同步检查: REPO_PATH_MAP 配的路径是否真存在 (M-4 修)
  for (const [repoFullName, p] of Object.entries(REPO_PATH_MAP)) {
    if (!existsSync(p)) {
      console.warn(`⚠️  GITNEXUS_REPO_PATH_MAP[${repoFullName}]=${p} 路径不存在; 该 repo LLM 自动 disable`);
    }
  }

  const liveActive = process.env.GITNEXUS_AUTOPR_LIVE === '1';
  return new Promise<void>((resolve) => {
    const s = app.listen(PORT, '0.0.0.0', () => {
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`🚀 GitNexus webhook server (cses-pre) listening on 0.0.0.0:${PORT}`);
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`  health   GET  http://localhost:${PORT}/health`);
      console.log(`  webhook  POST http://localhost:${PORT}/webhook (alias)`);
      console.log(`  webhook  POST http://localhost:${PORT}/webhook/gitlab`);
      console.log('');
      console.log(`  provider     ${PROVIDER_KIND}`);
      console.log(`  apiBase      ${API_BASE}`);
      console.log(`  jaegerBase   ${process.env.JAEGER_QUERY_BASE ?? 'unset'}`);
      console.log(
        `  autoPRLive   ${liveActive ? '✅ LIVE 真发 (env+label+S6 三因子)' : '⚠️ dryRun env 关 (即使 label 在也只发 dry-run)'}`,
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
      const validRepoPaths = Object.entries(REPO_PATH_MAP).filter(([, p]) => existsSync(p));
      console.log(
        `  llmPatch     ${validRepoPaths.length > 0 ? `✅ ${validRepoPaths.length} repo (claude -p budget=$${LLM_BUDGET_USD}, max-concurrent=${LLM_MAX_CONCURRENT})` : '⚪ disabled (REPO_PATH_MAP 为空或路径不存在)'}`,
      );
      console.log('═══════════════════════════════════════════════════════════');
      resolve();
    });
    httpServerRef = s;
  });
}

let httpServerRef: ReturnType<typeof app.listen> | null = null;
void startServer();

process.on('SIGTERM', () => {
  console.log('SIGTERM, shutting down...');
  httpServerRef?.close();
  previewMgr.dispose();
});
process.on('SIGINT', () => {
  console.log('SIGINT, shutting down...');
  httpServerRef?.close();
  previewMgr.dispose();
  process.exit(0);
});
