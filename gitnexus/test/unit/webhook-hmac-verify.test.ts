// P1 · webhook HMAC sha256 验签
// 覆盖：缺头、格式错、长度错、签名错、合法签名。

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGitHubSignature } from '../../src/server/webhook/hmac-verify.js';

const SECRET = 'top-secret-from-env';
const BODY = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', after: 'deadbeef' }));

function signedHeader(secret: string, body: Buffer): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyGitHubSignature', () => {
  it('valid header → ok=true', () => {
    const r = verifyGitHubSignature(SECRET, BODY, signedHeader(SECRET, BODY));
    expect(r.ok).toBe(true);
  });

  it('missing header → missing-header', () => {
    const r = verifyGitHubSignature(SECRET, BODY, undefined);
    expect(r).toEqual({ ok: false, reason: 'missing-header' });
  });

  it('header without sha256= prefix → bad-format', () => {
    const r = verifyGitHubSignature(SECRET, BODY, 'md5=abc');
    expect(r).toEqual({ ok: false, reason: 'bad-format' });
  });

  it('different length → mismatch', () => {
    const r = verifyGitHubSignature(SECRET, BODY, 'sha256=tooshort');
    expect(r).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('wrong secret → mismatch (timing-safe)', () => {
    const r = verifyGitHubSignature(SECRET, BODY, signedHeader('wrong-secret', BODY));
    expect(r).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('tampered body → mismatch', () => {
    const sig = signedHeader(SECRET, BODY);
    const tampered = Buffer.from('{"ref":"refs/heads/evil","after":"00"}');
    const r = verifyGitHubSignature(SECRET, tampered, sig);
    expect(r).toEqual({ ok: false, reason: 'mismatch' });
  });
});
