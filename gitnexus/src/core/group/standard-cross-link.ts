// 标准链路跨仓 ContractLink 查询 (替代 mcp-bridge.crossBlastRadius DIY).
//
// 设计: 直接 readOnly 打开 bridge.lbug, 用 cypher 查 ContractLink 表, 转成
//       OrchestratorDeps.crossBlastRadius 期望的 CrossLinkOutput[] 形态.
//       这是 runGroupImpact 内部 CY_NEIGHBORS_UPSTREAM 那一步的简化版 — 不依赖
//       GroupToolPort 全套实现 (那个要管 multi-repo connection lifecycle).
//
// 与 runGroupImpact 的区别:
//   - 不调 port.impactByUid 在 partner 仓走主图 BFS (manifest synthetic uid 也无法走)
//   - 不算 mergeRisk 四轴评级
//   - 只回答"contractId 跨仓配对到谁"这一个问题, 给 orchestrator S3 段消费
//
// caller (start-webhook-server.ts) 期望: miss / error 时返空数组, 不抛异常.
// orchestrator.ts:312 检查 length === 0 时不渲染 cross-link 段.
//
// 关联文档: docs/learn/lbug-切换-回归测试-环境清单-v1.md 段 D1

import * as fs from 'node:fs';
import * as path from 'node:path';
import lbug from '@ladybugdb/core';
import { getDefaultGitnexusDir, getGroupDir } from './storage.js';
import { readBridgeMeta } from './bridge-db.js';
import { BRIDGE_SCHEMA_VERSION } from './bridge-schema.js';
import type { CrossLinkOutput } from '../pipeline/types.js';

export interface StandardCrossLinkOpts {
  /** group 名 (默认 cses-mm) */
  groupName: string;
  /** 当前仓的 group path (defaultResolveHandle 里用的 key, 通常 = registry name) */
  primaryRepo: string;
  /** 输入: contractId, 形如 "POST /api/cses/posts/create" 或 "http::POST::/api/cses/posts/create" */
  contractId: string;
}

/**
 * 标准链路 cross-link 查询. miss/error 一律返 [], 不抛.
 * Caller 收到 [] 后可决定 fallback DIY 或不渲染.
 */
export async function lookupStandardCrossLink(
  opts: StandardCrossLinkOpts,
): Promise<CrossLinkOutput[]> {
  const groupDir = getGroupDir(getDefaultGitnexusDir(), opts.groupName);
  const dbPath = path.join(groupDir, 'bridge.lbug');
  if (!fs.existsSync(dbPath)) return [];

  // schema version 校验 — 不一致直接放弃 (跟 ensureBridgeReady 一致行为)
  try {
    const meta = await readBridgeMeta(groupDir);
    if (meta.version !== BRIDGE_SCHEMA_VERSION) return [];
  } catch {
    return [];
  }

  // 归一 contractId 到 bridge 存的形态: "http::POST::/api/cses/posts/create"
  // 入参 3 种形态 (跟 mcp-bridge.parseContractId 对齐):
  //   "http::POST::/path"  ← bridge 存的形态, 原样
  //   "POST /path"         ← S2 normalizer 输出, 转 "http::POST::/path"
  //   "/path"              ← 无 method, 转 "http::GET::/path" (默认 GET)
  const normalizedCid = normalizeContractIdToBridge(opts.contractId);
  if (!normalizedCid) return [];

  let db: any;
  let conn: any;
  try {
    db = new (lbug as any).Database(dbPath, 0, false, true); // readOnly
    conn = new (lbug as any).Connection(db);

    // 主查询: primaryRepo 是 consumer, 找 partner repo 的 provider Contract.
    // ContractLink 边方向: consumer → provider (writeBridge 写入约定).
    // 注意 cypher 字符串 escaping — contractId 里只有 ASCII + / + : + 字母数字.
    const cidEscaped = normalizedCid.replace(/"/g, '\\"');
    const repoEscaped = opts.primaryRepo.replace(/"/g, '\\"');
    const cypher = `
      MATCH (consumer:Contract)-[l:ContractLink]->(provider:Contract)
      WHERE consumer.repo = "${repoEscaped}"
        AND consumer.contractId = "${cidEscaped}"
        AND consumer.role = 'consumer'
        AND provider.role = 'provider'
      RETURN provider.repo AS partnerRepo,
             provider.symbolUid AS uid,
             provider.filePath AS filePath,
             provider.symbolName AS name,
             l.matchType AS matchType,
             l.confidence AS confidence
      LIMIT 10
    `;
    const r = await conn.query(cypher);
    const rows = await r.getAll();

    return rows.map((row: Record<string, unknown>): CrossLinkOutput => {
      const matchType = String(row.matchType ?? 'manifest');
      // 类型守卫: 转成 CrossLinkOutput.matchType 字面量
      const validMt: CrossLinkOutput['matchType'] =
        matchType === 'exact'
          ? 'exact'
          : matchType === 'wildcard'
            ? 'wildcard'
            : 'manifest';
      return {
        primaryRepo: opts.primaryRepo,
        partnerRepo: String(row.partnerRepo ?? ''),
        contractId: opts.contractId,
        partnerHandler: {
          uid: String(row.uid ?? ''),
          filePath: String(row.filePath ?? ''),
          name: String(row.name ?? ''),
          // bridge.lbug 不存 startLine, 留 undefined
          label: 'Method',
        },
        matchType: validMt,
        confidence: Number(row.confidence ?? 1.0),
      };
    });
  } catch {
    return [];
  } finally {
    try { conn?.close(); } catch { /* noop */ }
    try { db?.close(); } catch { /* noop */ }
  }
}

/**
 * 把入参 contractId 归一到 bridge.lbug 存的形态 "http::METHOD::/path".
 * 跟 mcp-bridge.ts:parseContractId 算法对齐.
 */
function normalizeContractIdToBridge(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 已经是 "http::METHOD::/..." 形态, 原样返回
  if (/^http::[A-Z]+::/.test(trimmed)) return trimmed;

  // "POST /api/..." → "http::POST::/api/..."
  const m = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+)$/i.exec(trimmed);
  if (m) {
    const method = m[1].toUpperCase();
    const p = m[2].trim();
    return `http::${method}::${p.startsWith('/') ? p : '/' + p}`;
  }

  // 裸 path "/api/cses/..." → 默认 GET
  if (trimmed.startsWith('/')) {
    return `http::GET::${trimmed}`;
  }
  return null;
}
