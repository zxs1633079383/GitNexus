// Jaeger Query API 客户端
//
// 当 issue body 的 metadata 块**没传 spans 但给了 traceUrl** 时，
// 我们用本模块根据 traceId 从 Jaeger Query API 拉 spans。
//
// Jaeger Query HTTP API:
//   GET /api/traces/{traceId}      返回 { data: [{ spans: [...], processes: {...} }] }
//
// Jaeger v1 / v2 (OpenTelemetry distribution) 都兼容此 endpoint
// （v2 内部 jaeger_query 扩展暴露同名路径）

import type { JaegerSpan } from './jaeger-span-types.js';

export interface JaegerFetcherOptions {
  /** Jaeger query base URL，如 http://192.168.6.66:32281。 */
  baseUrl: string;
  /** 可选 timeout（毫秒）。默认 10s。 */
  timeoutMs?: number;
  /** 可选 token / 自定义 headers（OAuth bearer 之类）。 */
  headers?: Record<string, string>;
}

export interface FetchTraceResult {
  ok: boolean;
  spans?: JaegerSpan[];
  /** trace 中的 process 信息（serviceName 等），caller 一般不需要 */
  processes?: Record<string, { serviceName: string; tags?: any[] }>;
  /** 失败时填 */
  error?: string;
}

/** 从 traceUrl 中抠 traceId（兼容 /trace/<id> / /trace/<id>?... / 直接是 id 的形式）。 */
export function extractTraceId(traceUrlOrId: string): string | null {
  if (!traceUrlOrId) return null;
  // 直接是 hex id（无斜杠、无协议）
  if (/^[a-f0-9]{16,32}$/i.test(traceUrlOrId)) return traceUrlOrId;
  const m =
    traceUrlOrId.match(/\/trace\/([a-f0-9]+)/i) ??
    traceUrlOrId.match(/[?&]traceID=([a-f0-9]+)/i);
  return m ? m[1] : null;
}

/**
 * 从 Jaeger Query API 拉 trace。
 *
 * @returns { ok: true, spans } 成功 / { ok: false, error } 失败
 *          失败时 caller 应该 fallback 到 issue body 里的 spans 字段
 *          （或者放弃 S2-S5，直接 S6/S7 dryRun）
 */
export async function fetchTraceFromJaeger(
  traceUrlOrId: string,
  opts: JaegerFetcherOptions,
): Promise<FetchTraceResult> {
  const traceId = extractTraceId(traceUrlOrId);
  if (!traceId) return { ok: false, error: `cannot extract traceId from "${traceUrlOrId}"` };

  const url = `${opts.baseUrl.replace(/\/$/, '')}/api/traces/${traceId}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(opts.headers ?? {}),
      },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = (await r.text()).slice(0, 500);
      return { ok: false, error: `jaeger query ${r.status}: ${text}` };
    }
    const j = (await r.json()) as any;
    const trace = (j?.data ?? [])[0];
    if (!trace) return { ok: false, error: 'jaeger returned empty data array' };
    const spans: JaegerSpan[] = trace.spans ?? [];
    if (spans.length === 0) return { ok: false, error: 'trace has 0 spans' };
    return {
      ok: true,
      spans,
      processes: trace.processes ?? {},
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析 GitNexus metadata block 时调用：
 *   - 若 block.spans 已给 → 直接用
 *   - 若 block.spans 缺但 block.traceUrl 给了 + JAEGER_QUERY_BASE 配了 → 真拉
 *   - 否则返回 null（caller 应记 reason 跳过 pipeline）
 */
export async function resolveSpansFromBlock(
  block: { spans?: JaegerSpan[]; traceUrl?: string },
  opts?: { jaegerBaseUrl?: string; timeoutMs?: number },
): Promise<{ spans: JaegerSpan[]; source: 'metadata' | 'jaeger' } | null> {
  if (Array.isArray(block.spans) && block.spans.length > 0) {
    return { spans: block.spans, source: 'metadata' };
  }
  if (block.traceUrl && opts?.jaegerBaseUrl) {
    const r = await fetchTraceFromJaeger(block.traceUrl, {
      baseUrl: opts.jaegerBaseUrl,
      timeoutMs: opts.timeoutMs,
    });
    if (r.ok && r.spans) return { spans: r.spans, source: 'jaeger' };
  }
  return null;
}
