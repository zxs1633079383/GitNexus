// Stage 7 · auto-pr 主入口
//
// 编排：
//   policy 校验 → branch (Fix-11 ts 后缀) → put-files → create PR → labels
// 任一阶段 reject/error → AutoPRResult 标记，不继续
// dryRun=true：policy + branch (但不 push) 走完，create-pr/put-files 跳过

import { mergeWithDefault } from './policy.js';
import { checkPolicy } from './policy.js';
import { pickBranchWithConflictGuard, sanitizeBranchName } from './branch-manager.js';
import type {
  AutoPROpts,
  AutoPRResult,
  AutoPRStage,
  PRProvider,
  PRProviderKind,
} from './types.js';

/** dry-run 用：所有写操作变成 no-op，不触发任何外部副作用。 */
export function makeDryRunProvider(kind: PRProviderKind): PRProvider {
  return {
    kind,
    async ensureBranch({ branch }) {
      return { branch, existed: false, sha: 'dry-run-sha' };
    },
    async putFile() { /* no-op */ },
    async createPR(opts) {
      return { prNumber: 0, url: `dry-run://no-pr`, branch: opts.head };
    },
    async addLabels() { /* no-op */ },
    async postIssueComment() { return { url: 'dry-run://no-comment' }; },
  };
}

const now = () => Date.now();

function stage(name: AutoPRStage['name'], status: AutoPRStage['status'], t0: number, reason?: string): AutoPRStage {
  return { name, status, durationMs: now() - t0, reason };
}

export async function runAutoPR(opts: AutoPROpts): Promise<AutoPRResult> {
  const stages: AutoPRStage[] = [];
  const policy = mergeWithDefault(opts.policy ?? null);
  const c = opts.candidate;

  // ── 0. require_stage6_pass 闸 ──────────────────────────────────────
  if (policy.require_stage6_pass && !opts.stage6Pass) {
    return {
      stages: [stage('policy', 'rejected', now(), 'Stage 6 did not pass; require_stage6_pass=true')],
      pr: null,
      finalBranch: '',
      rejectedReason: 'Stage 6 did not pass; auto-PR refused per policy',
    };
  }

  // ── 1. policy 校验（路径 / 扩展名 / diff 行数）────────────────────
  {
    const t0 = now();
    const r = checkPolicy(c.files, policy, { isRevert: false });
    if (!r.ok) {
      stages.push(stage('policy', 'rejected', t0, r.reason));
      return { stages, pr: null, finalBranch: '', rejectedReason: r.reason };
    }
    stages.push(stage('policy', 'ok', t0));
  }

  // ── 2. branch (Fix-11 ts 后缀防冲突) ─────────────────────────────
  // issueRef 形如 "#2" — 把 # 替换成 'issue-' 让 branch 名可读
  const refClean = (c.issueRef ?? '').replace(/^#/, 'issue-');
  const desired = sanitizeBranchName(
    c.issueRef ? `auto-fix/${refClean}` : `auto-fix/${Date.now().toString(36)}`,
  );
  let finalBranch: string;
  {
    const t0 = now();
    if (opts.dryRun) {
      // dry-run 不调 provider，直接用 desired 名字
      finalBranch = desired;
      stages.push(stage('branch', 'skipped', t0, 'dryRun=true'));
    } else {
      try {
        const picked = await pickBranchWithConflictGuard(opts.provider, {
          desiredBranch: desired,
          owner: c.owner,
          repo: c.repo,
          fromBranch: c.baseBranch,
        });
        finalBranch = picked.branch;
        stages.push(
          stage(
            'branch',
            'ok',
            t0,
            picked.conflictResolved ? `conflict resolved → ${picked.branch}` : undefined,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stages.push(stage('branch', 'error', t0, msg));
        return { stages, pr: null, finalBranch: '', rejectedReason: msg };
      }
    }
  }

  // ── 3. put-files ─────────────────────────────────────────────────
  {
    const t0 = now();
    if (opts.dryRun) {
      stages.push(stage('put-files', 'skipped', t0, `dryRun: would push ${c.files.length} files`));
    } else {
      try {
        for (const f of c.files) {
          await opts.provider.putFile({
            owner: c.owner,
            repo: c.repo,
            branch: finalBranch,
            path: f.path,
            content: f.content,
            message: c.title,
            op: f.op ?? 'update',
          });
        }
        stages.push(stage('put-files', 'ok', t0, `pushed ${c.files.length} file(s)`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stages.push(stage('put-files', 'error', t0, msg));
        return { stages, pr: null, finalBranch, rejectedReason: msg };
      }
    }
  }

  // ── 4. create PR ─────────────────────────────────────────────────
  let pr: AutoPRResult['pr'] = null;
  {
    const t0 = now();
    if (opts.dryRun) {
      stages.push(stage('create-pr', 'skipped', t0, 'dryRun=true'));
    } else {
      try {
        pr = await opts.provider.createPR({
          owner: c.owner,
          repo: c.repo,
          head: finalBranch,
          base: c.baseBranch,
          title: c.title,
          body: c.bodyMarkdown,
          draft: !!c.draft,
        });
        stages.push(stage('create-pr', 'ok', t0, `#${pr.prNumber} ${pr.url}`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stages.push(stage('create-pr', 'error', t0, msg));
        return { stages, pr: null, finalBranch, rejectedReason: msg };
      }
    }
  }

  // ── 5. labels ────────────────────────────────────────────────────
  if (c.labels?.length) {
    const t0 = now();
    if (opts.dryRun || !pr) {
      stages.push(stage('labels', 'skipped', t0, opts.dryRun ? 'dryRun=true' : 'no PR'));
    } else {
      try {
        await opts.provider.addLabels({
          owner: c.owner,
          repo: c.repo,
          prNumber: pr.prNumber,
          labels: c.labels,
        });
        stages.push(stage('labels', 'ok', t0));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stages.push(stage('labels', 'error', t0, msg));
      }
    }
  }

  return { stages, pr, finalBranch };
}
