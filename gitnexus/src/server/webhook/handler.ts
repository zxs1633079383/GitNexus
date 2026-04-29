// Express webhook 路由挂载点
//
// 路由:
//   POST /webhook/github  (HMAC sha256, X-Hub-Signature-256)
//   POST /webhook/gitlab  (X-Gitlab-Token 明文, timingSafeEqual)
//   POST /webhook/gitee   (X-Gitee-Token 明文, timingSafeEqual)
//   POST /webhook         别名: 按请求头 X-Gitlab-Event / X-Gitee-Event /
//                         X-GitHub-Event 自动 dispatch (用户配 webhook URL
//                         不必带 provider 后缀)
//
// 注：未配置任一 secret 时整条 /webhook 命名空间禁用，404 静默防 misconfig。

import type { Express, Request, Response } from 'express';
import express from 'express';
import {
  verifyGiteeToken,
  verifyGitHubSignature,
  verifyGitLabToken,
} from './hmac-verify.js';
import { parseGitHubEvent } from './event-parser.js';
import { parseGiteeEvent } from './event-parser-gitee.js';
import { parseGitLabEvent } from './event-parser-gitlab.js';
import type { ParsedWebhookEvent, WebhookMountOptions } from './types.js';

/** 把原始 Buffer 暴露在 req.rawBody 上，HMAC 验签需要。 */
const rawBodySaver = (req: Request, _res: Response, buf: Buffer) => {
  if (buf && buf.length) {
    (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
  }
};

export function mountWebhookRoutes(app: Express, opts: WebhookMountOptions): void {
  if (!opts.githubSecret && !opts.gitlabSecret && !opts.giteeSecret) return;

  app.use('/webhook', express.json({ verify: rawBodySaver, limit: '1mb' }));

  if (opts.githubSecret) {
    app.post('/webhook/github', (req, res) =>
      handleGitHubRequest(req, res, opts),
    );
  }
  if (opts.gitlabSecret) {
    app.post('/webhook/gitlab', (req, res) =>
      handleGitLabRequest(req, res, opts),
    );
  }
  if (opts.giteeSecret) {
    app.post('/webhook/gitee', (req, res) =>
      handleGiteeRequest(req, res, opts),
    );
  }

  // 通用别名：按请求头自动 dispatch
  app.post('/webhook', async (req, res) => {
    if (req.header('x-gitlab-event') && opts.gitlabSecret) {
      return handleGitLabRequest(req, res, opts);
    }
    if (req.header('x-gitee-event') && opts.giteeSecret) {
      return handleGiteeRequest(req, res, opts);
    }
    if (req.header('x-github-event') && opts.githubSecret) {
      return handleGitHubRequest(req, res, opts);
    }
    res.status(400).json({
      error:
        'cannot detect provider — missing X-Gitlab-Event / X-Gitee-Event / X-GitHub-Event header',
    });
  });
}

// ─── 三 provider 入口（通用别名 + provider 后缀路由共享） ──────────

async function handleGitHubRequest(
  req: Request,
  res: Response,
  opts: WebhookMountOptions,
): Promise<void> {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const sigHeader = req.header('x-hub-signature-256') ?? undefined;
  const eventName = req.header('x-github-event') ?? '';
  const deliveryId = req.header('x-github-delivery') ?? undefined;

  if (!rawBody) {
    res.status(400).json({ error: 'empty body' });
    return;
  }
  const verify = verifyGitHubSignature(opts.githubSecret!, rawBody, sigHeader);
  if (verify.ok === false) {
    res.status(401).json({ error: `signature ${verify.reason}` });
    return;
  }
  if (eventName === 'ping') {
    res.status(200).json({ ok: true, kind: 'ping' });
    return;
  }
  const event = parseGitHubEvent(eventName, req.body, deliveryId);
  if (!event) {
    res.status(202).json({ ok: true, kind: 'ignored', event: eventName });
    return;
  }
  await dispatchEvent(res, opts, event);
}

async function handleGitLabRequest(
  req: Request,
  res: Response,
  opts: WebhookMountOptions,
): Promise<void> {
  const tokenHeader = req.header('x-gitlab-token') ?? undefined;
  const eventHeader = req.header('x-gitlab-event') ?? '';
  const deliveryId = req.header('x-gitlab-event-uuid') ?? undefined;

  const verify = verifyGitLabToken(opts.gitlabSecret!, tokenHeader);
  if (verify.ok === false) {
    res.status(401).json({ error: `gitlab token ${verify.reason}` });
    return;
  }
  const event = parseGitLabEvent(eventHeader, req.body, deliveryId);
  if (!event) {
    res.status(202).json({ ok: true, kind: 'ignored', event: eventHeader });
    return;
  }
  await dispatchEvent(res, opts, event);
}

async function handleGiteeRequest(
  req: Request,
  res: Response,
  opts: WebhookMountOptions,
): Promise<void> {
  const tokenHeader = req.header('x-gitee-token') ?? undefined;
  const eventHeader = req.header('x-gitee-event') ?? '';
  const deliveryId = req.header('x-gitee-timestamp') ?? undefined;

  const verify = verifyGiteeToken(opts.giteeSecret!, tokenHeader);
  if (verify.ok === false) {
    res.status(401).json({ error: `gitee token ${verify.reason}` });
    return;
  }
  const event = parseGiteeEvent(eventHeader, req.body, deliveryId);
  if (!event) {
    res.status(202).json({ ok: true, kind: 'ignored', event: eventHeader });
    return;
  }
  await dispatchEvent(res, opts, event);
}

// ─── 三 provider 共享 dispatcher ───────────────────────────────────

async function dispatchEvent(
  res: Response,
  opts: WebhookMountOptions,
  event: ParsedWebhookEvent,
): Promise<void> {
  try {
    if (event.kind === 'issue_opened') {
      if (!opts.issueTrigger) {
        res.status(202).json({
          ok: true,
          kind: 'issue_opened',
          ignored: 'no issueTrigger configured',
        });
        return;
      }
      const r = await opts.issueTrigger(event);
      res.status(202).json({
        ok: r.ok,
        kind: 'issue_opened',
        repo: event.fullName,
        issueNumber: event.issueNumber,
        pipelineStarted: r.pipelineStarted,
        reason: r.reason,
        commentUrl: r.commentUrl,
      });
      return;
    }

    const result = await opts.trigger(event);
    res.status(202).json({
      ok: true,
      kind: event.kind,
      repo: event.fullName,
      sha: event.headSha,
      jobId: result.jobId,
      status: result.status,
      reason: result.reason,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'trigger failed';
    const status = message.includes('already in progress') ? 409 : 500;
    res.status(status).json({ ok: false, error: message });
  }
}
