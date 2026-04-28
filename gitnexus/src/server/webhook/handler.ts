// Express webhook 路由挂载点 — POST /webhook/github
//
// 职责：
//   1) raw body 收集（HMAC 必须用原始字节）
//   2) HMAC 验签
//   3) 事件解析
//   4) 调用 trigger 回调（由 api.ts 注入 → 调 JobManager.createJob + fork worker）
//   5) 返回 202 + 摘要 JSON
//
// 注：未配置 githubSecret 时整条路由禁用；不会自动放行未签名请求（避免 misconfig 漏洞）。

import type { Express, Request, Response } from 'express';
import express from 'express';
import { verifyGitHubSignature } from './hmac-verify.js';
import { parseGitHubEvent } from './event-parser.js';
import type { WebhookMountOptions } from './types.js';

/** 把原始 Buffer 暴露在 req.rawBody 上，HMAC 验签需要。 */
const rawBodySaver = (req: Request, _res: Response, buf: Buffer) => {
  if (buf && buf.length) {
    (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
  }
};

export function mountWebhookRoutes(app: Express, opts: WebhookMountOptions): void {
  if (!opts.githubSecret) {
    // 没有 secret = 路由不存在。任何 POST /webhook/github 走 404，安全静默。
    return;
  }
  const secret = opts.githubSecret;

  // 单独挂 raw body parser 在 /webhook/* 上 —— 不污染其他 JSON 路由。
  app.use('/webhook', express.json({ verify: rawBodySaver, limit: '1mb' }));

  app.post('/webhook/github', async (req, res) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const sigHeader = req.header('x-hub-signature-256') ?? undefined;
    const eventName = req.header('x-github-event') ?? '';
    const deliveryId = req.header('x-github-delivery') ?? undefined;

    if (!rawBody) {
      res.status(400).json({ error: 'empty body' });
      return;
    }

    const verify = verifyGitHubSignature(secret, rawBody, sigHeader);
    if (verify.ok === false) {
      res.status(401).json({ error: `signature ${verify.reason}` });
      return;
    }

    // ping → 200 OK 静默
    if (eventName === 'ping') {
      res.status(200).json({ ok: true, kind: 'ping' });
      return;
    }

    const event = parseGitHubEvent(eventName, req.body, deliveryId);
    if (!event) {
      res.status(202).json({ ok: true, kind: 'ignored', event: eventName });
      return;
    }

    try {
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
      // 409 = 单槽冲突；其他归 500
      const status = message.includes('already in progress') ? 409 : 500;
      res.status(status).json({ ok: false, error: message });
    }
  });
}
