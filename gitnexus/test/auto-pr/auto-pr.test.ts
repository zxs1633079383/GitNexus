// Stage 7 · auto-pr 单测 (vitest 镜像，与 node:test smoke 等价)
//
// 覆盖：
//  · policy R-12: 路径白/黑名单 / 扩展名 / diff 上限 / yaml 解析合并
//  · branch-manager Fix-11: ts 后缀防冲突 + sanitize
//  · patch-llm R-14: systemPrompt 隔离硬约束
//  · auto-pr 主流程 dry-run: stage6Pass / 黑名单 / 全 stage 走通
//  · GitHubPRProvider / GitLabPRProvider 不在此跑（live 模式跑 smoke）

import { describe, it, expect } from 'vitest';
import { checkPolicy, mergeWithDefault, parsePolicyYaml } from '../../src/core/auto-pr/policy.js';
import {
  pickBranchWithConflictGuard,
  sanitizeBranchName,
} from '../../src/core/auto-pr/branch-manager.js';
import { runAutoPR, makeDryRunProvider } from '../../src/core/auto-pr/auto-pr.js';
import { getPatchSystemPromptForTest } from '../../src/core/auto-pr/patch-llm.js';
import { DEFAULT_AUTO_PR_POLICY } from '../../src/core/auto-pr/types.js';

describe('policy (R-12)', () => {
  it('blocks .github/workflows/**', () => {
    const r = checkPolicy(
      [{ path: '.github/workflows/ci.yml', content: 'jobs:' }],
      DEFAULT_AUTO_PR_POLICY,
    );
    expect(r.ok).toBe(false);
  });

  it('blocks .env', () => {
    const r = checkPolicy([{ path: '.env', content: 'X=1' }], DEFAULT_AUTO_PR_POLICY);
    expect(r.ok).toBe(false);
  });

  it('blocks .pem extension', () => {
    const r = checkPolicy(
      [{ path: 'config/server.pem', content: '----' }],
      DEFAULT_AUTO_PR_POLICY,
    );
    expect(r.ok).toBe(false);
  });

  it('accepts legit src file', () => {
    const r = checkPolicy(
      [{ path: 'src/foo.ts', content: 'export const x=1;' }],
      DEFAULT_AUTO_PR_POLICY,
    );
    expect(r.ok).toBe(true);
  });

  it('enforces max_patch_diff_lines', () => {
    const r = checkPolicy(
      [{ path: 'src/big.ts', content: '\n'.repeat(600) }],
      DEFAULT_AUTO_PR_POLICY,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/max_patch_diff_lines/);
  });

  it('parses yaml and merges defaults', () => {
    const p = parsePolicyYaml('allowed_paths: ["src/**"]\nmax_patch_diff_lines: 100');
    expect(p.max_patch_diff_lines).toBe(100);
    expect(p.blocked_paths.some((x) => x.includes('.github/workflows'))).toBe(true);
  });
});

describe('branch-manager (Fix-11)', () => {
  it('sanitizes case + special chars', () => {
    expect(sanitizeBranchName('Auto-Fix/Issue#123')).toBe('auto-fix/issue-123');
  });

  it('appends ts suffix on conflict', async () => {
    let n = 0;
    const provider = makeDryRunProvider('github');
    provider.ensureBranch = async ({ branch }) => {
      n++;
      return { branch, existed: n === 1, sha: 'x' };
    };
    const r = await pickBranchWithConflictGuard(provider, {
      desiredBranch: 'auto-fix/issue-1',
      owner: 'a', repo: 'b', fromBranch: 'main',
    });
    expect(r.conflictResolved).toBe(true);
    expect(r.branch).toMatch(/^auto-fix\/issue-1-\d+$/);
  });
});

describe('patch-llm (R-14)', () => {
  it('systemPrompt hard-blocks workflow / .env / new deps', () => {
    const sp = getPatchSystemPromptForTest();
    expect(sp).toMatch(/\.github\/workflows/);
    expect(sp).toMatch(/\.env/);
    expect(sp).toMatch(/\.pem/);
    expect(sp).toMatch(/不允许引入新依赖/);
    expect(sp).toMatch(/≤ 200/);
  });
});

describe('auto-pr dry-run', () => {
  const candidate = {
    owner: 'a', repo: 'b', baseBranch: 'main', title: 'fix',
    bodyMarkdown: 'x', files: [{ path: 'src/x.ts', content: 'ok' }],
  };

  it('require_stage6_pass blocks when stage6Pass=false', async () => {
    const r = await runAutoPR({
      candidate, provider: makeDryRunProvider('github'),
      dryRun: true, stage6Pass: false,
    });
    expect(r.pr).toBeNull();
    expect(r.rejectedReason).toMatch(/Stage 6/);
  });

  it('walks policy + skips writes; pr=null', async () => {
    const r = await runAutoPR({
      candidate, provider: makeDryRunProvider('github'),
      dryRun: true, stage6Pass: true,
    });
    expect(r.pr).toBeNull();
    expect(r.stages.find((s) => s.name === 'policy')?.status).toBe('ok');
    expect(r.stages.find((s) => s.name === 'create-pr')?.status).toBe('skipped');
  });

  it('blocks blocked path → only policy stage runs', async () => {
    const r = await runAutoPR({
      candidate: { ...candidate, files: [{ path: '.github/workflows/ci.yml', content: 'evil' }] },
      provider: makeDryRunProvider('github'),
      dryRun: true, stage6Pass: true,
    });
    expect(r.stages.length).toBe(1);
    expect(r.stages[0].status).toBe('rejected');
  });
});
