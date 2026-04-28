// Stage 7 · GitLab MR provider — R-17 Draft API 版本兜底
//
// GitLab Draft MR API 在 v4 ≥ 15.x 才支持；旧版本 fallback 到 "WIP:" 前缀。

import type {
  CreatePROpts,
  CreatePRResult,
  EnsureBranchOpts,
  EnsureBranchResult,
  PRProvider,
  PutFileOpts,
} from '../types.js';

export interface GitLabProviderOpts {
  /** GitLab Personal Access Token（api scope）。 */
  token: string;
  /** 默认 https://gitlab.com/api/v4，自建实例改。 */
  apiBase?: string;
}

export class GitLabPRProvider implements PRProvider {
  readonly kind = 'gitlab' as const;
  private readonly token: string;
  private readonly apiBase: string;
  /** 缓存的 GitLab 主版本（首次调用时探测，决定走原生 Draft 还是 WIP fallback）。 */
  private apiVersionMajor?: number;

  constructor(opts: GitLabProviderOpts) {
    if (!opts.token) throw new Error('GitLabPRProvider: token required');
    this.token = opts.token;
    this.apiBase = opts.apiBase ?? 'https://gitlab.com/api/v4';
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  private async detectVersion(): Promise<number> {
    if (this.apiVersionMajor !== undefined) return this.apiVersionMajor;
    try {
      const r = await this.fetch('/version');
      if (r.ok) {
        const j = (await r.json()) as any;
        const major = Number((j.version ?? '0').split('.')[0]);
        this.apiVersionMajor = Number.isFinite(major) ? major : 0;
      } else {
        this.apiVersionMajor = 0;
      }
    } catch {
      this.apiVersionMajor = 0;
    }
    return this.apiVersionMajor;
  }

  private projectId(owner: string, repo: string): string {
    return encodeURIComponent(`${owner}/${repo}`);
  }

  async ensureBranch(opts: EnsureBranchOpts): Promise<EnsureBranchResult> {
    const pid = this.projectId(opts.owner, opts.repo);
    const head = await this.fetch(
      `/projects/${pid}/repository/branches/${encodeURIComponent(opts.branch)}`,
    );
    if (head.ok) {
      const j = (await head.json()) as any;
      return { branch: opts.branch, existed: true, sha: j.commit?.id ?? '' };
    }
    const create = await this.fetch(
      `/projects/${pid}/repository/branches?branch=${encodeURIComponent(
        opts.branch,
      )}&ref=${encodeURIComponent(opts.fromBranch)}`,
      { method: 'POST' },
    );
    if (!create.ok) {
      throw new Error(`ensureBranch failed: ${create.status} ${await create.text()}`);
    }
    const j = (await create.json()) as any;
    return { branch: opts.branch, existed: false, sha: j.commit?.id ?? '' };
  }

  async putFile(opts: PutFileOpts): Promise<void> {
    const pid = this.projectId(opts.owner, opts.repo);
    const url = `/projects/${pid}/repository/files/${encodeURIComponent(opts.path)}`;
    const action = opts.op === 'create' ? 'POST' : opts.op === 'delete' ? 'DELETE' : 'PUT';
    const body = {
      branch: opts.branch,
      content: opts.content,
      commit_message: opts.message,
    };
    const r = await this.fetch(url, { method: action, body: JSON.stringify(body) });
    if (!r.ok && !(opts.op === 'delete' && r.status === 404)) {
      throw new Error(`putFile failed: ${r.status} ${await r.text()}`);
    }
  }

  async createPR(opts: CreatePROpts): Promise<CreatePRResult> {
    const pid = this.projectId(opts.owner, opts.repo);
    const major = await this.detectVersion();
    let title = opts.title;
    const body: Record<string, unknown> = {
      source_branch: opts.head,
      target_branch: opts.base,
      description: opts.body,
    };
    if (opts.draft) {
      if (major >= 15) body.draft = true;
      else title = `WIP: ${title}`; // R-17 fallback
    }
    body.title = title;

    const r = await this.fetch(`/projects/${pid}/merge_requests`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`createPR failed: ${r.status} ${await r.text()}`);
    const j = (await r.json()) as any;
    return { prNumber: j.iid, url: j.web_url, branch: opts.head };
  }

  async addLabels(opts: {
    owner: string;
    repo: string;
    prNumber: number;
    labels: string[];
  }): Promise<void> {
    if (!opts.labels?.length) return;
    const pid = this.projectId(opts.owner, opts.repo);
    const r = await this.fetch(
      `/projects/${pid}/merge_requests/${opts.prNumber}?add_labels=${encodeURIComponent(opts.labels.join(','))}`,
      { method: 'PUT' },
    );
    if (!r.ok) throw new Error(`addLabels failed: ${r.status} ${await r.text()}`);
  }

  async postIssueComment(opts: {
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
  }): Promise<{ url?: string }> {
    const pid = this.projectId(opts.owner, opts.repo);
    const r = await this.fetch(`/projects/${pid}/issues/${opts.issueNumber}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body: opts.body }),
    });
    if (!r.ok) throw new Error(`postIssueComment failed: ${r.status} ${await r.text()}`);
    const j = (await r.json()) as any;
    // GitLab note 返回不直接带 web_url；构造 issue URL + #note_<id>
    return { url: `${this.apiBase.replace('/api/v4', '')}/${opts.owner}/${opts.repo}/-/issues/${opts.issueNumber}#note_${j.id}` };
  }
}
