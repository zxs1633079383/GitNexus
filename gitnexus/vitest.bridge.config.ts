// 临时 vitest 配置 — 仅跑 mvp/v1.2.0-bridge 桥接单测
// 跳过 lbug-db globalSetup (本机 lbug native 未编译, 不影响 bridge 自身)
//
// GITNEXUS_BIN 指向 /usr/bin/false: spawn 该命令立即 exit 1, blastRadius 走 cypher fallback,
// 让单测稳定测 cypher 行为, 不依赖本机有没有 gitnexus binary.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/mcp/mcp-bridge.test.ts'],
    pool: 'forks',
    globals: true,
    testTimeout: 5000,
    env: {
      GITNEXUS_BIN: '/usr/bin/false',
      GITNEXUS_IMPACT_TIMEOUT_MS: '500',
    },
  },
});
