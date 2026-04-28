// Stage 7 · branch-manager (Fix-11 ts 后缀防冲突)
//
// 同 issueId 重新触发时不让前一次的 branch 被覆盖：
//  · 若目标 branch 已存在 → 后缀 -<unix-ts>
//  · PR body 注前一次尝试的链接（caller 拼）

import type { PRProvider } from './types.js';

/** k8s 合规命名 + GitHub branch 合规：小写、a-z0-9-，长度 ≤ 64。 */
export function sanitizeBranchName(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9-/]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.length > 60 ? s.slice(0, 60).replace(/-$/, '') : s;
}

export interface PickBranchOpts {
  desiredBranch: string;
  owner: string;
  repo: string;
  fromBranch: string;
}

export interface PickBranchResult {
  branch: string;
  conflictResolved: boolean;
  /** 若加了 ts 后缀，记下原名便于日志 */
  originalDesired: string;
}

/**
 * 用 provider.ensureBranch 探测；如已存在就在 desiredBranch 后加 -<ts> 重试一次。
 * 重试只一次：若再冲突，由 caller 处理（极端情况几乎不会）。
 */
export async function pickBranchWithConflictGuard(
  provider: PRProvider,
  opts: PickBranchOpts,
): Promise<PickBranchResult> {
  const desired = sanitizeBranchName(opts.desiredBranch);
  const first = await provider.ensureBranch({
    owner: opts.owner,
    repo: opts.repo,
    branch: desired,
    fromBranch: opts.fromBranch,
  });

  if (!first.existed) {
    return { branch: desired, conflictResolved: false, originalDesired: desired };
  }

  // 冲突：加 ts 后缀
  const ts = Math.floor(Date.now() / 1000);
  const fallback = sanitizeBranchName(`${desired}-${ts}`);
  await provider.ensureBranch({
    owner: opts.owner,
    repo: opts.repo,
    branch: fallback,
    fromBranch: opts.fromBranch,
  });
  return { branch: fallback, conflictResolved: true, originalDesired: desired };
}
