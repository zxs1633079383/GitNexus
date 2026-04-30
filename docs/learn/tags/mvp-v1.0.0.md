# mvp/v1.0.0（2026-04-28）

> Tag: `mvp/v1.0.0`
> 第一刀 — Phase 0 Trace2Code Resolver + S2-S7 mock 走通骨架

## 目标

把零散资产（/observe + Jaeger/Prom + GitNexus OSS + git + K8s + GitHub/GitLab）串成**第一条可跑的 7 阶段 mock 链**，证明架构 IO 可对接。

## 关键改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `gitnexus/src/core/observability/jaeger-span-normalizer.ts` | 🆕 ~80 行 | 双格式 detect + 5 层 HTTP fallback |
| `jaeger-span-types.ts` | 🆕 ~60 行 | `SpanInput` / `NormalizedSpan` / `FallbackHop` |
| `stacktrace-parser.ts` | 🆕 ~60 行 | OTel exception 顶帧 → (file, class.method, line) |
| `mcp/local/local-backend.ts` | 🔧 +50 | 加 `resolveSpanToHandler` |
| `mcp/tools.ts` | 🔧 +30 | 加 `resolve_span` MCP 工具 + 拓展 `api_impact` |
| `test/observability/jaeger-span-normalizer.test.ts` | 🆕 ~250 行 | 8 fixtures 单测 |

## 8 fixtures 单测

| # | 输入特征 | 期望输出 |
|---|---|---|
| 1 | 真实 trace JSON（`/tmp/jaeger-trace.json` pre 环境）| `Method:.../TaskMemberReader.java:loadSnapshot#1` |
| 2 | 旧 conv `http.url` | `http::POST::/api/cses/posts/create` |
| 3 | 新 conv `url.path` | `http::POST::/Collaborate/loadWorkOrientForMember` |
| 4 | 裸数字 `/api/users/12345` | 归一为 `/api/users/{param}` |
| 5 | gRPC `rpc.service` + `rpc.method` | `grpc::package.service/method` |
| 6 | Topic `messaging.destination` | `topic::order.created` |
| 7 | 仅 `code.function + code.filepath` | Method 直查命中 |
| 8 | 全空 attribute | `kind: 'unknown'` |

## 关键修正点

- **Bug-1**: 用 `normalizeConsumerPath`（http-route-extractor.ts:78），**不**用 `normalizeHttpPath`，防裸数字路径 `/api/users/123`
- **R-6**: 文件头加 `// query-only — must not be called from any pipeline phase`；CI lint 规则禁止从 `core/ingestion/**` import `core/observability/**`
- **Fix-9**: 被动推模式（caller POST span 数组），不主动拉 Jaeger（这条到 e2e/v0.3.0-real-jaeger 才放开）

## 当时的 mock deps（典型骨架）

```
mock resolveSpan: 返假 contractId + 假 Method UID
mock apiBlastRadius: 返 5 个假文件
mock regressionForensics: 返空 suspects
mock genE2ETests: 返 scaffold 文件名（不真生成）
mock validateInPreview: 直接返 pass
mock autoPR: dryRun，不真调 GitLab/GitHub API
```

## 下一里程碑

- single-repo/v1.0.1: 接真 K8s S6
- single-repo/v1.0.2: 接真 GitLab S7 + R-12 policy
- single-repo/v1.0.3: 接真 normalizer S2
- single-repo/v1.0.4: 全链路 LIVE 真闭环
