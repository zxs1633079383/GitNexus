// Stage 7 · GitHub PR provider — 用 Node 原生 fetch 调 REST API
//
// 安全：token 走 GITHUB_AUTOPR_TOKEN（App-2 拆分后的 contents:write token）
// R-4 硬约束 — 这条 provider 只配 contents:write 的 token，绝不接 workflows:write

import type {
  CreatePROpts,
  CreatePRResult,
  EnsureBranchOpts,
  EnsureBranchResult,
  PRProvider,
  PutFileOpts,
} from '../types.js';

const GITHUB_API = 'https://api.github.com';

export interface GitHubProviderOpts {
  /** App-2 token（contents:write）。 */
  token: string;
  /** 默认 https://api.github.com，企业版可改。 */
  apiBase?: string;
}

export class GitHubPRProvider implements PRProvider {
  readonly kind = 'github' as const;
  private readonly token: string;
  private readonly apiBase: string;

  constructor(opts: GitHubProviderOpts) {
    if (!opts.token) throw new Error('GitHubPRProvider: token required');
    this.token = opts.token;
    this.apiBase = opts.apiBase ?? GITHUB_API;
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    return fetch(`${this.apiBase}${path}`, { ...init, headers });
  }

  async ensureBranch(opts: EnsureBranchOpts): Promise<EnsureBranchResult> {
    // 1) 看 branch 是否已存在
    const existRes = await this.fetch(
      `/repos/${opts.owner}/${opts.repo}/git/ref/heads/${encodeURIComponent(opts.branch)}`,
    );
    if (existRes.ok) {
      const json = (await existRes.json()) as any;
      return { branch: opts.branch, existed: true, sha: json.object.sha };
    }

    // 2) 不存在 → 拿 fromBranch 的 SHA
    const fromRes = await this.fetch(
      `/repos/${opts.owner}/${opts.repo}/git/ref/heads/${encodeURIComponent(opts.fromBranch)}`,
    );
    if (!fromRes.ok) {
      throw new Error(
        `ensureBranch: cannot read fromBranch "${opts.fromBranch}" — ${fromRes.status} ${await fromRes.text()}`,
      );
    }
    const fromJson = (await fromRes.json()) as any;
    const fromSha: string = fromJson.object.sha;

    // 3) create ref
    const createRes = await this.fetch(`/repos/${opts.owner}/${opts.repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${opts.branch}`, sha: fromSha }),
    });
    if (!createRes.ok) {
      throw new Error(
        `ensureBranch: create failed — ${createRes.status} ${await createRes.text()}`,
      );
    }
    return { branch: opts.branch, existed: false, sha: fromSha };
  }

  async putFile(opts: PutFileOpts): Promise<void> {
    const url = `/repos/${opts.owner}/${opts.repo}/contents/${opts.path}`;

    // 拿现有 sha（update / delete 必填）
    let existingSha: string | undefined;
    if (opts.op === 'update' || opts.op === 'delete') {
      const head = await this.fetch(`${url}?ref=${encodeURIComponent(opts.branch)}`);
      if (head.ok) {
        const j = (await head.json()) as any;
        existingSha = j.sha;
      }
    }

    if (opts.op === 'delete') {
      if (!existingSha) return; // 没文件就不删
      const r = await this.fetch(url, {
        method: 'DELETE',
        body: JSON.stringify({
          message: opts.message,
          sha: existingSha,
          branch: opts.branch,
        }),
      });
      if (!r.ok) throw new Error(`putFile delete failed: ${r.status} ${await r.text()}`);
      return;
    }

    const body = {
      message: opts.message,
      content: Buffer.from(opts.content).toString('base64'),
      branch: opts.branch,
      ...(existingSha ? { sha: existingSha } : {}),
    };
    const r = await this.fetch(url, { method: 'PUT', body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`putFile failed: ${r.status} ${await r.text()}`);
  }

  async createPR(opts: CreatePROpts): Promise<CreatePRResult> {
    const r = await this.fetch(`/repos/${opts.owner}/${opts.repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: opts.title,
        body: opts.body,
        head: opts.head,
        base: opts.base,
        draft: opts.draft,
      }),
    });
    if (!r.ok) {
      throw new Error(`createPR failed: ${r.status} ${await r.text()}`);
    }
    const j = (await r.json()) as any;
    return { prNumber: j.number, url: j.html_url, branch: opts.head };
  }

  async addLabels(opts: {
    owner: string;
    repo: string;
    prNumber: number;
    labels: string[];
  }): Promise<void> {
    if (!opts.labels?.length) return;
    const r = await this.fetch(
      `/repos/${opts.owner}/${opts.repo}/issues/${opts.prNumber}/labels`,
      { method: 'POST', body: JSON.stringify({ labels: opts.labels }) },
    );
    if (!r.ok) throw new Error(`addLabels failed: ${r.status} ${await r.text()}`);
  }

  async postIssueComment(opts: {
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
  }): Promise<{ url?: string }> {
    const r = await this.fetch(
      `/repos/${opts.owner}/${opts.repo}/issues/${opts.issueNumber}/comments`,
      { method: 'POST', body: JSON.stringify({ body: opts.body }) },
    );
    if (!r.ok) throw new Error(`postIssueComment failed: ${r.status} ${await r.text()}`);
    const j = (await r.json()) as any;
    return { url: j.html_url };
  }
}
