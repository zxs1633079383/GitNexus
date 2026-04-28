// P1 · Auto-reindex Webhook
//
// 订阅 GitHub / GitLab webhook（push / PR sync / merge），落地为 JobManager
// 的 analyze 任务。HMAC 验签 + 同 repo 去重（Fix-3）由 JobManager.createJob 已具备。

/** 我们关心的事件类型。 */
export type WebhookEventKind = 'push' | 'pr_sync' | 'merge' | 'issue_opened' | 'unsupported';

/** 解析后的标准事件 — provider 无关。 */
export interface ParsedWebhookEvent {
  kind: WebhookEventKind;
  /** 仓库 git clone URL（HTTPS 优先），用于和 listRegisteredRepos 比对。 */
  cloneUrl: string;
  /** 仓库 full_name（如 abc/def），便于日志。 */
  fullName: string;
  /** push 后的 head SHA / PR head SHA；issue_opened 时可空。 */
  headSha: string;
  /** ref（refs/heads/main）/ PR base ref（merge 时用）。 */
  ref?: string;
  /** 原始 delivery id，用于幂等去重 + 日志关联。 */
  deliveryId?: string;
  /** issue_opened 才有：issue 编号 */
  issueNumber?: number;
  /** issue_opened 才有：issue title */
  issueTitle?: string;
  /** issue_opened 才有：issue 全文 body（用于 parseGitNexusBlock） */
  issueBody?: string;
  /** issue_opened 才有：issue labels（live 触发标签判定） */
  issueLabels?: string[];
}

/** Provider 类型。当前支 GitHub；GitLab/Gitee 通过事件名前缀区分。 */
export type WebhookProvider = 'github' | 'gitlab' | 'gitee';

/** 验签结果。 */
export type SignatureVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing-header' | 'bad-format' | 'mismatch' };

/** 触发回调：webhook 收到合法事件后调用，由 api.ts 注入实际 analyze 启动逻辑。 */
export type AnalyzeTrigger = (event: ParsedWebhookEvent) => Promise<{
  jobId: string;
  status: string;
  reason?: 'dedup' | 'fresh' | 'no-match';
}>;

/** issue.opened 触发回调：把 issue 喂给 issue-handler，由 caller 决定调
 * runPipeline 还是 dry-run。返回值用于 webhook 响应体。
 */
export type IssueTrigger = (event: ParsedWebhookEvent) => Promise<{
  ok: boolean;
  pipelineStarted?: boolean;
  reason?: string;
  commentUrl?: string;
}>;

/** webhook 路由挂载选项。 */
export interface WebhookMountOptions {
  /** GitHub webhook secret（HMAC sha256 共享密钥）。未设置时 GitHub 路由禁用。 */
  githubSecret?: string;
  /** Gitee webhook 密码（X-Gitee-Token 明文）。未设置时 Gitee 路由禁用。 */
  giteeSecret?: string;
  /** push / PR 事件触发分析（已有）。 */
  trigger: AnalyzeTrigger;
  /** issues.opened 事件触发 pipeline；省略则该事件 ack 200 但不处理。 */
  issueTrigger?: IssueTrigger;
}
