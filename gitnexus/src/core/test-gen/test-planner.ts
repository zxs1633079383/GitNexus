// query-only — must not be called from any pipeline phase
//
// Phase 0 / Stage 5 — Test Planner
// 决定一条调用链该出 unit / contract / integration 哪几层 test 文件。
//
// R-7 判决规则 (roadmap §2.3 中风险表):
//   - Unit        : 节点是 Method/Function 且无 STEP_IN_PROCESS 出边
//                   (= 叶子调用, 单元粒度)
//   - Contract    : 节点有 ContractLink 边 (provider/consumer 跨仓接口) 或
//                   节点 kind === 'Route' (HTTP / gRPC / topic 入口)
//   - Integration : ENTRY_POINT_OF → STEP_IN_PROCESS 链路 ≥ 2 跳的 Process
//                   (即 traversal 长度 ≥ 2, 复现 trace 路径)
//
// R-1 (降期望): 三种 generator 都只产 "调用链结构骨架 + TODO 占位",
// 不强求自动填值域。

import type { ChainNode, ChainTraversal } from './process-traversal.js';

export type TestLayer = 'unit' | 'contract' | 'integration';

export interface TestPlan {
  /** 三层 layer 各自要覆盖哪些节点 (uid 列表)。 */
  layers: Record<TestLayer, ChainNode[]>;
  /** 入口节点 (route / 顶层 method) 元数据, 给 contract gen 用。 */
  entry: ChainNode | null;
  /** integration 用的最长 trace 路径 (含步序)。 */
  integrationPath: ChainNode[];
  /** 诊断: 为什么某些 layer 是空的 (e.g. "no contract links")。 */
  notes: string[];
}

/**
 * 从 traversal + 一组 contract-link 标记, 推出 TestPlan。
 *
 * @param traversal Phase 0 + Stage 4 用过的链遍历输出
 * @param contractLinks  uid → bool, 节点是否有 ContractLink 出/入边
 *                        (caller 在 graph 里查一次塞进来, 不在本 planner 里查图)
 */
export function planTests(
  traversal: ChainTraversal,
  contractLinks: ReadonlySet<string>,
): TestPlan {
  const notes: string[] = [];
  const unit: ChainNode[] = [];
  const contract: ChainNode[] = [];
  const integration: ChainNode[] = [];

  // 入口取 longestPath[0] (深度=0); 若 longestPath 空, fallback 到 nodes[0]
  const entry = traversal.longestPath[0] ?? traversal.nodes[0] ?? null;

  // 哪些节点有 STEP_IN_PROCESS 出边 → 以"是不是某节点的 parent"近似
  const hasOutEdge = new Set<string>();
  for (const n of traversal.nodes) {
    if (n.parentUid) hasOutEdge.add(n.parentUid);
  }

  for (const node of traversal.nodes) {
    // Unit: Method/Function 且无出边 (= 叶子)
    if (
      (node.kind === 'Method' || node.kind === 'Function') &&
      !hasOutEdge.has(node.uid)
    ) {
      unit.push(node);
    }

    // Contract: kind=Route 或显式 ContractLink 标记
    if (node.kind === 'Route' || contractLinks.has(node.uid)) {
      contract.push(node);
    }
  }

  // Integration: longestPath ≥ 2 跳就出
  if (traversal.longestPath.length >= 2) {
    integration.push(...traversal.longestPath);
  } else {
    notes.push(
      'integration: longestPath < 2 hops, skipped (chain may be too shallow or process node missing)',
    );
  }

  if (unit.length === 0) {
    notes.push('unit: no leaf Method/Function found (every node has a STEP_IN_PROCESS successor)');
  }
  if (contract.length === 0) {
    notes.push('contract: no Route node and no ContractLink edges hit');
  }

  return {
    layers: { unit, contract, integration },
    entry,
    integrationPath: traversal.longestPath,
    notes,
  };
}
