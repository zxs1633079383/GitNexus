// Phase 0 / Stage 2 — Jaeger Span Normalizer 8 fixtures 单测
//
// 与 roadmap §3.1 + §5.2 表格 1:1 对齐。
// 每个 fixture 单独 it(), 命中失败时 caller 一眼就能看见挂的是哪一格。

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeJaegerSpan } from '../../src/core/observability/jaeger-span-normalizer.js';
import type {
  JaegerSpan,
  SpanInput,
} from '../../src/core/observability/jaeger-span-types.js';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

describe('jaeger-span-normalizer · 8 fixtures', () => {
  // ───────────────────────────────────────────────────────────────────
  // Fixture #1 — 真实 trace JSON (CSES pre 环境抓取)
  // 同时验证: 双格式容器 / OTel 新 conv / framework 模板 /
  //           Java Micronaut 自动插桩 / OTel exception event
  // ───────────────────────────────────────────────────────────────────
  it('#1 真实 trace JSON: http.route 命中 + stacktrace 顶帧解析', () => {
    const real = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, 'jaeger-trace-real.json'), 'utf8'),
    ) as SpanInput;

    const out = normalizeJaegerSpan(real);

    expect(out.kind).toBe('http');
    expect(out.method).toBe('POST');
    // B1 (v1.2 sprint, 2026-05-01): normalizeConsumerPath case-preserved
    // (was lowercase pre-B1).
    expect(out.contractId).toBe(
      'http::POST::/taskManage/task/member/readTaskMemberState',
    );
    expect(out.hops).toEqual(['http.route']);
    expect(out.errorEvent).toBeDefined();
    expect(out.errorEvent?.type).toBe('java.lang.NullPointerException');
    expect(out.errorEvent?.topFrame).toEqual({
      file: 'TaskMemberReader.java',
      classMethod: 'TaskMemberReader.loadSnapshot',
      line: 96,
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Fixture #2 — 旧 conv http.url (OTel ≤1.20)
  // ───────────────────────────────────────────────────────────────────
  it('#2 旧 conv http.url + http.method: fallback 第 4 层命中', () => {
    const span: JaegerSpan = {
      tags: [
        { key: 'http.method', value: 'POST' },
        { key: 'http.url', value: 'https://api.example.com/api/cses/posts/create' },
      ],
    };
    const out = normalizeJaegerSpan(span);
    expect(out.kind).toBe('http');
    expect(out.method).toBe('POST');
    expect(out.contractId).toBe('http::POST::/api/cses/posts/create');
    expect(out.hops).toEqual(['http.url']);
  });

  // ───────────────────────────────────────────────────────────────────
  // Fixture #3 — 新 conv url.path (OTel ≥1.21)
  // ───────────────────────────────────────────────────────────────────
  it('#3 新 conv url.path + http.request.method: fallback 第 2 层命中', () => {
    const span: JaegerSpan = {
      attributes: {
        'http.request.method': 'POST',
        'url.path': '/Collaborate/loadWorkOrientForMember',
      },
    };
    const out = normalizeJaegerSpan(span);
    expect(out.kind).toBe('http');
    expect(out.method).toBe('POST');
    // B1 (v1.2 sprint, 2026-05-01): normalizeConsumerPath case-preserved
    // (camelCase last segment retained for manifest match symmetry).
    expect(out.contractId).toBe('http::POST::/Collaborate/loadWorkOrientForMember');
    expect(out.hops).toEqual(['url.path']);
  });

  // ───────────────────────────────────────────────────────────────────
  // Fixture #4 — 裸数字 ID (Bug-1 防御点)
  // ───────────────────────────────────────────────────────────────────
  it('#4 裸数字 path: normalizeConsumerPath 归一为 {param} (Bug-1)', () => {
    const span: JaegerSpan = {
      tags: [
        { key: 'http.method', value: 'GET' },
        { key: 'url.path', value: '/api/users/12345' },
      ],
    };
    const out = normalizeJaegerSpan(span);
    expect(out.kind).toBe('http');
    expect(out.method).toBe('GET');
    expect(out.contractId).toBe('http::GET::/api/users/{param}');
  });

  // ───────────────────────────────────────────────────────────────────
  // Fixture #5 — gRPC
  // ───────────────────────────────────────────────────────────────────
  it('#5 rpc.service + rpc.method: kind=grpc', () => {
    const span: JaegerSpan = {
      tags: [
        { key: 'rpc.service', value: 'cses.task.v1.TaskService' },
        { key: 'rpc.method', value: 'GetTask' },
      ],
    };
    const out = normalizeJaegerSpan(span);
    expect(out.kind).toBe('grpc');
    expect(out.contractId).toBe('grpc::cses.task.v1.TaskService/GetTask');
    expect(out.hops).toEqual(['rpc']);
  });

  // ───────────────────────────────────────────────────────────────────
  // Fixture #6 — Topic (Kafka / Pulsar)
  // ───────────────────────────────────────────────────────────────────
  it('#6 messaging.destination: kind=topic', () => {
    const span: JaegerSpan = {
      attributes: {
        'messaging.destination': 'order.created',
      },
    };
    const out = normalizeJaegerSpan(span);
    expect(out.kind).toBe('topic');
    expect(out.contractId).toBe('topic::order.created');
    expect(out.topic).toBe('order.created');
    expect(out.hops).toEqual(['topic']);
  });

  // ───────────────────────────────────────────────────────────────────
  // Fixture #7 — 仅 code.function + code.filepath (Method 直查兜底)
  // ───────────────────────────────────────────────────────────────────
  it('#7 code.function + code.filepath: kind=code', () => {
    const span: JaegerSpan = {
      tags: [
        { key: 'code.function', value: 'loadSnapshot' },
        { key: 'code.filepath', value: 'TaskMemberReader.java' },
      ],
    };
    const out = normalizeJaegerSpan(span);
    expect(out.kind).toBe('code');
    expect(out.codeFunction).toBe('loadSnapshot');
    expect(out.codeFilePath).toBe('TaskMemberReader.java');
    expect(out.hops).toEqual(['code']);
  });

  // ───────────────────────────────────────────────────────────────────
  // Fixture #8 — 全空 attribute → kind: 'unknown'
  // ───────────────────────────────────────────────────────────────────
  it('#8 全空 attribute: kind=unknown', () => {
    const span: JaegerSpan = { tags: [] };
    const out = normalizeJaegerSpan(span);
    expect(out.kind).toBe('unknown');
    expect(out.contractId).toBeUndefined();
    expect(out.hops).toEqual(['unknown']);
  });
});

describe('jaeger-span-normalizer · 退化路径 (额外覆盖)', () => {
  it('stacktrace fallback: HTTP/gRPC/topic/code 全 miss 时, 仅靠 stacktrace 反查', () => {
    const span: JaegerSpan = {
      logs: [
        {
          fields: [
            { key: 'event', value: 'exception' },
            { key: 'exception.type', value: 'java.lang.NullPointerException' },
            { key: 'exception.message', value: 'taskEntity is null' },
            {
              key: 'exception.stacktrace',
              value:
                'java.lang.NullPointerException: x\n\tat org.cses.foo.Bar.baz(Bar.java:42)',
            },
          ],
        },
      ],
    };
    const out = normalizeJaegerSpan(span);
    expect(out.kind).toBe('code');
    expect(out.hops).toEqual(['stacktrace']);
    expect(out.codeFunction).toBe('Bar.baz');
    expect(out.codeFilePath).toBe('Bar.java');
    expect(out.errorEvent?.topFrame?.line).toBe(42);
  });

  it('Jaeger envelope: { data: [{ spans: [...] }] } 也接受', () => {
    const envelope: SpanInput = {
      data: [
        {
          spans: [
            {
              tags: [
                { key: 'http.method', value: 'GET' },
                { key: 'http.route', value: '/health' },
              ],
            },
          ],
        },
      ],
    };
    const out = normalizeJaegerSpan(envelope);
    expect(out.kind).toBe('http');
    expect(out.contractId).toBe('http::GET::/health');
  });

  it('attributes 与 tags 同时存在时, attributes 覆盖 tags (caller 补充语义)', () => {
    const span: JaegerSpan = {
      tags: [
        { key: 'http.method', value: 'GET' },
        { key: 'url.path', value: '/old' },
      ],
      attributes: {
        'url.path': '/new',
      },
    };
    const out = normalizeJaegerSpan(span);
    expect(out.contractId).toBe('http::GET::/new');
  });
});
