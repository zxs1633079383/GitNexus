// query-only — must not be called from any pipeline phase
//
// Phase 0 / Stage 2 — Trace2Code Resolver
// 类型定义层。两种 span 容器 (Jaeger tags[] / OTel attrs{}) 在这里被
// 抽象成同一个 `SpanInput`；下游 normalizer 只看 NormalizedSpan。
//
// Roadmap §3.1 / RULES §0.4

/**
 * Jaeger Query API 的 tag 形态: `{key, value, type?}`。
 * value 可能是 string / number / boolean。
 */
export interface JaegerTag {
  key: string;
  value: unknown;
  type?: string;
}

/**
 * Jaeger log event (OTel exception event 也走这里)。
 */
export interface JaegerLog {
  timestamp?: number;
  fields: JaegerTag[];
}

/**
 * 一条 Jaeger 风格的 span。
 *
 * 顶层 `tags[]` 是 Jaeger 自家形态; `attributes{}` 是 OTel 直接序列化的
 * 形态 (`{ "http.route": "/x" }`)。两种都接受，由 detect 阶段扁平化成
 * 单一 KV map 后再走主链路。
 */
export interface JaegerSpan {
  traceID?: string;
  spanID?: string;
  operationName?: string;
  duration?: number;
  startTime?: number;
  tags?: JaegerTag[];
  logs?: JaegerLog[];
  // OTel JSON 直出形态
  attributes?: Record<string, unknown>;
  events?: Array<{
    name?: string;
    time?: string | number;
    attributes?: Record<string, unknown>;
  }>;
  process?: {
    serviceName?: string;
    tags?: JaegerTag[];
  };
}

/**
 * Stage 2 入口接受这种宽松 envelope:
 *  - 直接传一条 span
 *  - 或传 Jaeger Query API 完整 envelope: `{ data: [{ spans: [...] }] }`
 */
export type SpanInput = JaegerSpan | { data: Array<{ spans: JaegerSpan[] }> };

/**
 * 命中哪条 fallback 路径 (诊断用，让 caller 看到走的是 route / url.path /
 * stacktrace 还是其它)。
 */
export type FallbackHop =
  | 'http.route'
  | 'url.path'
  | 'url.full'
  | 'http.url'
  | 'http.target'
  | 'rpc'
  | 'topic'
  | 'code'
  | 'stacktrace'
  | 'unknown';

/**
 * Phase 0 主产物。Stage 4 (P5) 直接消费 `symbolUid` + `errorEvent`。
 *
 * - kind:        哪种入口 (http / grpc / topic / code / unknown)
 * - contractId:  GitNexus contract registry 的 id, 用来反查 Route 节点
 * - symbolUid:   handler 的 GitNexus symbol UID (尚未反查时为 undefined)
 * - hops:        命中的 fallback 链 (按命中顺序)
 * - errorEvent:  顶帧 stacktrace + exception 元信息 (仅当 span 失败时填)
 */
export interface NormalizedSpan {
  kind: 'http' | 'grpc' | 'topic' | 'code' | 'unknown';
  contractId?: string;
  symbolUid?: string;
  method?: string;
  path?: string;
  service?: string;
  topic?: string;
  hops: FallbackHop[];
  errorEvent?: {
    type?: string;
    message?: string;
    topFrame?: {
      file: string;
      classMethod: string;
      line: number;
    };
  };
  // 透传给 caller 用于查图的辅助字段
  codeFunction?: string;
  codeFilePath?: string;
}

/**
 * resolveSpanToHandler 输出 —— Stage 4 的输入。
 */
export interface ResolveOutcome {
  kind: NormalizedSpan['kind'];
  contractId?: string;
  symbolUid?: string;
  hops: FallbackHop[];
  resolvedBy: 'route-lookup' | 'stacktrace' | 'code-attr' | 'none';
  errorEvent?: NormalizedSpan['errorEvent'];
}
