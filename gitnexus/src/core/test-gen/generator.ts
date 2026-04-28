// query-only — must not be called from any pipeline phase
//
// Stage 5 — generator orchestrator
// 把 traversal → plan → adapter.emit() 拼起来, 输出三层 test 文件 (R-1 scaffold)。
//
// R-6 / RULES §0.4: 整个文件不调 LLM。LLM hook 留 (next iteration), 当前
// MVP 全是 deterministic skeleton。
//
// Roadmap §3.6

import type { ChainTraversal } from './process-traversal.js';
import { planTests, type TestPlan } from './test-planner.js';
import {
  pickAdapter,
  type GeneratedTestFile,
  type SupportedLanguage,
  type TestAdapter,
} from './adapters/index.js';

export interface GenerateInput {
  traversal: ChainTraversal;
  /** 入口 handler 的简称 (e.g. 'TaskMemberReader.loadSnapshot' / 'loadSnapshot'). */
  baseName: string;
  /** 检测到的语言 (从 entry 文件扩展名推); 未识别 → null = caller 决定降级。 */
  language: SupportedLanguage | null;
  /** ContractLink 命中的节点 uid (graph 查出来塞进来). */
  contractLinks: ReadonlySet<string>;
}

export interface GenerateOutput {
  language: string;
  framework: string;
  plan: TestPlan;
  files: GeneratedTestFile[];
  /** 跳过的 layer + 原因。 */
  skipped: Array<{ layer: 'unit' | 'contract' | 'integration'; reason: string }>;
}

export function generateTestScaffolds(input: GenerateInput): GenerateOutput {
  const { traversal, baseName, language, contractLinks } = input;
  const adapter: TestAdapter | null = language ? pickAdapter(language) : null;
  const plan = planTests(traversal, contractLinks);

  if (!adapter) {
    return {
      language: language ?? 'unknown',
      framework: 'none',
      plan,
      files: [],
      skipped: [
        { layer: 'unit', reason: `no test adapter for language=${language ?? 'unknown'}` },
        { layer: 'contract', reason: `no test adapter for language=${language ?? 'unknown'}` },
        { layer: 'integration', reason: `no test adapter for language=${language ?? 'unknown'}` },
      ],
    };
  }

  const files: GeneratedTestFile[] = [];
  const skipped: GenerateOutput['skipped'] = [];

  for (const layer of ['unit', 'contract', 'integration'] as const) {
    const items = plan.layers[layer];
    if (layer === 'integration') {
      if (plan.integrationPath.length < 2) {
        skipped.push({ layer, reason: 'integration path < 2 hops' });
        continue;
      }
    } else if (items.length === 0) {
      skipped.push({ layer, reason: `no nodes classified as ${layer}` });
      continue;
    }
    const ctx = { layer, plan, baseName };
    files.push({
      filePath: adapter.fileFor(ctx),
      language: adapter.language,
      framework: adapter.framework,
      layer,
      content: adapter.emit(ctx),
    });
  }

  return {
    language: adapter.language,
    framework: adapter.framework,
    plan,
    files,
    skipped,
  };
}

/**
 * 从文件扩展名 / 路径推语言。caller 把 entry node 的 filePath 喂进来即可。
 */
export function detectLanguage(filePath: string | undefined): SupportedLanguage | null {
  if (!filePath) return null;
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.kt')) return 'java'; // Kotlin 走 JUnit5
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return 'javascript';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.py')) return 'python';
  return null;
}
