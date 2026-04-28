// query-only — must not be called from any pipeline phase
import type { AdapterCtx, TestAdapter } from './index.js';
import { todoBlock } from './index.js';

export const javaJunitAdapter: TestAdapter = {
  language: 'java',
  framework: 'junit5',

  fileFor(ctx) {
    const cls = pascalize(ctx.baseName);
    return `${cls}${ucFirst(ctx.layer)}Test.java`;
  },

  emit(ctx) {
    const { layer, plan, baseName } = ctx;
    const cls = pascalize(baseName);
    const chain =
      layer === 'integration'
        ? plan.integrationPath
        : layer === 'unit'
          ? plan.layers.unit
          : plan.layers.contract;

    return [
      `package gitnexus.generated.${layer};`,
      '',
      todoBlock(layer, chain),
      'import org.junit.jupiter.api.Test;',
      'import org.junit.jupiter.api.DisplayName;',
      'import static org.junit.jupiter.api.Assertions.*;',
      '',
      `class ${cls}${ucFirst(layer)}Test {`,
      ...chain.map((n, i) => [
        '',
        `    @Test`,
        `    @DisplayName("${layer} step ${i + 1}: ${n.name}")`,
        `    void test_step_${i + 1}_${sanitize(n.name)}() {`,
        `        // TODO arrange: build inputs / mocks for ${n.name}`,
        `        // TODO act: invoke ${n.name} (${n.filePath ?? 'unknown file'}:${n.startLine ?? '?'})`,
        `        // TODO assert: business expectation`,
        `        fail("scaffold not implemented yet");`,
        `    }`,
      ].join('\n')),
      '}',
      '',
    ].join('\n');
  },
};

function pascalize(s: string): string {
  return s
    .replace(/[^\w]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}
function ucFirst(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}
