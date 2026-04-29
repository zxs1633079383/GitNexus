// 临时 vitest 配置 — 仅跑 mvp/v1.2.0-bridge 桥接单测
// 跳过 lbug-db globalSetup (本机 lbug native 未编译, 不影响 bridge 自身)
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/mcp/mcp-bridge.test.ts'],
    pool: 'forks',
    globals: true,
    testTimeout: 5000,
  },
});
