// GitLab webhook 事件解析
//
// 与 GitHub 区别（关键）：
//  · X-Gitlab-Event 头："Push Hook" / "Issue Hook" / "Merge Request Hook" / "Note Hook"
//  · object_kind 字段也表明类型：push / issue / merge_request / note
//  · issue.action 用 "open" / "close" / "reopen"（无 "ed" 后缀）
//  · labels 用 { title: "x" } 而非 GitHub 的 { name: "x" }
//  · 顶层 + object_attributes 里都有 labels；object_attributes 优先

import type { ParsedWebhookEvent, WebhookEventKind } from './types.js';

interface RawProject {
  path_with_namespace?: string;
  git_http_url?: string;
  http_url?: string;
  git_ssh_url?: string;
  url?: string;
}

function pickCloneUrl(p: RawProject | undefined): string {
  return p?.git_http_url || p?.http_url || p?.url || p?.git_ssh_url || '';
}

function pickFullName(p: RawProject | undefined): string {
  return p?.path_with_namespace ?? '';
}

function pickLabels(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return (arr as Array<{ title?: string; name?: string } | string>)
    .map((l) => (typeof l === 'string' ? l : l.title ?? l.name ?? ''))
    .filter(Boolean);
}

interface PushPayload {
  ref?: string;
  after?: string;
  project?: RawProject;
}

interface IssuePayload {
  object_kind?: 'issue';
  object_attributes?: {
    iid?: number;
    title?: string;
    description?: string;
    action?: string; // 'open' | 'close' | 'reopen' | 'update'
    labels?: Array<{ title?: string }>;
  };
  labels?: Array<{ title?: string }>;
  project?: RawProject;
}

interface MRPayload {
  object_kind?: 'merge_request';
  object_attributes?: {
    iid?: number;
    action?: string; // 'open' | 'close' | 'merge' | 'update' | 'reopen'
    state?: string;
    last_commit?: { id?: string };
    source_branch?: string;
    target_branch?: string;
  };
  project?: RawProject;
}

/**
 * 解析 GitLab webhook payload。
 *
 * @param eventHeader  X-Gitlab-Event 头值
 * @param body         已 parse 的 JSON
 * @param deliveryId   X-Gitlab-Event-UUID（可选）
 */
export function parseGitLabEvent(
  eventHeader: string,
  body: unknown,
  deliveryId?: string,
): ParsedWebhookEvent | null {
  if (!body || typeof body !== 'object') return null;
  const e = (eventHeader ?? '').trim();

  if (e === 'Push Hook') {
    const p = body as PushPayload;
    const cloneUrl = pickCloneUrl(p.project);
    if (!cloneUrl || !p.after) return null;
    return {
      kind: 'push',
      cloneUrl,
      fullName: pickFullName(p.project),
      headSha: p.after,
      ref: p.ref,
      deliveryId,
    };
  }

  if (e === 'Issue Hook') {
    const p = body as IssuePayload;
    const action = p.object_attributes?.action;
    if (action !== 'open' && action !== 'reopen') return null;
    const cloneUrl = pickCloneUrl(p.project);
    const iid = p.object_attributes?.iid;
    if (!cloneUrl || typeof iid !== 'number') return null;
    // labels: 优先 object_attributes.labels，回退顶层 labels
    const oaLabels = pickLabels(p.object_attributes?.labels);
    const topLabels = pickLabels(p.labels);
    const labels = oaLabels.length > 0 ? oaLabels : topLabels;
    return {
      kind: 'issue_opened',
      cloneUrl,
      fullName: pickFullName(p.project),
      headSha: '',
      issueNumber: iid,
      issueTitle: p.object_attributes?.title ?? '',
      issueBody: p.object_attributes?.description ?? '',
      issueLabels: labels,
      deliveryId,
    };
  }

  if (e === 'Merge Request Hook') {
    const p = body as MRPayload;
    const action = p.object_attributes?.action;
    const headSha = p.object_attributes?.last_commit?.id;
    const cloneUrl = pickCloneUrl(p.project);
    if (!cloneUrl || !headSha) return null;
    let kind: WebhookEventKind = 'unsupported';
    if (action === 'open' || action === 'reopen' || action === 'update') {
      kind = 'pr_sync';
    } else if (action === 'merge') {
      kind = 'merge';
    } else {
      return null;
    }
    return {
      kind,
      cloneUrl,
      fullName: pickFullName(p.project),
      headSha,
      ref: p.object_attributes?.target_branch ?? p.object_attributes?.source_branch,
      deliveryId,
    };
  }

  // Note / Pipeline / Tag 等不重索引
  return null;
}
