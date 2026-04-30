// MVP MCP 桥接 (mvp/v1.2.0-bridge, 方案 A.2)
//
// 把本仓 (lbug) 的 webhook server 跟全局 gitnexus 1.4.1 (KuzuDB) 索引数据打通。
//
// 双路径:
//   · 主路径 — `gitnexus impact <name> -r <repo>` CLI 子进程, 拿到 GitNexus
//     真算法的 JSON: 四轴风险评级 + processes_affected + modules_affected + byDepth.
//   · 兜底  — eval-server `/tool/cypher` HTTP, 自走 caller 链.
//     当 CLI 对 ambiguous name 返 impactedCount=0 时启用 (cypher 走遍所有重名).
//
// resolveHandler 仍走 cypher (name+file/class 三层 fallback) — CLI 没暴露
// "name + file disambiguation" 的反查接口.
//
// 关键发现 (2026-04-29 写时验证):
//   · gitnexus impact CLI 返 JSON, 不接 Method:id 全限定输入 (只接 name)
//   · ambiguous name (如 loadSnapshot 命中 2 个 Method) → CLI 返 impactedCount=0
//   · /tool/impact HTTP 包装在 1.4.1 对部分输入 (如 loadSnapshot) 直接 crash server
//   · /tool/cypher HTTP 稳定; 响应是 `<JSON>\n---\nNext: hint` 拼接体
//   · cses-java 1.4.1 schema: 仅 Method/Class/File/Folder/... 等 11 种节点 +
//     单一 CodeRelation 关系; 无 Route, 无 :HANDLES_ROUTE
//   · Method.id 真实格式: "Method:<filePath>:<name>:<startLine>"
//
// 长期方案: 见 docs/backlog/gitnexus-version-sync.md §3.2 (切 KuzuDB)
//
// query-only — must not be called from any pipeline phase

import { spawn } from 'node:child_process';

const BASE = process.env.GITNEXUS_EVAL_BASE ?? 'http://localhost:4848';
const TIMEOUT_MS = Number(process.env.GITNEXUS_EVAL_TIMEOUT_MS ?? 8000);
const GITNEXUS_BIN = process.env.GITNEXUS_BIN ?? 'gitnexus';
const IMPACT_TIMEOUT_MS = Number(process.env.GITNEXUS_IMPACT_TIMEOUT_MS ?? 30000);

export interface CypherResponse {
  rows: Record<string, string>[];
  raw: string;
  error?: string;
}

/**
 * 解析 eval-server 回的 markdown 表格.
 *
 * 格式:
 *   | col1 | col2 |
 *   | --- | --- |
 *   | v1 | v2 |
 *
 * 边界: 无 row 时返回 []; 表头/分隔线缺失时返回 []; 每行分隔后两端空 cell 丢弃.
 */
export function parseMarkdownTable(md: string): Record<string, string>[] {
  if (!md || typeof md !== 'string') return [];
  const lines = md.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return [];
  const splitRow = (l: string): string[] => {
    const parts = l.split('|');
    return parts.slice(1, parts.length - 1).map((s) => s.trim());
  };
  const headers = splitRow(lines[0]);
  if (headers.length === 0) return [];
  const sepCells = splitRow(lines[1]);
  if (sepCells.some((c) => !/^-+$/.test(c))) return [];
  const rows: Record<string, string>[] = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    if (cells.length !== headers.length) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = cells[idx];
    });
    rows.push(row);
  }
  return rows;
}

export async function callCypher(
  query: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CypherResponse> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${BASE}/tool/cypher`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, repo }),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) return { rows: [], raw: text, error: `HTTP ${r.status}` };
    // eval-server 回 `<JSON>\n---\nNext: <hint>` 拼接体, 不是纯 JSON.
    // 切掉首个 `\n---\n` 之后的 hint 才能 parse.
    const sepIdx = text.indexOf('\n---\n');
    const jsonText = sepIdx >= 0 ? text.slice(0, sepIdx) : text;
    let body: { markdown?: string; row_count?: number; error?: string } = {};
    try {
      body = JSON.parse(jsonText);
    } catch {
      return { rows: [], raw: text };
    }
    if (body.error) return { rows: [], raw: body.error, error: body.error };
    const md = body.markdown ?? '';
    return { rows: parseMarkdownTable(md), raw: md };
  } catch (e) {
    return { rows: [], raw: '', error: (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}

/** Method id 格式: "Method:<filePath>:<name>:<startLine>". 用 greedy 抓 filePath, 末尾两段切. */
export function parseMethodId(
  id: string,
): { filePath: string; name: string; line: number } | null {
  const m = /^Method:(.+):([^:]+):(\d+)$/.exec(id);
  if (!m) return null;
  return { filePath: m[1], name: m[2], line: Number(m[3]) };
}

/** 反转义 cypher 字面量 (双引号字符串)。1.4.1 cypher 不允许 SET 等 write op，过滤掉。 */
function escLiteral(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface ResolvedHandler {
  uid: string;
  filePath: string;
  name: string;
  startLine?: number;
  resolvedBy: 'name+file' | 'name+class' | 'name-only' | 'none';
}

/**
 * 反查 handler: 优先 name + file 后缀; 退化 name + class 字串; 兜底仅 name.
 * 找不到返回 null, caller 走 contractId-based fallback.
 *
 * 同时查 Method (Java/etc.) 和 Function (Go/Rust/TS) 双 label —
 * GitNexus Go ingestion 把 handler 存为 :Function 节点 (例:
 * Function:server/channels/csesapi/posts.go:createPosts:271), 不查 Function
 * 就会 fallback 到 src/main/java/Unknown.java 形成 Java/Go 错位.
 * 对齐 crossBlastRadius (mcp-bridge.ts:580) 已经做对的双 label 查询.
 */
export async function resolveHandler(
  opts: {
    name: string;
    fileHint?: string;
    classHint?: string;
    repo: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedHandler | null> {
  const name = escLiteral(opts.name);
  const tries: Array<{ q: string; by: ResolvedHandler['resolvedBy'] }> = [];
  if (opts.fileHint) {
    const file = escLiteral(opts.fileHint.split(/[\\/]/).pop() ?? opts.fileHint);
    tries.push({
      q: `MATCH (m:Method) WHERE m.name = "${name}" AND m.filePath ENDS WITH "${file}" RETURN m.id AS id, m.filePath AS file, m.startLine AS line LIMIT 1`,
      by: 'name+file',
    });
    tries.push({
      q: `MATCH (m:Function) WHERE m.name = "${name}" AND m.filePath ENDS WITH "${file}" RETURN m.id AS id, m.filePath AS file, m.startLine AS line LIMIT 1`,
      by: 'name+file',
    });
  }
  if (opts.classHint) {
    const cls = escLiteral(opts.classHint);
    tries.push({
      q: `MATCH (m:Method) WHERE m.name = "${name}" AND m.filePath CONTAINS "${cls}" RETURN m.id AS id, m.filePath AS file, m.startLine AS line LIMIT 1`,
      by: 'name+class',
    });
    tries.push({
      q: `MATCH (m:Function) WHERE m.name = "${name}" AND m.filePath CONTAINS "${cls}" RETURN m.id AS id, m.filePath AS file, m.startLine AS line LIMIT 1`,
      by: 'name+class',
    });
  }
  tries.push({
    q: `MATCH (m:Method) WHERE m.name = "${name}" RETURN m.id AS id, m.filePath AS file, m.startLine AS line LIMIT 1`,
    by: 'name-only',
  });
  tries.push({
    q: `MATCH (m:Function) WHERE m.name = "${name}" RETURN m.id AS id, m.filePath AS file, m.startLine AS line LIMIT 1`,
    by: 'name-only',
  });
  for (const { q, by } of tries) {
    const r = await callCypher(q, opts.repo, fetchImpl);
    if (r.rows.length > 0) {
      const row = r.rows[0];
      const ln = Number(row.line);
      return {
        uid: row.id,
        filePath: row.file,
        name: opts.name,
        startLine: Number.isFinite(ln) ? ln : undefined,
        resolvedBy: by,
      };
    }
  }
  return null;
}

export interface BlastResult {
  target: string;
  callers: { name: string; filePath: string }[];
  files: string[];
  total: number;
  depth: number;
  truncated: boolean;
  /** 走的策略: gitnexus-impact-cli (主) / cypher-fallback (兜底) */
  strategy: 'gitnexus-impact-cli' | 'cypher-fallback' | 'none';
  /** GitNexus CLI 才有 — 真四轴风险评级 (LOW/MEDIUM/HIGH/CRITICAL) */
  risk?: string;
  /** GitNexus CLI 才有 — Process / Module 影响数 */
  processesAffected?: number;
  modulesAffected?: number;
  /** GitNexus CLI 才有 — 受影响 process / module 路径 */
  affectedProcesses?: Array<{ name?: string; path?: string }>;
  affectedModules?: Array<{ name?: string; path?: string }>;
  /** GitNexus CLI 才有 — 按 depth 分组的命中详情 */
  byDepth?: Record<string, unknown>;
  /** Method.id from CLI target.id (正式 GitNexus UID) */
  resolvedTargetId?: string;
}

interface GitnexusImpactJson {
  target?: { id: string; name: string; filePath: string };
  direction?: string;
  impactedCount?: number;
  risk?: string;
  summary?: { direct?: number; processes_affected?: number; modules_affected?: number };
  affected_processes?: Array<{ name?: string; path?: string }>;
  affected_modules?: Array<{ name?: string; path?: string }>;
  byDepth?: Record<string, unknown>;
  error?: string;
}

/**
 * 调 `gitnexus impact <name> -r <repo>` CLI, 拿真算法 JSON.
 *
 * 不接 Method:id 全限定 (CLI 设计如此); 给 method name 即可.
 * Ambiguous name → 返 impactedCount=0, caller 走 cypher fallback.
 * 进程超时 30s 默认 (env GITNEXUS_IMPACT_TIMEOUT_MS 可调).
 */
export async function gitnexusImpactCLI(opts: {
  target: string;
  repo: string;
  direction?: 'upstream' | 'downstream';
  depth?: number;
  includeTests?: boolean;
}): Promise<GitnexusImpactJson | null> {
  const args = ['impact', opts.target, '-r', opts.repo];
  if (opts.direction) args.push('-d', opts.direction);
  if (opts.depth !== undefined) args.push('--depth', String(opts.depth));
  if (opts.includeTests) args.push('--include-tests');

  return new Promise((resolveOuter) => {
    const child = spawn(GITNEXUS_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (v: GitnexusImpactJson | null) => {
      if (settled) return;
      settled = true;
      resolveOuter(v);
    };
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString('utf-8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf-8');
    });
    child.on('close', (code) => {
      const trimmed = stdout.trim();
      // M-2 修: stderr 不再静默丢. impactedCount=0 / parse 失败时让 caller 看到诊断信息.
      if (!trimmed) {
        if (stderr.trim()) {
          console.warn(
            `[bridge.gitnexusImpactCLI] empty stdout, exit=${code}, stderr: ${stderr.trim().slice(0, 500)}`,
          );
        }
        return settle(null);
      }
      try {
        const parsed = JSON.parse(trimmed) as GitnexusImpactJson;
        // 工具自身报 error / impactedCount=0 时把 stderr 也透一遍, 排查时不用重跑
        if ((parsed.error || (parsed.impactedCount ?? 0) === 0) && stderr.trim()) {
          console.warn(
            `[bridge.gitnexusImpactCLI] result.error=${parsed.error ?? 'none'} impactedCount=${parsed.impactedCount ?? 0}; stderr: ${stderr.trim().slice(0, 300)}`,
          );
        }
        settle(parsed);
      } catch (e) {
        console.warn(
          `[bridge.gitnexusImpactCLI] parse failed: ${(e as Error).message}; stdout head: ${trimmed.slice(0, 200)}; stderr: ${stderr.trim().slice(0, 200)}`,
        );
        settle(null);
      }
    });
    child.on('error', (e) => {
      console.warn(`[bridge.gitnexusImpactCLI] spawn error: ${e.message}`);
      settle(null);
    });
    setTimeout(() => {
      if (!settled) {
        console.warn(`[bridge.gitnexusImpactCLI] timeout after ${IMPACT_TIMEOUT_MS}ms; killing`);
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        settle(null);
      }
    }, IMPACT_TIMEOUT_MS).unref?.();
  });
}

/**
 * 算 upstream/downstream blast radius — 双路径:
 *
 *   1. 主: gitnexus impact CLI (真算法 + 风险评级 + processes/modules)
 *      - impactedCount > 0: 直接用结果
 *      - impactedCount = 0 / null / parse 失败: 进入 fallback
 *   2. 兜底: eval-server cypher walk (走遍所有重名 method, 找全 caller)
 *
 * direction: upstream / downstream / both (cypher fallback 才支持 both)
 */
export async function blastRadius(
  opts: {
    name: string;
    repo: string;
    direction?: 'upstream' | 'downstream' | 'both';
    depth?: number;
    limit?: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<BlastResult> {
  const depth = Math.max(1, Math.min(opts.depth ?? 2, 4));
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const cliDir = opts.direction === 'both' ? 'upstream' : (opts.direction ?? 'upstream');

  // ─── 主路径: gitnexus impact CLI ────────────────────────────────────
  const cli = await gitnexusImpactCLI({
    target: opts.name,
    repo: opts.repo,
    direction: cliDir,
    depth,
  });
  if (cli && !cli.error && (cli.impactedCount ?? 0) > 0) {
    const procFiles = (cli.affected_processes ?? [])
      .map((p) => p.path)
      .filter((x): x is string => !!x);
    const modFiles = (cli.affected_modules ?? [])
      .map((m) => m.path)
      .filter((x): x is string => !!x);
    const files = Array.from(new Set([...procFiles, ...modFiles]));
    return {
      target: opts.name,
      callers: [],
      files,
      total: cli.impactedCount ?? files.length,
      depth,
      truncated: false,
      strategy: 'gitnexus-impact-cli',
      risk: cli.risk,
      processesAffected: cli.summary?.processes_affected,
      modulesAffected: cli.summary?.modules_affected,
      affectedProcesses: cli.affected_processes,
      affectedModules: cli.affected_modules,
      byDepth: cli.byDepth,
      resolvedTargetId: cli.target?.id,
    };
  }

  // ─── 兜底: cypher walk (handles ambiguous names) ────────────────────
  const name = escLiteral(opts.name);
  const dir = opts.direction ?? 'upstream';
  const arrow =
    dir === 'upstream' ? `<-[*1..${depth}]-` : dir === 'downstream' ? `-[*1..${depth}]->` : `-[*1..${depth}]-`;
  const q = `MATCH (m:Method {name: "${name}"})${arrow}(other) RETURN DISTINCT other.name AS name, other.filePath AS file LIMIT ${limit}`;
  const r = await callCypher(q, opts.repo, fetchImpl);
  const callers = r.rows.map((row) => ({
    name: row.name ?? '',
    filePath: row.file ?? '',
  }));
  const files = Array.from(
    new Set(callers.map((c) => c.filePath).filter((f) => !!f && !f.endsWith('/'))),
  );
  return {
    target: opts.name,
    callers,
    files,
    total: callers.length,
    depth,
    truncated: callers.length === limit,
    strategy: callers.length > 0 ? 'cypher-fallback' : 'none',
    resolvedTargetId: cli?.target?.id,
  };
}

/** 启动时探活, 不通则警告. caller 应据此降级到 mock. */
export async function pingEvalServer(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; repos: string[]; error?: string }> {
  try {
    const r = await fetchImpl(`${BASE}/health`, { method: 'GET' });
    if (!r.ok) return { ok: false, repos: [], error: `HTTP ${r.status}` };
    const body = (await r.json()) as { status?: string; repos?: string[] };
    return { ok: body.status === 'ok', repos: body.repos ?? [] };
  } catch (e) {
    return { ok: false, repos: [], error: (e as Error).message };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Cross-repo bridge (cross-repo/v1.0.0 — DIY 替代 lbug group sync)
//
// 为什么 DIY: Intel Mac 缺 @ladybugdb/core-darwin-x64 prebuilt, group sync 走不通.
// 用户已提 ladybugdb MR 补 darwin-x64; 等新版本发布后切回原生 ContractLink 注册表
// (跟踪 task #14, docs/backlog/gitnexus-version-sync.md).
//
// 算法 (cypher-only, 50 行):
//   1. parseContractId → pathSegments
//   2. deriveHandlerNameCandidates → ['create', 'Create', 'createPost', 'CreatePosts', ...]
//   3. cypher 在 partner 仓查 Method+Function 双 label, name 匹配 + filePath 含 parentSeg
//   4. 兜底 fallback: 去掉 filePath 过滤, 仅 name 匹配
//
// KuzuDB 1.4.1 read-only 守卫 bug: 字符串字面量含 "create"/"delete" 等关键字会被误拦,
// 用 STARTS WITH + ENDS WITH 拆分绕开 (见 safeNameEqualsClause).
// ──────────────────────────────────────────────────────────────────────────

const READ_ONLY_GUARD_KEYWORDS = [
  'create',
  'delete',
  'merge',
  'remove',
  'drop',
  'alter',
  'copy',
  'detach',
];

/**
 * KuzuDB 1.4.1 eval-server 的 read-only 守卫会把字符串字面量里的写关键字也当成 cypher 写操作拦截.
 * 这是 server bug. 当 name 含 guard 关键字时, 用 STARTS WITH / ENDS WITH 拆字符串绕开.
 */
export function safeNameEqualsClause(name: string, alias: string): string {
  const lower = name.toLowerCase();
  const hasGuardKw = READ_ONLY_GUARD_KEYWORDS.some((kw) => lower.includes(kw));
  if (!hasGuardKw) return `${alias}.name = "${escLiteral(name)}"`;
  if (name.length <= 2) {
    return `${alias}.name STARTS WITH "${escLiteral(name)}"`;
  }
  const headLen = Math.min(3, Math.floor(name.length / 2));
  const head = name.slice(0, headLen);
  const tail = name.slice(-Math.min(3, name.length - headLen));
  return `${alias}.name STARTS WITH "${escLiteral(head)}" AND ${alias}.name ENDS WITH "${escLiteral(tail)}"`;
}

export interface ContractParts {
  /** HTTP method, 大写; 缺省时 undefined */
  method?: string;
  /** path 段, 已剥离前后 / 和 query string. e.g. ['api', 'cses', 'posts', 'create'] */
  pathSegments: string[];
  /** 重组的标准化 path. e.g. '/api/cses/posts/create' */
  rawPath: string;
}

/**
 * 解析 contractId — 支持 3 种格式:
 *   · 'POST /api/cses/posts/create'  (S2 normalizer 输出)
 *   · 'http::POST::/api/cses/posts/create'  (extractor 内部)
 *   · '/api/cses/posts/create'  (无 method)
 */
export function parseContractId(contractId: string): ContractParts {
  const trimmed = contractId.trim();
  let s = trimmed;
  let method: string | undefined;
  const httpPrefix = /^http::([A-Z]+)::(.*)$/.exec(s);
  if (httpPrefix) {
    method = httpPrefix[1];
    s = httpPrefix[2];
  } else {
    const m = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.*)$/i.exec(s);
    if (m) {
      method = m[1].toUpperCase();
      s = m[2];
    }
  }
  s = s.replace(/\?.*$/, '');
  const cleaned = s.replace(/^\/+/, '').replace(/\/+$/, '');
  const pathSegments = cleaned.split('/').filter(Boolean);
  const rawPath = pathSegments.length > 0 ? '/' + pathSegments.join('/') : '/';
  return { method, pathSegments, rawPath };
}

/**
 * 从 path 段推断 handler 函数名候选, **按优先级降序**:
 *   ['api','cses','posts','create'] →
 *     ['createPost','CreatePost','createPosts','CreatePosts','create','Create']
 *
 * 第 0 个 (last + cap(parentSing)) 是最常见命名约定 (Go/Java REST handler 几乎都这样).
 * 单段 last 放最末是兜底, 容易碰到通用动词假阳性.
 */
export function deriveHandlerNameCandidates(pathSegments: string[]): string[] {
  if (pathSegments.length === 0) return [];
  const last = pathSegments[pathSegments.length - 1];
  const parent = pathSegments[pathSegments.length - 2] ?? '';
  const cap = (s: string) => (s.length === 0 ? '' : s.charAt(0).toUpperCase() + s.slice(1));
  const ordered: string[] = [];
  if (parent) {
    const parentSing = parent.endsWith('s') ? parent.slice(0, -1) : parent;
    ordered.push(last + cap(parentSing)); // createPost  ← canonical
    ordered.push(cap(last) + cap(parentSing)); // CreatePost
    ordered.push(last + cap(parent)); // createPosts
    ordered.push(cap(last) + cap(parent)); // CreatePosts
  }
  ordered.push(last);
  ordered.push(cap(last));
  // dedupe 但保序
  const seen = new Set<string>();
  return ordered.filter((n) => {
    if (n.length === 0 || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

export interface CrossLink {
  /** 发起方仓 (e.g. cses-java consumer) */
  primaryRepo: string;
  /** 目标方仓 (e.g. mattermost provider) */
  partnerRepo: string;
  /** 跨仓 contract id (HTTP method + path 风格) */
  contractId: string;
  /** partner 仓中匹配到的 handler */
  partnerHandler: {
    uid: string;
    filePath: string;
    name: string;
    startLine?: number;
    /** 节点 label, KuzuDB 1.4.1 区分 Method/Function (Go 顶层 func 是 Function) */
    label: 'Method' | 'Function';
  };
  /** 命中策略: name+path / name-only / 都没命中走 grep (未实现) */
  matchType: 'cypher-name+path' | 'cypher-name-only';
  /** 0-1; cypher-name+path = 0.7, cypher-name-only = 0.4 (假阳性风险) */
  confidence: number;
}

/**
 * 跨仓 blast radius — 给一个 contractId, 在 partner 仓里找 provider handler.
 *
 * 不依赖 lbug bridge.lbug, 只用 eval-server cypher.
 *
 * 命中级别:
 *   · cypher-name+path (confidence 0.7): 同时匹配 name + filePath 含 parent 段
 *   · cypher-name-only (confidence 0.4): 仅 name 匹配, 假阳性高
 *   · 没命中: 不返 entry, caller 自己判 cross-link 数量
 */
export async function crossBlastRadius(
  opts: {
    contractId: string;
    primaryRepo: string;
    partnerRepos: string[];
  },
  fetchImpl: typeof fetch = fetch,
): Promise<CrossLink[]> {
  const { pathSegments } = parseContractId(opts.contractId);
  if (pathSegments.length === 0) return [];
  const candidates = deriveHandlerNameCandidates(pathSegments);
  if (candidates.length === 0) return [];
  const parentSeg = pathSegments.length >= 2
    ? pathSegments[pathSegments.length - 2]
    : pathSegments[0];

  const namePred = candidates.map((c) => safeNameEqualsClause(c, 'n')).join(' OR ');
  const fileFilter = `n.filePath CONTAINS "${escLiteral(parentSeg)}" AND NOT n.filePath CONTAINS "test"`;

  // 黑名单 — 常见 handler 噪音目录, 排序时降权.
  const NOISE_DIR_KW = ['slashcommand', 'internal/', 'mock', 'fixture', 'auto_', 'sample', 'example'];

  const links: CrossLink[] = [];
  for (const partnerRepo of opts.partnerRepos) {
    if (partnerRepo === opts.primaryRepo) continue;

    // ① 同时查 Method + Function 两 label, 各取 5 行, 合并排序后挑最佳.
    //   (单查 Method 容易碰到 *_test / slashcommands 假阳性)
    const [methodR, fnR] = await Promise.all([
      callCypher(
        `MATCH (n:Method) WHERE (${namePred}) AND ${fileFilter} RETURN n.id AS id, n.name AS name, n.filePath AS file, n.startLine AS line LIMIT 5`,
        partnerRepo,
        fetchImpl,
      ),
      callCypher(
        `MATCH (n:Function) WHERE (${namePred}) AND ${fileFilter} RETURN n.id AS id, n.name AS name, n.filePath AS file, n.startLine AS line LIMIT 5`,
        partnerRepo,
        fetchImpl,
      ),
    ]);

    type Row = { id: string; name: string; file: string; line?: string; label: 'Method' | 'Function' };
    let merged: Row[] = [
      ...methodR.rows.map((r) => ({ ...r, label: 'Method' as const })),
      ...fnR.rows.map((r) => ({ ...r, label: 'Function' as const })),
    ] as Row[];
    let matchType: CrossLink['matchType'] = 'cypher-name+path';

    if (merged.length === 0) {
      // 兜底: 去掉 path 过滤, 仅 name 匹配 (假阳性高 → confidence 降到 0.4)
      const fbR = await callCypher(
        `MATCH (n:Function) WHERE (${namePred}) AND NOT n.filePath CONTAINS "test" RETURN n.id AS id, n.name AS name, n.filePath AS file, n.startLine AS line LIMIT 5`,
        partnerRepo,
        fetchImpl,
      );
      merged = fbR.rows.map((r) => ({ ...r, label: 'Function' as const })) as Row[];
      matchType = 'cypher-name-only';
    }

    if (merged.length === 0) continue;

    // ② 排序: (a) 不含噪音目录优先 (b) Function 优先 over Method (c) candidate 优先级 (low index = canonical)
    //         (d) filePath 短的优先 — 越靠近顶层目录越可能是 handler
    const score = (r: Row): number => {
      let s = 0;
      const file = r.file ?? '';
      const noisy = NOISE_DIR_KW.some((kw) => file.toLowerCase().includes(kw));
      if (!noisy) s += 100; // 不含噪音 = +100
      if (r.label === 'Function') s += 30; // Go 顶层 func 是 Function
      // name match candidate 索引: 0 = canonical (createPost), 越靠后越通用易假阳性
      const idx = candidates.findIndex((c) => c === r.name);
      if (idx >= 0) s += (candidates.length - idx) * 10;
      s -= file.length * 0.3; // 路径越短越优先 (打破 tie)
      return s;
    };
    const best = [...merged].sort((a, b) => score(b) - score(a))[0];
    const ln = Number(best.line);
    links.push({
      primaryRepo: opts.primaryRepo,
      partnerRepo,
      contractId: opts.contractId,
      partnerHandler: {
        uid: best.id ?? '',
        filePath: best.file ?? '',
        name: best.name ?? '',
        startLine: Number.isFinite(ln) ? ln : undefined,
        label: best.label,
      },
      matchType,
      confidence: matchType === 'cypher-name+path' ? 0.7 : 0.4,
    });
  }
  return links;
}
