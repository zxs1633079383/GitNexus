// Stage 4 / P5 — Regression Forensics 单测
//
// 用 git fixture 仓 (临时建一个真 .git, 跑 git log) 验证文件路径过滤 (Fix-1) +
// 时间近度排序。callbacks 用 mock 注入。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { regressionForensics } from '../../src/core/observability/regression-forensics.js';
import type { NormalizedSpan } from '../../src/core/observability/jaeger-span-types.js';

let TMP: string;

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-forensics-'));
  const run = (...args: string[]) =>
    execFileSync('git', ['-C', TMP, ...args], { encoding: 'utf-8' });

  fs.mkdirSync(path.join(TMP, 'src'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'src/lib'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'test'), { recursive: true });

  execFileSync('git', ['init', TMP], { encoding: 'utf-8' });
  run('config', 'user.email', 't@x');
  run('config', 'user.name', 'tester');
  run('config', 'commit.gpgsign', 'false');

  const commit = (files: Record<string, string>, msg: string) => {
    for (const [f, c] of Object.entries(files)) {
      fs.writeFileSync(path.join(TMP, f), c);
    }
    run('add', '.');
    run('commit', '-m', msg);
  };

  commit({ 'README.md': 'init' }, 'chore: init');
  // 注: vitest 跑得快, 后面的 commit 时间戳几乎一致, ranker 主要靠 confidence (hitKind) 排
  commit({ 'src/lib/util.ts': 'export const a = 1;' }, 'feat: add util');
  commit(
    { 'src/handler.ts': 'export function loadSnapshot() { return null; }' },
    'feat: handler that will fail',
  );
  commit({ 'test/handler.test.ts': 'test' }, 'test: cover handler');
  // 故意混入一个完全无关的 commit, 测试 Fix-1 文件过滤
  commit({ 'src/unrelated.ts': 'export const z = 0;' }, 'feat: unrelated work');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('regression-forensics', () => {
  it('Fix-1: 只命中 handler 文件 / blast radius 文件的 commit, 无关 commit 必须被丢', async () => {
    const spans: NormalizedSpan[] = [
      {
        kind: 'http',
        contractId: 'http::POST::/load',
        symbolUid: 'Method:src/handler.ts:loadSnapshot#1',
        hops: ['http.route'],
        errorEvent: { type: 'NPE', message: 'taskEntity null' },
      },
    ];

    const suspects = await regressionForensics({
      spans,
      repoPath: TMP,
      lookback: 50,
      resolveHandlerFile: async () => 'src/handler.ts',
      resolveBlastFiles: async () => ({
        handlerFile: 'src/handler.ts',
        depth1: new Set(['src/lib/util.ts']),
        depth2: new Set(),
        cross: new Set(),
      }),
    });

    expect(suspects.length).toBeGreaterThanOrEqual(2);
    // 必须有 handler-file commit
    const handlerHit = suspects.find((s) => s.hitKind === 'handler-file');
    expect(handlerHit).toBeDefined();
    expect(handlerHit?.subject).toContain('handler that will fail');
    // 必须有 blast-d1 commit (改 util.ts)
    const d1Hit = suspects.find((s) => s.hitKind === 'blast-d1');
    expect(d1Hit).toBeDefined();
    expect(d1Hit?.subject).toContain('add util');
    // **必须没有** 'feat: unrelated work' (未在 handler / radius)
    expect(suspects.some((s) => s.subject.includes('unrelated work'))).toBe(false);
    // **必须没有** 'chore: init' (无关 README)
    expect(suspects.some((s) => s.subject.includes('init'))).toBe(false);
  });

  it('confidence: handler-file > blast-d1 > blast-d2', async () => {
    const spans: NormalizedSpan[] = [
      {
        kind: 'code',
        symbolUid: 'Method:src/handler.ts:loadSnapshot#1',
        hops: ['stacktrace'],
        errorEvent: { type: 'NPE' },
      },
    ];
    const suspects = await regressionForensics({
      spans,
      repoPath: TMP,
      lookback: 50,
      resolveHandlerFile: async () => 'src/handler.ts',
      resolveBlastFiles: async () => ({
        handlerFile: 'src/handler.ts',
        depth1: new Set(['src/lib/util.ts']),
        depth2: new Set(['test/handler.test.ts']),
        cross: new Set(),
      }),
    });
    const byKind = new Map(suspects.map((s) => [s.hitKind, s]));
    expect(byKind.get('handler-file')!.confidence).toBeGreaterThanOrEqual(
      byKind.get('blast-d1')?.confidence ?? 0,
    );
    expect(byKind.get('blast-d1')!.confidence).toBeGreaterThan(
      byKind.get('blast-d2')?.confidence ?? 0,
    );
  });

  it('errorEvent 缺失的 span 必须不参与 forensics (Phase 0 自然过滤)', async () => {
    const suspects = await regressionForensics({
      spans: [
        {
          kind: 'http',
          symbolUid: 'Method:x:y#1',
          hops: ['http.route'],
          // no errorEvent
        },
      ],
      repoPath: TMP,
      lookback: 50,
      resolveHandlerFile: async () => 'src/handler.ts',
      resolveBlastFiles: async () => ({
        handlerFile: 'src/handler.ts',
        depth1: new Set(),
        depth2: new Set(),
        cross: new Set(),
      }),
    });
    expect(suspects).toEqual([]);
  });
});
