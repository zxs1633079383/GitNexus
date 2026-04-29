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
  }
  if (opts.classHint) {
    const cls = escLiteral(opts.classHint);
    tries.push({
      q: `MATCH (m:Method) WHERE m.name = "${name}" AND m.filePath CONTAINS "${cls}" RETURN m.id AS id, m.filePath AS file, m.startLine AS line LIMIT 1`,
      by: 'name+class',
    });
  }
  tries.push({
    q: `MATCH (m:Method) WHERE m.name = "${name}" RETURN m.id AS id, m.filePath AS file, m.startLine AS line LIMIT 1`,
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
