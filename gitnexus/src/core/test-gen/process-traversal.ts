// query-only — must not be called from any pipeline phase
//
// Phase 0 / Stage 5 — E2E Test Generator (P4)
// 沿 Process / STEP_IN_PROCESS / ENTRY_POINT_OF 走调用链, 攒出
// 给 generators 用的"调用链节点列表"。
//
// Fix-8 (roadmap §2.2): BFS 必须有 visited set, 防递归环。
// R-6 / R-18: LLM 只允许在 query-time 调用 (本文件本身不调 LLM, 仅做 graph 遍历)。
//
// Roadmap §3.6, RULES §1.1 行 5

export interface ChainNode {
  uid: string;
  name: string;
  kind: 'Method' | 'Function' | 'Class' | 'Interface' | 'Route' | 'Tool' | string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  /** 距 entryPoint 的步数。0 = 入口本身。 */
  depth: number;
  /** parent 节点 uid (BFS 树); 入口为 null。 */
  parentUid: string | null;
}

export interface ChainTraversal {
  entryUid: string;
  /** BFS 出来的扁平节点列表 (唯一, depth 升序)。 */
  nodes: ChainNode[];
  /** entry → ... → leaf 的最长链 (用于生成 integration test 的步序)。 */
  longestPath: ChainNode[];
  /** 命中 visited (= 环) 的节点 uid 集合 (诊断). */
  cycles: string[];
}

/** caller (e.g. local-backend.ts) 注入: 拿一个节点的下一跳邻居 (STEP_IN_PROCESS 出边)。 */
export type NextStepFn = (uid: string) => Promise<
  Array<{ uid: string; name: string; kind?: string; filePath?: string; startLine?: number; endLine?: number }>
>;

/** 拿一个节点的元数据 (用于 entry 节点首次入队). */
export type NodeFetchFn = (uid: string) => Promise<{
  name: string;
  kind?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
} | null>;

/**
 * BFS 遍历 Process 调用链, 顶满 maxDepth (默认 6) 或 maxNodes (默认 200) 后停止。
 * 返回扁平节点列表 + 最长链 (用于 integration test 的步序)。
 *
 * Fix-8: visited set 必须按 uid 去重, 不然 OO 框架里 super-call 会无限递归。
 */
export async function traverseChain(
  entryUid: string,
  fetchNode: NodeFetchFn,
  fetchNextSteps: NextStepFn,
  opts: { maxDepth?: number; maxNodes?: number } = {},
): Promise<ChainTraversal> {
  const maxDepth = opts.maxDepth ?? 6;
  const maxNodes = opts.maxNodes ?? 200;

  const visited = new Set<string>();
  const cycles: string[] = [];
  const nodes: ChainNode[] = [];
  const parentMap = new Map<string, string | null>(); // uid → parentUid

  const root = await fetchNode(entryUid);
  if (!root) {
    return { entryUid, nodes: [], longestPath: [], cycles: [] };
  }

  // 初始化 BFS 队列
  type QueueItem = { uid: string; depth: number; parentUid: string | null; meta: typeof root };
  const queue: QueueItem[] = [{ uid: entryUid, depth: 0, parentUid: null, meta: root }];

  while (queue.length > 0 && nodes.length < maxNodes) {
    const cur = queue.shift()!;
    if (visited.has(cur.uid)) {
      cycles.push(cur.uid);
      continue;
    }
    visited.add(cur.uid);
    parentMap.set(cur.uid, cur.parentUid);

    nodes.push({
      uid: cur.uid,
      name: cur.meta.name,
      kind: (cur.meta.kind ?? 'Method') as ChainNode['kind'],
      filePath: cur.meta.filePath,
      startLine: cur.meta.startLine,
      endLine: cur.meta.endLine,
      depth: cur.depth,
      parentUid: cur.parentUid,
    });

    if (cur.depth >= maxDepth) continue;

    const nexts = await fetchNextSteps(cur.uid);
    for (const n of nexts) {
      if (visited.has(n.uid)) {
        cycles.push(n.uid);
        continue;
      }
      queue.push({
        uid: n.uid,
        depth: cur.depth + 1,
        parentUid: cur.uid,
        meta: {
          name: n.name,
          kind: n.kind,
          filePath: n.filePath,
          startLine: n.startLine,
          endLine: n.endLine,
        },
      });
    }
  }

  // 找最长链: 从最深叶子节点回溯到 entry
  let deepest = nodes[0];
  for (const n of nodes) {
    if (n.depth > deepest.depth) deepest = n;
  }
  const longestPath: ChainNode[] = [];
  let cursor: ChainNode | undefined = deepest;
  while (cursor) {
    longestPath.unshift(cursor);
    if (cursor.parentUid == null) break;
    cursor = nodes.find((n) => n.uid === cursor!.parentUid);
  }

  return { entryUid, nodes, longestPath, cycles: [...new Set(cycles)] };
}
