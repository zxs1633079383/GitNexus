// MVP MCP 桥接 (mvp/v1.2.0-bridge, 方案 A.2)
//
// 把本仓 (lbug) 的 webhook server 跟全局 gitnexus 1.4.1 (KuzuDB) 索引数据打通。
// 全局 binary 提供 eval-server (HTTP) — 本桥接发 cypher 查 → 拿真业务文件路径。
//
// 关键发现 (2026-04-29 写时验证):
//   · /tool/cypher 稳定可用, 返回 markdown 表格
//   · /tool/impact 在 1.4.1 有 crash bug — 不要碰
//   · cses-java 1.4.1 schema 没有 Route 节点表; 只有 Method + 单一 CodeRelation
//   · Method.id 真实格式: "Method:<filePath>:<name>:<startLine>"
//
// 长期方案: 见 docs/backlog/gitnexus-version-sync.md §3.2 (切 KuzuDB)
//
// query-only — must not be called from any pipeline phase

const BASE = process.env.GITNEXUS_EVAL_BASE ?? 'http://localhost:4848';
const TIMEOUT_MS = Number(process.env.GITNEXUS_EVAL_TIMEOUT_MS ?? 8000);

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
}

/**
 * 用 cypher 走 caller 链算 upstream blast radius (避开 /tool/impact crash bug).
 *
 * direction: upstream (谁调我), downstream (我调谁), both
 * depth: 跳数 (默认 2)
 * limit: 限制 (默认 100)
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
  const name = escLiteral(opts.name);
  const depth = Math.max(1, Math.min(opts.depth ?? 2, 4));
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
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
