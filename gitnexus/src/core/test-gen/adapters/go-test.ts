// query-only — must not be called from any pipeline phase
import type { AdapterCtx, TestAdapter } from './index.js';
import { todoBlock } from './index.js';

export const goTestAdapter: TestAdapter = {
  language: 'go',
  framework: 'testing',

  fileFor(ctx) {
    return `${snake(ctx.baseName)}_${ctx.layer}_test.go`;
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
      `package generated_${layer}`,
      '',
      todoBlock(layer, chain),
      'import "testing"',
      '',
      ...chain.map((n, i) =>
        [
          `func Test_${pascal(baseName)}_${pascal(layer)}_Step${i + 1}_${sanitize(n.name)}(t *testing.T) {`,
          `	// TODO arrange: build inputs / mocks for ${n.name}`,
          `	// TODO act: invoke ${n.name} (${n.filePath ?? 'unknown file'}:${n.startLine ?? '?'})`,
          `	// TODO assert: business expectation`,
          `	t.Fatalf("scaffold not implemented yet")`,
          `}`,
          '',
        ].join('\n'),
      ),
    ].join('\n');
  },
};

function snake(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();
}
function pascal(s: string): string {
  return s.replace(/[^\w]+/g, ' ').split(' ').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}
