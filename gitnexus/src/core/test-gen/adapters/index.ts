// query-only — must not be called from any pipeline phase
//
// Stage 5 — 语言适配器注册表
// R-13: 用 satisfies Record<SupportedLanguage, TestAdapter>, 漏一种语言变成
// 编译错误 (参考 core/ingestion/languages/index.ts)。

import type { ChainNode } from '../process-traversal.js';
import type { TestLayer, TestPlan } from '../test-planner.js';

export interface AdapterCtx {
  layer: TestLayer;
  plan: TestPlan;
  /** 给 file 命名用的 hint (e.g. handler 名) */
  baseName: string;
}

export interface GeneratedTestFile {
  filePath: string;
  language: string;
  framework: string;
  layer: TestLayer;
  /** 文件内容 (R-1 降期望: 调用链结构骨架 + TODO 占位)。 */
  content: string;
}

export interface TestAdapter {
  language: string;
  framework: string;
  /** 生成 test 文件名 (相对 src/test 根)。 */
  fileFor(ctx: AdapterCtx): string;
  /** 生成 test 文件内容 (skeleton + TODO 注释)。 */
  emit(ctx: AdapterCtx): string;
}

/** 简易 TODO 块, 给所有 adapter 复用。 */
export function todoBlock(layer: TestLayer, chain: readonly ChainNode[]): string {
  const steps = chain.map((c, i) => `  // ${i + 1}. ${c.name} (${c.filePath ?? '?'})`);
  return [
    `// AUTO-GENERATED test scaffold (Stage 5 / GitNexus E2E Test Generator)`,
    `// Layer: ${layer}`,
    `// R-1: only the call-chain skeleton is filled in. Fixtures, mocks, and`,
    `// business assertions need a human pass.`,
    `//`,
    `// Trace path:`,
    ...steps,
    '',
  ].join('\n');
}

import { javaJunitAdapter } from './java-junit.js';
import { tsJestAdapter } from './ts-jest.js';
import { goTestAdapter } from './go-test.js';
import { pythonPytestAdapter } from './python-pytest.js';

/**
 * R-13: 编译期校验 — 漏一种语言 ts 直接报错。
 * 真支持的语言全列在这里, 未支持的语言走 fallback (caller 决定降级或 skip)。
 */
export const TEST_ADAPTERS = {
  java: javaJunitAdapter,
  typescript: tsJestAdapter,
  javascript: tsJestAdapter,
  go: goTestAdapter,
  python: pythonPytestAdapter,
} as const satisfies Record<string, TestAdapter>;

export type SupportedLanguage = keyof typeof TEST_ADAPTERS;

export function pickAdapter(language: string): TestAdapter | null {
  if (language in TEST_ADAPTERS) {
    return TEST_ADAPTERS[language as SupportedLanguage];
  }
  return null;
}
