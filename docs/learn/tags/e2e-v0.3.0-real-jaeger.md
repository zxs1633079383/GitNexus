# e2e/v0.3.0-real-jaeger（2026-04-29）

> Tag: `e2e/v0.3.0-real-jaeger`
> 真 Jaeger 拉 trace + Phase 0 normalizer 真接

## 目标

把 mvp/v1.0.0 的 normalizer 8 fixtures 单测能力接到**线上真 Jaeger trace**，让 webhook 不靠用户手工传 spans 数组，自动从 traceUrl 拉 8 spans。

## 一行配置启用

```bash
export JAEGER_QUERY_BASE=http://192.168.6.66:32281
```

issue body 给 `traceUrl`（不必嵌 spans），pipeline 自动 `GET /api/traces/<id>` 拉真 spans。

## Jaeger Query API 兼容性

`jaeger-fetcher.ts` 走 HTTP Query API：
- `GET /api/traces/<traceId>` → `{ data: [{ spans: [...] }] }`
- 兼容 Jaeger v1 / v2 (OTel collector distribution，jaeger_query 扩展)

## 真验证产物

| 项 | 值 |
|---|---|
| 拉的 trace | `291393efa15b1778` (mattermost) |
| 真 spans 数 | **8** |
| Phase 0 normalize 真产出 | `kind=http`, `contractId=http::POST::/api/cses/posts/create` |
| issue | http://git.yundiz.com/zhanglichao/devops-test-backend/-/issues/7 |
| comment | `#note_706` (评论里含完整 7 阶段 markdown 报告) |
| 端到端耗时 | 129.8s |

## 业务仓 GitNexus 索引前的限制

S2 normalize 真接，但 **handler UID 反查**仍兜底（用 contractId 当 UID）。
要让 S3-S5 真跑必须：

```bash
gitnexus analyze --url <业务仓>
```

让 GitNexus 索引业务仓代码后，`resolveSpanToHandler` 才能从 `Route` 节点反查到真实 `Method:XxxController.xxx` UID。
（cses-java 1.4.1 schema 没 Route 节点，最终走 mvp/v1.2.0-bridge 的 `Method.name + filePath` 三层 fallback。）

## 下一里程碑

- mvp/v1.2.0-bridge: HTTP 桥接 eval-server，真接 S3 cypher
- e2e/v0.4.0-live-bridge: 全链路 LIVE 三因子真发 MR
