// HMAC 验签 — GitHub webhook X-Hub-Signature-256: sha256=<hex>
// 必须用 timingSafeEqual 防 timing-leak。纯函数、无副作用、可单测。

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SignatureVerifyResult } from './types.js';

const SIGNATURE_PREFIX = 'sha256=';

/**
 * 校验 GitHub HMAC sha256 签名。
 *
 * @param secret  GITNEXUS_WEBHOOK_SECRET（与 GitHub App 配置共享）
 * @param rawBody 原始请求体 Buffer（必须是 raw bytes，不是 JSON.parse 后再 stringify）
 * @param header  X-Hub-Signature-256 头值
 */
export function verifyGitHubSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): SignatureVerifyResult {
  if (!header) return { ok: false, reason: 'missing-header' };
  if (!header.startsWith(SIGNATURE_PREFIX)) return { ok: false, reason: 'bad-format' };

  const provided = header.slice(SIGNATURE_PREFIX.length);
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

  // timingSafeEqual 要求两个 Buffer 等长；不等长直接判失败避免抛错。
  if (provided.length !== expected.length) return { ok: false, reason: 'mismatch' };

  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return { ok: false, reason: 'mismatch' };

  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'mismatch' };
}
