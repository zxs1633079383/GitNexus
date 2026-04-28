// Stage 7 · Auto-PR/MR Creator types
//
// 安全核心：
//  · R-4 双 App: App-2 仅 contents:write，绝不带 workflows:write
//  · R-12 policy.yaml: 默认 block .github/workflows/** + .env + .pem + .key
//  · R-5 revert 前置 diff 检查：超 max_revert_diff_lines 拒绝
//  · R-14 patch LLM 复用 callLLM 但 systemPrompt 隔离 + 强制 P0 PR Bot 二次 review

export type PRProviderKind = 'github' | 'gitlab';

/** 一条候选修复方案 — 通常由 S5 测试 + S6 绿勾 + S4 嫌疑 commit 三方组合而来。 */
export interface PRCandidate {
  /** 目标仓库 owner（GitHub）或 namespace/group（GitLab）。 */
  owner: string;
  /** 目标仓库名。 */
  repo: string;
  /** 基础分支（通常 main / master / dev）。 */
  baseBranch: string;
  /** 关联 issue/trace 的 id，用作 PR body 引用。 */
  issueRef?: string;
  /** PR 标题（中文，遵循项目 commit 规范）。 */
  title: string;
  /** PR body markdown — 由 caller 拼好（嫌疑 commit + S5 测试 + S6 绿勾 + trace 链接）。 */
  bodyMarkdown: string;
  /** 一组待落盘的文件 patch（path + 完整 base64 内容；走 contents API 直传）。 */
  files: PRFilePatch[];
  /** 标签（可选，如 'auto-fix', 'needs-review'）。 */
  labels?: string[];
  /** 是否打 Draft（GitLab 旧 API 用 WIP 前缀，R-17）。 */
  draft?: boolean;
  /** 透传：来自 forensics 的嫌疑 commit hash（用于 revert 路径 R-5 校验）。 */
  suspectCommit?: string;
}

export interface PRFilePatch {
  /** 仓库相对路径（如 src/foo.ts）。 */
  path: string;
  /** 文件全文（patch-llm 输出的完整新文件内容；不走 unified diff）。 */
  content: string;
  /** 操作类型：默认 update；create 走 PUT；delete 走 DELETE。 */
  op?: 'create' | 'update' | 'delete';
}

/** auto-pr-policy.yaml 模型 (R-12)。 */
export interface AutoPRPolicy {
  allowed_paths: string[];
  /** 默认包含 .github/workflows/** + .env + .pem + .key（黑名单优先级高）。 */
  blocked_paths: string[];
  /** 默认黑名单扩展名 */
  blocked_file_extensions: string[];
  /** revert 单次最多动多少行 diff（R-5）。 */
  max_revert_diff_lines: number;
  /** patch 单次最多动多少行 diff。 */
  max_patch_diff_lines: number;
  /** 是否要求 Stage 6 绿勾才能开 PR（默认 true）。 */
  require_stage6_pass: boolean;
}

/** Provider 抽象 — 收窄到核心 5 操作 (R-10)，merge queue 不抽象不触碰。 */
export interface PRProvider {
  kind: PRProviderKind;
  /** 创建 branch（如已存在返回 existing 标记，由 branch-manager 决定要不要后缀）。 */
  ensureBranch(opts: EnsureBranchOpts): Promise<EnsureBranchResult>;
  /** 写文件（一次一文件）。 */
  putFile(opts: PutFileOpts): Promise<void>;
  /** 创建 PR (GitHub/Gitee) / MR (GitLab)。 */
  createPR(opts: CreatePROpts): Promise<CreatePRResult>;
  /** 加标签 + 关联 issue（如 issueRef 提供）。 */
  addLabels(opts: { owner: string; repo: string; prNumber: number; labels: string[] }): Promise<void>;
  /** 在 issue 上贴评论 — Loop 闭环用：把 PipelineReport 自动回贴到原 issue */
  postIssueComment(opts: {
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
  }): Promise<{ url?: string }>;
}

export interface EnsureBranchOpts {
  owner: string;
  repo: string;
  branch: string;
  fromBranch: string;
}
export interface EnsureBranchResult {
  branch: string;
  existed: boolean;
  sha: string;
}

export interface PutFileOpts {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  content: string;
  message: string;
  op: 'create' | 'update' | 'delete';
}

export interface CreatePROpts {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface CreatePRResult {
  prNumber: number;
  url: string;
  branch: string;
}

/** auto_pr MCP 工具的最终聚合返回。 */
export interface AutoPRResult {
  /** 走完几步（policy/branch/patch/createPR）。 */
  stages: AutoPRStage[];
  /** dry_run 时为 null（没真发出去）。 */
  pr: CreatePRResult | null;
  /** 即便 live 也可能跑到 policy 拦截 / branch 冲突 → 这里说明 */
  rejectedReason?: string;
  /** 实际用的 branch（可能加了 ts 后缀） */
  finalBranch: string;
}

export interface AutoPRStage {
  name: 'policy' | 'branch' | 'put-files' | 'create-pr' | 'labels';
  status: 'ok' | 'skipped' | 'rejected' | 'error';
  durationMs: number;
  reason?: string;
}

/** auto-pr 主入口选项 */
export interface AutoPROpts {
  candidate: PRCandidate;
  provider: PRProvider;
  policy?: Partial<AutoPRPolicy>;
  /** 默认 true — 不真发 PR；GITNEXUS_AUTOPR_LIVE=1 时由 caller 翻成 false。 */
  dryRun: boolean;
  /** Stage 6 是否拿到了绿勾（由 caller 从 PreviewJob.testResult 判定）。 */
  stage6Pass: boolean;
}

// ─── 默认 policy（兜底，未提供 yaml 时用） ────────────────────────────

export const DEFAULT_AUTO_PR_POLICY: AutoPRPolicy = {
  allowed_paths: ['**/*'],
  blocked_paths: [
    '.github/workflows/**',
    '**/.env',
    '**/.env.*',
    '**/secrets/**',
  ],
  blocked_file_extensions: ['.pem', '.key', '.p12', '.pfx', '.crt', '.cer'],
  max_revert_diff_lines: 200,
  max_patch_diff_lines: 500,
  require_stage6_pass: true,
};
