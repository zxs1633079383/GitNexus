// GitHub event payload → ParsedWebhookEvent。
// 只接 push / pull_request(synchronize|opened|reopened) / pull_request(closed,merged=true)。
// 其余事件归 'unsupported'，由 handler 直接 ack 200 不处理。

import type { ParsedWebhookEvent, WebhookEventKind } from './types.js';

interface RawRepo {
  full_name?: string;
  clone_url?: string;
  ssh_url?: string;
  html_url?: string;
}

interface PushPayload {
  ref?: string;
  after?: string;
  repository?: RawRepo;
}

interface PRPayload {
  action?: string;
  pull_request?: {
    head?: { sha?: string; ref?: string };
    base?: { ref?: string };
    merged?: boolean;
  };
  repository?: RawRepo;
}

function pickCloneUrl(repo: RawRepo | undefined): string {
  // 优先 clone_url（HTTPS）→ html_url → ssh_url
  return repo?.clone_url || repo?.html_url || repo?.ssh_url || '';
}

/**
 * 解析 GitHub webhook payload。
 *
 * @param eventName X-GitHub-Event 头值（push / pull_request / ping / 其他）
 * @param body      已 parse 的 JSON body
 * @param deliveryId X-GitHub-Delivery 头值（可选，用于日志）
 */
export function parseGitHubEvent(
  eventName: string,
  body: unknown,
  deliveryId?: string,
): ParsedWebhookEvent | null {
  if (!body || typeof body !== 'object') return null;

  if (eventName === 'push') {
    const p = body as PushPayload;
    const cloneUrl = pickCloneUrl(p.repository);
    if (!cloneUrl || !p.after) return null;
    return {
      kind: 'push',
      cloneUrl,
      fullName: p.repository?.full_name ?? '',
      headSha: p.after,
      ref: p.ref,
      deliveryId,
    };
  }

  if (eventName === 'pull_request') {
    const p = body as PRPayload;
    const cloneUrl = pickCloneUrl(p.repository);
    const headSha = p.pull_request?.head?.sha;
    if (!cloneUrl || !headSha) return null;

    let kind: WebhookEventKind = 'unsupported';
    if (p.action === 'synchronize' || p.action === 'opened' || p.action === 'reopened') {
      kind = 'pr_sync';
    } else if (p.action === 'closed' && p.pull_request?.merged) {
      kind = 'merge';
    } else {
      return null; // 其他 PR action 不需要重索引
    }

    return {
      kind,
      cloneUrl,
      fullName: p.repository?.full_name ?? '',
      headSha,
      ref: p.pull_request?.base?.ref ?? p.pull_request?.head?.ref,
      deliveryId,
    };
  }

  // ping / installation / 其他 → 不重索引
  return null;
}
