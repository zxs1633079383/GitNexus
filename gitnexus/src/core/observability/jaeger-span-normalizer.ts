// query-only — must not be called from any pipeline phase
//
// Phase 0 / Stage 2 — Trace2Code Resolver
// 主入口: 把 Jaeger / OTel span (双格式: tags[] 或 attributes{}) 归一成
// `NormalizedSpan`。下游 (Stage 4 P5) 直接消费 contractId / symbolUid。
//
// 5 层 HTTP fallback (优先级从高到低):
//   1. http.route          (框架模板, 最准。Java Micronaut / Spring 命中)
//   2. url.path            (OTel ≥1.21 新 conv)
//   3. url.full            (OTel ≥1.21 全 URL)
//   4. http.url            (OTel ≤1.20 旧 conv)
//   5. http.target         (老老 conv)
// + gRPC / topic / code.* / stacktrace 兜底链 (见 NormalizedSpan.kind)
//
// 关键修正 (review v1→v2):
//   Bug-1: 用 normalizeConsumerPath, **不**用 normalizeHttpPath —— 防御
//          `/api/users/123` 这类裸数字路径被原样写进 contractId, 导致
//          Route 直查 miss。
//
// Roadmap §3.1 / §2.2 Bug-1, RULES §0.4 (query-only)

import { normalizeConsumerPath } from '../group/extractors/http-route-extractor.js';
import { parseStacktraceTopFrame } from './stacktrace-parser.js';
import type {
  FallbackHop,
  JaegerSpan,
  JaegerTag,
  NormalizedSpan,
  SpanInput,
} from './jaeger-span-types.js';

/**
 * 把双格式 envelope 归一成扁平 KV map。优先级:
 *   tags[] (Jaeger Query API) > attributes{} (OTel JSON 直出)
 * 两种都给时, attributes 后写, 后者覆盖前者 —— 让 caller 可以补充字段。
 */
function flattenSpan(span: JaegerSpan): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  if (Array.isArray(span.tags)) {
    for (const t of span.tags as JaegerTag[]) {
      if (t && typeof t.key === 'string') flat[t.key] = t.value;
    }
  }
  if (span.attributes && typeof span.attributes === 'object') {
    for (const [k, v] of Object.entries(span.attributes)) flat[k] = v;
  }
  return flat;
}

/** 取 Jaeger envelope 里的第一条 span (Stage 4 也可以批量传入)。 */
function pickSpan(input: SpanInput): JaegerSpan | null {
  if (!input || typeof input !== 'object') return null;
  if ('data' in input && Array.isArray(input.data)) {
    const spans = input.data[0]?.spans;
    return Array.isArray(spans) && spans.length > 0 ? (spans[0] as JaegerSpan) : null;
  }
  return input as JaegerSpan;
}

function pick<T = unknown>(flat: Record<string, unknown>, keys: readonly string[]): T | undefined {
  for (const k of keys) {
    const v = flat[k];
    if (v !== undefined && v !== null && v !== '') return v as T;
  }
  return undefined;
}

const HTTP_PATH_HOPS: ReadonlyArray<{ key: string; hop: FallbackHop; transform?: (s: string) => string }> = [
  { key: 'http.route', hop: 'http.route' },
  { key: 'url.path', hop: 'url.path' },
  { key: 'url.full', hop: 'url.full', transform: stripUrlToPath },
  { key: 'http.url', hop: 'http.url', transform: stripUrlToPath },
  { key: 'http.target', hop: 'http.target' },
];

function stripUrlToPath(raw: string): string {
  try {
    return new URL(raw).pathname || '/';
  } catch {
    // 不是合法 URL: 退化成裸路径
    return raw.replace(/^https?:\/\/[^/]+/i, '') || raw;
  }
}

function findHttpPath(flat: Record<string, unknown>): { path: string; hop: FallbackHop } | null {
  for (const candidate of HTTP_PATH_HOPS) {
    const raw = flat[candidate.key];
    if (typeof raw === 'string' && raw.length > 0) {
      const path = candidate.transform ? candidate.transform(raw) : raw;
      return { path, hop: candidate.hop };
    }
  }
  return null;
}

/**
 * 抽错误事件 (OTel exception event): 既看 logs[].fields[event=exception]
 * (Jaeger 标准), 也看 events[].name=='exception' (OTel 直出)。
 */
function extractErrorEvent(span: JaegerSpan, flat: Record<string, unknown>): NormalizedSpan['errorEvent'] {
  let stack: string | undefined;
  let type: string | undefined;
  let message: string | undefined;

  if (Array.isArray(span.logs)) {
    for (const log of span.logs) {
      if (!log?.fields) continue;
      let isExc = false;
      const fieldMap: Record<string, unknown> = {};
      for (const f of log.fields) {
        if (f && typeof f.key === 'string') fieldMap[f.key] = f.value;
        if (f?.key === 'event' && f.value === 'exception') isExc = true;
      }
      if (isExc) {
        stack = stack ?? (typeof fieldMap['exception.stacktrace'] === 'string' ? (fieldMap['exception.stacktrace'] as string) : undefined);
        type = type ?? (typeof fieldMap['exception.type'] === 'string' ? (fieldMap['exception.type'] as string) : undefined);
        message = message ?? (typeof fieldMap['exception.message'] === 'string' ? (fieldMap['exception.message'] as string) : undefined);
      }
    }
  }
  if (Array.isArray(span.events)) {
    for (const e of span.events) {
      if (e?.name === 'exception' && e.attributes) {
        stack = stack ?? (typeof e.attributes['exception.stacktrace'] === 'string' ? (e.attributes['exception.stacktrace'] as string) : undefined);
        type = type ?? (typeof e.attributes['exception.type'] === 'string' ? (e.attributes['exception.type'] as string) : undefined);
        message = message ?? (typeof e.attributes['exception.message'] === 'string' ? (e.attributes['exception.message'] as string) : undefined);
      }
    }
  }
  // 兜底: 顶层 attribute (有些 SDK 不发 event)
  if (!stack && typeof flat['exception.stacktrace'] === 'string') stack = flat['exception.stacktrace'] as string;
  if (!type && typeof flat['exception.type'] === 'string') type = flat['exception.type'] as string;
  if (!message && typeof flat['exception.message'] === 'string') message = flat['exception.message'] as string;

  if (!stack && !type && !message) return undefined;

  const top = parseStacktraceTopFrame(stack);
  return {
    type,
    message,
    topFrame: top
      ? { file: top.file, classMethod: top.classMethod, line: top.line }
      : undefined,
  };
}

/**
 * 主入口 — Jaeger / OTel span → NormalizedSpan
 */
export function normalizeJaegerSpan(input: SpanInput): NormalizedSpan {
  const span = pickSpan(input);
  if (!span) {
    return { kind: 'unknown', hops: ['unknown'] };
  }

  const flat = flattenSpan(span);
  const errorEvent = extractErrorEvent(span, flat);

  // ─── 1. HTTP 主链路 ────────────────────────────────────────────────
  const method =
    (pick<string>(flat, ['http.request.method', 'http.method']) ?? '').toString().toUpperCase() ||
    undefined;
  const httpHit = findHttpPath(flat);
  if (httpHit && method) {
    // Bug-1: normalizeConsumerPath 把裸数字段 → {param}, normalizeHttpPath 不会
    const normalized = normalizeConsumerPath(httpHit.path);
    return {
      kind: 'http',
      method,
      path: normalized,
      contractId: `http::${method}::${normalized}`,
      hops: [httpHit.hop],
      errorEvent,
    };
  }

  // ─── 2. gRPC ────────────────────────────────────────────────────────
  const rpcSvc = pick<string>(flat, ['rpc.service']);
  const rpcMethod = pick<string>(flat, ['rpc.method']);
  if (rpcSvc && rpcMethod) {
    return {
      kind: 'grpc',
      service: rpcSvc,
      contractId: `grpc::${rpcSvc}/${rpcMethod}`,
      hops: ['rpc'],
      errorEvent,
    };
  }

  // ─── 3. Topic (Kafka / Pulsar / 等 Messaging) ───────────────────────
  const topic = pick<string>(flat, ['messaging.destination', 'messaging.destination.name']);
  if (topic) {
    return {
      kind: 'topic',
      topic,
      contractId: `topic::${topic}`,
      hops: ['topic'],
      errorEvent,
    };
  }

  // ─── 4. code.* 直接 Method 反查 ─────────────────────────────────────
  const codeFn = pick<string>(flat, ['code.function']);
  const codeFile = pick<string>(flat, ['code.filepath', 'code.file.path']);
  if (codeFn || codeFile) {
    return {
      kind: 'code',
      codeFunction: codeFn,
      codeFilePath: codeFile,
      hops: ['code'],
      errorEvent,
    };
  }

  // ─── 5. stacktrace 顶帧反查 (独有路径) ──────────────────────────────
  if (errorEvent?.topFrame) {
    return {
      kind: 'code',
      codeFunction: errorEvent.topFrame.classMethod,
      codeFilePath: errorEvent.topFrame.file,
      hops: ['stacktrace'],
      errorEvent,
    };
  }

  // ─── 6. 全空 ────────────────────────────────────────────────────────
  return { kind: 'unknown', hops: ['unknown'], errorEvent };
}
