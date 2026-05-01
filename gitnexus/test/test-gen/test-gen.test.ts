// Stage 5 · E2E Test Generator 单测
// 验证: BFS 防递归 (Fix-8) / planner 三层判决 (R-7) / 适配器 emit / 跳过原因。

import { describe, expect, it } from 'vitest';
import { traverseChain } from '../../src/core/test-gen/process-traversal.js';
import { planTests } from '../../src/core/test-gen/test-planner.js';
import {
  detectLanguage,
  generateTestScaffolds,
} from '../../src/core/test-gen/generator.js';
import { parseMethodId } from '../../scripts/mcp-bridge.js';

const GRAPH: Record<string, any> = {
  'Route:/api/load': {
    name: '/api/load',
    kind: 'Route',
    filePath: 'src/router.ts',
    startLine: 12,
  },
  'Method:loadHandler': {
    name: 'loadHandler',
    kind: 'Method',
    filePath: 'src/Loader.java',
    startLine: 30,
  },
  'Method:loadDb': {
    name: 'loadDb',
    kind: 'Method',
    filePath: 'src/Loader.java',
    startLine: 80,
  },
  'Function:renderJSON': {
    name: 'renderJSON',
    kind: 'Function',
    filePath: 'src/View.java',
    startLine: 5,
  },
};
const NEXTS: Record<string, string[]> = {
  'Route:/api/load': ['Method:loadHandler'],
  'Method:loadHandler': ['Method:loadDb', 'Function:renderJSON'],
  'Method:loadDb': [],
  'Function:renderJSON': [],
};

const fetchNode = async (uid: string) => GRAPH[uid] ?? null;
const fetchNexts = async (uid: string) =>
  (NEXTS[uid] ?? []).map((child) => ({ uid: child, ...GRAPH[child] }));

describe('Stage 5 · process traversal + planner', () => {
  it('BFS visits 4 nodes, no cycles, longestPath ≥ 3 (Fix-8)', async () => {
    const t = await traverseChain('Route:/api/load', fetchNode, fetchNexts);
    expect(t.nodes.length).toBe(4);
    expect(t.cycles.length).toBe(0);
    expect(t.longestPath.length).toBeGreaterThanOrEqual(3);
    expect(t.longestPath[0].uid).toBe('Route:/api/load');
  });

  it('cycle detection (Fix-8): self-loop must not blow stack', async () => {
    const cyclic: Record<string, any> = {
      A: { name: 'A', kind: 'Method', filePath: 'a.ts' },
      B: { name: 'B', kind: 'Method', filePath: 'b.ts' },
    };
    const t = await traverseChain(
      'A',
      async (u: string) => cyclic[u] ?? null,
      async (u: string) =>
        u === 'A' ? [{ uid: 'B', ...cyclic.B }] : [{ uid: 'A', ...cyclic.A }],
    );
    expect(t.nodes.length).toBe(2);
    expect(t.cycles.length).toBeGreaterThan(0);
  });

  it('R-7 layer rules: leaves → unit, Route → contract, ≥2 hops → integration', async () => {
    const t = await traverseChain('Route:/api/load', fetchNode, fetchNexts);
    const plan = planTests(t, new Set(['Route:/api/load']));
    expect(plan.layers.unit.length).toBe(2); // loadDb + renderJSON
    expect(plan.layers.contract.length).toBe(1); // Route
    expect(plan.integrationPath.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Stage 5 · generator + adapters', () => {
  it('Java JUnit5 emit: 3 layer files with TODO blocks', async () => {
    const t = await traverseChain('Route:/api/load', fetchNode, fetchNexts);
    const out = generateTestScaffolds({
      traversal: t,
      baseName: 'loadHandler',
      language: detectLanguage('src/Loader.java'),
      contractLinks: new Set(['Route:/api/load']),
    });
    expect(out.language).toBe('java');
    expect(out.framework).toBe('junit5');
    expect(out.files.length).toBe(3);
    for (const f of out.files) {
      expect(f.content).toContain('AUTO-GENERATED test scaffold');
      expect(f.content).toMatch(/TODO arrange|TODO act|TODO assert/);
    }
    const layers = out.files.map((f) => f.layer);
    expect(layers).toEqual(expect.arrayContaining(['unit', 'contract', 'integration']));
  });

  it('R-13: unsupported language → 3 layers skipped + plan still returned', () => {
    const out = generateTestScaffolds({
      traversal: {
        entryUid: 'X',
        nodes: [
          {
            uid: 'X',
            name: 'x',
            kind: 'Method',
            filePath: 'a.rs',
            depth: 0,
            parentUid: null,
          },
        ],
        longestPath: [],
        cycles: [],
      },
      baseName: 'x',
      language: detectLanguage('a.rs'),
      contractLinks: new Set(),
    });
    expect(out.files.length).toBe(0);
    expect(out.skipped.length).toBe(3);
    expect(out.skipped[0].reason).toMatch(/no test adapter for language/);
  });

  it('TypeScript Jest emit', async () => {
    const tsGraph: Record<string, any> = {
      'Method:foo': {
        name: 'foo',
        kind: 'Method',
        filePath: 'src/foo.ts',
        startLine: 1,
      },
      'Method:bar': {
        name: 'bar',
        kind: 'Method',
        filePath: 'src/bar.ts',
        startLine: 1,
      },
    };
    const t = await traverseChain(
      'Method:foo',
      async (u: string) => tsGraph[u] ?? null,
      async (u: string) =>
        u === 'Method:foo'
          ? [{ uid: 'Method:bar', ...tsGraph['Method:bar'] }]
          : [],
    );
    const out = generateTestScaffolds({
      traversal: t,
      baseName: 'foo',
      language: detectLanguage('src/foo.ts'),
      contractLinks: new Set(),
    });
    expect(out.language).toBe('typescript');
    expect(out.framework).toBe('jest');
    const integration = out.files.find((f) => f.layer === 'integration');
    expect(integration?.filePath).toMatch(/foo\.integration\.test\.ts$/);
    expect(integration?.content).toContain("describe('[integration] foo'");
  });
});

// issue#68: S5 genE2ETests 文件名回归测试 ─────────────────────────────────────
// 验证 parseMethodId 解析 #N suffix UID 能取到真 method 名，
// 进而生成 Test_<methodName>.java 而非 Test_unknown.java
describe('S5 · genE2ETests 文件名由真 handler.name 派生 (issue#68)', () => {
  it('#N-suffix UID → parseMethodId 返回真 method 名 triggerLoadIncrement', () => {
    const uid =
      'Method:server/src/main/java/org/cses/CrossRepoDemoController.java:CrossRepoDemoController.triggerLoadIncrement#2';
    const parsed = parseMethodId(uid);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('CrossRepoDemoController.triggerLoadIncrement');
  });

  it('#N-suffix UID → safeName 不含 unknown，生成文件名不等于 Test_unknown.java', () => {
    const uid =
      'Method:server/src/main/java/org/cses/CrossRepoDemoController.java:CrossRepoDemoController.triggerLoadIncrement#2';
    const parsed = parseMethodId(uid);
    const safeName = (parsed?.name ?? 'unknown').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);
    expect(safeName).not.toBe('unknown');
    // slice(0,40) 截到 "CrossRepoDemoController_triggerLoadIncre"
    // 关键: 不是 unknown，且包含真 class 名前段
    expect(safeName).toMatch(/^CrossRepoDemoController/);
    expect(`Test_${safeName}.java`).not.toBe('Test_unknown.java');
  });

  it('manifest synthetic UID (无 # 且无行号) → parseMethodId 返回 null → fallback unknown 向后兼容', () => {
    // manifest 合成 UID 通常形如 Method:http__POST___api_foo (无文件路径段 + 无行号)
    const syntheticUid = 'Method:http__POST___api_triggerLoadIncrement';
    const parsed = parseMethodId(syntheticUid);
    // regex 无法匹配 → null → safeName = 'unknown' (向后兼容)
    expect(parsed).toBeNull();
    const safeName = (parsed?.name ?? 'unknown').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);
    expect(safeName).toBe('unknown');
  });

  it('Java JUnit5 adapter fileFor: baseName=triggerLoadIncrement → 含 triggerLoadIncrement', async () => {
    const t = await traverseChain(
      'Method:handler',
      async (uid) =>
        uid === 'Method:handler'
          ? { name: 'triggerLoadIncrement', kind: 'Method', filePath: 'src/CrossRepoDemoController.java', startLine: 1 }
          : null,
      async () => [],
    );
    const out = generateTestScaffolds({
      traversal: t,
      baseName: 'triggerLoadIncrement',
      language: detectLanguage('src/CrossRepoDemoController.java'),
      contractLinks: new Set(),
    });
    expect(out.language).toBe('java');
    // 每个生成文件的路径必须包含 triggerLoadIncrement, 不含 unknown
    for (const f of out.files) {
      expect(f.filePath).toContain('TriggerLoadIncrement');
      expect(f.filePath).not.toContain('Unknown');
    }
  });
});
