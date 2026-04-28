// Stage 7 · Gitee PR provider — 内网 / 公有 Gitee 都可用
//
// 与 GitHub 主要区别：
//  · 创建分支: POST /repos/{o}/{r}/branches  body: {refs, branch_name}
//             (GitHub 是 POST /git/refs)
//  · 写文件:  POST/PUT/DELETE /repos/{o}/{r}/contents/{path}  body 含 access_token
//  · 鉴权:    支持 Authorization: token <t> + access_token query；这里用 query 兼容性最好
//  · PR API:  POST /repos/{o}/{r}/pulls  body 字段同 GitHub (head/base/title/body)

import type {
  CreatePROpts,
  CreatePRResult,
  EnsureBranchOpts,
  EnsureBranchResult,
  PRProvider,
  PutFileOpts,
} from '../types.js';

const GITEE_API = 'https://gitee.com/api/v5';

export interface GiteeProviderOpts {
  /** Gitee 私人令牌（projects scope）。内网企业版同样的形式 */
  token: string;
  /** 自建/企业版 Gitee 改这个，例如 https://gitee.example.com/api/v5 */
  apiBase?: string;
}

export class GiteePRProvider implements PRProvider {
  readonly kind = 'gitee' as const;
  private readonly token: string;
  private readonly apiBase: string;

  constructor(opts: GiteeProviderOpts) {
    if (!opts.token) throw new Error('GiteePRProvider: token required');
    this.token = opts.token;
    this.apiBase = opts.apiBase ?? GITEE_API;
  }

  /** Gitee 走 access_token query 参数最稳（form-data / json 都接受） */
  private withToken(path: string): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${this.apiBase}${path}${sep}access_token=${encodeURIComponent(this.token)}`;
  }

  private async fetchJson(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return fetch(this.withToken(path), {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  async ensureBranch(opts: EnsureBranchOpts): Promise<EnsureBranchResult> {
    // 1) 看是否已存在
    const existRes = await this.fetchJson(
      `/repos/${opts.owner}/${opts.repo}/branches/${encodeURIComponent(opts.branch)}`,
    );
    if (existRes.ok) {
      const j = (await existRes.json()) as any;
      return { branch: opts.branch, existed: true, sha: j.commit?.sha ?? '' };
    }

    // 2) 创建（Gitee 用 POST /repos/.../branches，body refs + branch_name）
    const createRes = await this.fetchJson(
      `/repos/${opts.owner}/${opts.repo}/branches`,
      {
        method: 'POST',
        body: JSON.stringify({
          refs: opts.fromBranch,
          branch_name: opts.branch,
        }),
      },
    );
    if (!createRes.ok) {
      throw new Error(
        `ensureBranch (gitee) failed: ${createRes.status} ${await createRes.text()}`,
      );
    }
    const j = (await createRes.json()) as any;
    return { branch: opts.branch, existed: false, sha: j.commit?.sha ?? '' };
  }

  async putFile(opts: PutFileOpts): Promise<void> {
    const url = `/repos/${opts.owner}/${opts.repo}/contents/${opts.path}`;

    let existingSha: string | undefined;
    if (opts.op === 'update' || opts.op === 'delete') {
      const head = await this.fetchJson(
        `${url}?ref=${encodeURIComponent(opts.branch)}`,
      );
      if (head.ok) {
        const j = (await head.json()) as any;
        existingSha = j.sha;
      }
    }

    const body: Record<string, unknown> = {
      message: opts.message,
      content: Buffer.from(opts.content).toString('base64'),
      branch: opts.branch,
    };
    if (existingSha) body.sha = existingSha;

    const method =
      opts.op === 'delete' ? 'DELETE' : opts.op === 'create' ? 'POST' : 'PUT';

    if (opts.op === 'delete' && !existingSha) return; // 没文件就不删

    const r = await this.fetchJson(url, {
      method,
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      throw new Error(`putFile (gitee) failed: ${r.status} ${await r.text()}`);
    }
  }

  async createPR(opts: CreatePROpts): Promise<CreatePRResult> {
    // Gitee PR 没有原生 draft 字段（没 GitHub 那个 boolean）；用 WIP: 前缀模拟 (Fix-17 同 GitLab 旧版)
    const title = opts.draft ? `WIP: ${opts.title}` : opts.title;
    const r = await this.fetchJson(`/repos/${opts.owner}/${opts.repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        body: opts.body,
        head: opts.head,
        base: opts.base,
      }),
    });
    if (!r.ok) {
      throw new Error(`createPR (gitee) failed: ${r.status} ${await r.text()}`);
    }
    const j = (await r.json()) as any;
    return {
      prNumber: j.number,
      url: j.html_url ?? j._links?.html?.href ?? '',
      branch: opts.head,
    };
  }

  async addLabels(opts: {
    owner: string;
    repo: string;
    prNumber: number;
    labels: string[];
  }): Promise<void> {
    if (!opts.labels?.length) return;
    // Gitee labels 是 PUT 一次写全（label name 列表）
    const r = await this.fetchJson(
      `/repos/${opts.owner}/${opts.repo}/issues/${opts.prNumber}/labels`,
      {
        method: 'POST',
        body: JSON.stringify(opts.labels),
      },
    );
    if (!r.ok) {
      throw new Error(`addLabels (gitee) failed: ${r.status} ${await r.text()}`);
    }
  }

  async postIssueComment(opts: {
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
  }): Promise<{ url?: string }> {
    // Gitee issue comment endpoint 注意：路径用 issue 的 number 字符串而非 id
    const r = await this.fetchJson(
      `/repos/${opts.owner}/${opts.repo}/issues/${opts.issueNumber}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ body: opts.body }),
      },
    );
    if (!r.ok) {
      throw new Error(
        `postIssueComment (gitee) failed: ${r.status} ${await r.text()}`,
      );
    }
    const j = (await r.json()) as any;
    return { url: j.html_url };
  }
}
