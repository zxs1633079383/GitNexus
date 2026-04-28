// P1 · Auto-reindex Webhook
//
// 订阅 GitHub / GitLab webhook（push / PR sync / merge），落地为 JobManager
// 的 analyze 任务。HMAC 验签 + 同 repo 去重（Fix-3）由 JobManager.createJob 已具备。

/** 我们关心的事件类型。 */
export type WebhookEventKind = 'push' | 'pr_sync' | 'merge' | 'unsupported';

/** 解析后的标准事件 — provider 无关。 */
export interface ParsedWebhookEvent {
  kind: WebhookEventKind;
  /** 仓库 git clone URL（HTTPS 优先），用于和 listRegisteredRepos 比对。 */
  cloneUrl: string;
  /** 仓库 full_name（如 abc/def），便于日志。 */
  fullName: string;
  /** push 后的 head SHA / PR head SHA。 */
  headSha: string;
  /** ref（refs/heads/main）/ PR base ref（merge 时用）。 */
  ref?: string;
  /** 原始 delivery id，用于幂等去重 + 日志关联。 */
  deliveryId?: string;
}

/** Provider 类型。当前只支 GitHub；GitLab 留 hook 位。 */
export type WebhookProvider = 'github' | 'gitlab';

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

/** webhook 路由挂载选项。 */
export interface WebhookMountOptions {
  /** GitHub webhook secret（HMAC sha256 共享密钥）。未设置时整条路由禁用。 */
  githubSecret?: string;
  /** 触发分析回调。 */
  trigger: AnalyzeTrigger;
}
