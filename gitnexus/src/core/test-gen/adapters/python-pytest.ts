// query-only — must not be called from any pipeline phase
import type { AdapterCtx, TestAdapter } from './index.js';
import { todoBlock } from './index.js';

export const pythonPytestAdapter: TestAdapter = {
  language: 'python',
  framework: 'pytest',

  fileFor(ctx) {
    return `test_${snake(ctx.baseName)}_${ctx.layer}.py`;
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
      'import pytest',
      '',
      ...chain.map((n, i) =>
        [
          `def test_${snake(baseName)}_${layer}_step_${i + 1}_${sanitize(n.name)}():`,
          `    """${layer} step ${i + 1}: ${n.name} (${n.filePath ?? 'unknown file'}:${n.startLine ?? '?'})"""`,
          `    # TODO arrange: build inputs / mocks`,
          `    # TODO act: invoke ${n.name}`,
          `    # TODO assert: business expectation`,
          `    pytest.fail("scaffold not implemented yet")`,
          '',
        ].join('\n'),
      ),
    ].join('\n');
  },
};

function snake(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();
}
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}
