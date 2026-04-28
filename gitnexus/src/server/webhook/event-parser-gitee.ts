// Gitee webhook 事件解析
//
// 与 GitHub 主要区别：
//  · 事件名走 X-Gitee-Event 头，值有空格："Issue Hook" / "Push Hook" / "Merge Request Hook"
//  · issue action 用 "open" 不是 "opened"
//  · 字段名差异：Gitee 用 number / repository / sender；issue.body 同名

import type { ParsedWebhookEvent, WebhookEventKind } from './types.js';

interface RawRepo {
  full_name?: string;
  path_with_namespace?: string; // 自建 Gitee 偶有不同
  url?: string; // Gitee 自带 git URL 字段
  html_url?: string;
  ssh_url?: string;
}

function pickCloneUrl(repo: RawRepo | undefined): string {
  return repo?.url || repo?.html_url || repo?.ssh_url || '';
}

function pickFullName(repo: RawRepo | undefined): string {
  return repo?.full_name || repo?.path_with_namespace || '';
}

interface PushPayload {
  ref?: string;
  after?: string;
  repository?: RawRepo;
}

interface IssuePayload {
  action?: string; // 'open' | 'state_change' | 'comment' | ...
  issue?: {
    number?: number; // Gitee 用 string number 形式 #I3xxxx；用 string 兼容
    title?: string;
    body?: string;
    labels?: Array<{ name?: string } | string>;
  };
  repository?: RawRepo;
}

interface MRPayload {
  action?: string;
  pull_request?: {
    head?: { sha?: string; ref?: string };
    base?: { ref?: string };
    state?: string;
    merged?: boolean;
  };
  repository?: RawRepo;
}

/**
 * 解析 Gitee webhook payload。
 *
 * @param eventHeader  X-Gitee-Event 头值（如 "Issue Hook" / "Push Hook"）
 * @param body         已 parse 的 JSON body
 * @param deliveryId   X-Gitee-Timestamp 之类（可选）
 */
export function parseGiteeEvent(
  eventHeader: string,
  body: unknown,
  deliveryId?: string,
): ParsedWebhookEvent | null {
  if (!body || typeof body !== 'object') return null;

  const e = (eventHeader ?? '').trim();

  if (e === 'Push Hook') {
    const p = body as PushPayload;
    const cloneUrl = pickCloneUrl(p.repository);
    if (!cloneUrl || !p.after) return null;
    return {
      kind: 'push',
      cloneUrl,
      fullName: pickFullName(p.repository),
      headSha: p.after,
      ref: p.ref,
      deliveryId,
    };
  }

  if (e === 'Issue Hook') {
    const p = body as IssuePayload;
    // Gitee 'open' = 新建；'state_change' / 'comment' 不触发
    if (p.action !== 'open') return null;
    const cloneUrl = pickCloneUrl(p.repository);
    if (!cloneUrl || p.issue?.number === undefined) return null;
    const labels = (p.issue?.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
      .filter(Boolean);
    return {
      kind: 'issue_opened',
      cloneUrl,
      fullName: pickFullName(p.repository),
      headSha: '',
      issueNumber: typeof p.issue.number === 'string'
        ? Number((p.issue.number as string).replace(/[^0-9]/g, '')) || 0
        : (p.issue.number as number),
      issueTitle: p.issue.title ?? '',
      issueBody: p.issue.body ?? '',
      issueLabels: labels,
      deliveryId,
    };
  }

  if (e === 'Merge Request Hook') {
    const p = body as MRPayload;
    const cloneUrl = pickCloneUrl(p.repository);
    const headSha = p.pull_request?.head?.sha;
    if (!cloneUrl || !headSha) return null;
    let kind: WebhookEventKind = 'unsupported';
    if (p.action === 'open' || p.action === 'update') kind = 'pr_sync';
    else if (p.action === 'merge' || p.pull_request?.merged) kind = 'merge';
    else return null;
    return {
      kind,
      cloneUrl,
      fullName: pickFullName(p.repository),
      headSha,
      ref: p.pull_request?.base?.ref ?? p.pull_request?.head?.ref,
      deliveryId,
    };
  }

  return null;
}
