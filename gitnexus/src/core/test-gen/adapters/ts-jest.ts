// query-only — must not be called from any pipeline phase
import type { AdapterCtx, TestAdapter } from './index.js';
import { todoBlock } from './index.js';

export const tsJestAdapter: TestAdapter = {
  language: 'typescript',
  framework: 'jest',

  fileFor(ctx) {
    return `${kebab(ctx.baseName)}.${ctx.layer}.test.ts`;
  },

  emit(ctx) {
    const { layer, plan, baseName } = ctx;
    const chain =
      layer === 'integration'
        ? plan.integrationPath
        : layer === 'unit'
          ? plan.layers.unit
          : plan.layers.contract;

    return [
      todoBlock(layer, chain),
      `describe('[${layer}] ${baseName}', () => {`,
      ...chain.map((n, i) =>
        [
          `  test('step ${i + 1}: ${n.name}', () => {`,
          `    // TODO arrange: build inputs / mocks for ${n.name}`,
          `    // TODO act: invoke ${n.name} (${n.filePath ?? 'unknown file'}:${n.startLine ?? '?'})`,
          `    // TODO assert: business expectation`,
          `    expect.fail('scaffold not implemented yet');`,
          `  });`,
        ].join('\n'),
      ),
      `});`,
      '',
    ].join('\n');
  },
};

function kebab(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '');
}
