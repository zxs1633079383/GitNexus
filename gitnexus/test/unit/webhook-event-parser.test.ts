// P1 · webhook GitHub 事件解析
// 覆盖：push / pr_sync / merge / 其他 PR action / ping / 缺字段。

import { describe, expect, it } from 'vitest';
import { parseGitHubEvent } from '../../src/server/webhook/event-parser.js';

const REPO = {
  full_name: 'acme/api-server',
  clone_url: 'https://github.com/acme/api-server.git',
  ssh_url: 'git@github.com:acme/api-server.git',
};

describe('parseGitHubEvent', () => {
  it('push 事件 → kind=push + cloneUrl + headSha', () => {
    const r = parseGitHubEvent(
      'push',
      { ref: 'refs/heads/main', after: 'sha-after', repository: REPO },
      'd-1',
    );
    expect(r).toEqual({
      kind: 'push',
      cloneUrl: REPO.clone_url,
      fullName: REPO.full_name,
      headSha: 'sha-after',
      ref: 'refs/heads/main',
      deliveryId: 'd-1',
    });
  });

  it('PR synchronize → kind=pr_sync', () => {
    const r = parseGitHubEvent('pull_request', {
      action: 'synchronize',
      pull_request: {
        head: { sha: 'pr-head', ref: 'feat/x' },
        base: { ref: 'main' },
        merged: false,
      },
      repository: REPO,
    });
    expect(r?.kind).toBe('pr_sync');
    expect(r?.headSha).toBe('pr-head');
    expect(r?.ref).toBe('main');
  });

  it('PR closed + merged → kind=merge', () => {
    const r = parseGitHubEvent('pull_request', {
      action: 'closed',
      pull_request: {
        head: { sha: 'pr-head', ref: 'feat/x' },
        base: { ref: 'main' },
        merged: true,
      },
      repository: REPO,
    });
    expect(r?.kind).toBe('merge');
  });

  it('PR closed but not merged → null（不重索引）', () => {
    const r = parseGitHubEvent('pull_request', {
      action: 'closed',
      pull_request: { head: { sha: 's' }, base: { ref: 'main' }, merged: false },
      repository: REPO,
    });
    expect(r).toBeNull();
  });

  it('ping → null（handler 自己回 200）', () => {
    expect(parseGitHubEvent('ping', { zen: 'hi', repository: REPO })).toBeNull();
  });

  it('push 缺 after → null', () => {
    const r = parseGitHubEvent('push', { ref: 'refs/heads/main', repository: REPO });
    expect(r).toBeNull();
  });

  it('repository 缺 clone_url 时回退到 ssh_url', () => {
    const r = parseGitHubEvent('push', {
      ref: 'refs/heads/main',
      after: 'x',
      repository: { full_name: 'a/b', ssh_url: 'git@github.com:a/b.git' },
    });
    expect(r?.cloneUrl).toBe('git@github.com:a/b.git');
  });

  it('未知事件 → null', () => {
    expect(parseGitHubEvent('issues', { action: 'opened', repository: REPO })).toBeNull();
  });
});
