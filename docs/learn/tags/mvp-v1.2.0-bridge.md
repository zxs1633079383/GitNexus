# mvp/v1.2.0-bridge（2026-04-29）

> Tag: `mvp/v1.2.0-bridge` + `mvp/v1.2.0-bridge.1`
> 把 webhook server 的 mock S2/S3/S4 替换成真索引数据

## 目标

全局 `gitnexus` 1.4.1 (KuzuDB) 已索引 cses-java (65k nodes) + mattermost (46k nodes)，
但本仓 src tree (lbug) 跟全局 schema 不通，webhook server 拿不到这份索引。
当前 webhook server 在 S3-S5 返回 mock 数据。

→ 通过 HTTP 桥接全局 `gitnexus eval-server` (port 4848)，让 S2/S3 走真 cypher。

## 桥接架构

```
webhook server (本仓 lbug, port 3034)
   │ S2 resolveSpan / S3 apiBlastRadius / S4 forensics
   ▼ HTTP fetch
gitnexus eval-server (全局 1.4.1, port 4848)
   ▼
KuzuDB 真索引 (cses-java / mattermost / ...)
```

## 关键改动

| 文件 | 内容 |
|---|---|
| `gitnexus/scripts/mcp-bridge.ts` | 🆕 ~250 行 HTTP 桥接 + cypher 三层 fallback resolveHandler |
| `gitnexus/scripts/start-webhook-server.ts` | 改 deps 注入：mock → bridge.resolveHandler / blastRadius |
| `gitnexus/scripts/smoke-bridge.ts` | 🆕 不依赖 webhook 的桥接 smoke 测试 |

## 落地差异（vs 草案）

1. eval-server 实际 API 是 `POST /tool/{cypher,impact,context,query}` + `GET /health`
2. 响应是 `{json}\n---\nNext:` 拼接体，bridge 必须切 `\n---\n` 才能 `JSON.parse`
3. `/tool/impact` 在 1.4.1 有 crash bug；改用 `/tool/cypher` 自己走 `MATCH (m:Method {name})<-[*1..N]-(caller)`
4. cses-java 1.4.1 schema 没 `Route` 节点；草案 `MATCH (rt:Route)-[:HANDLES_ROUTE]-(m:Method)` 跑不通；改用 `Method.name + filePath/className` 三层 fallback
5. Method id 真格式：`Method:<filePath>:<name>:<startLine>`

## 真验证

`scripts/smoke-bridge.ts` 命中 fixture #1：
- 输入：trace `a9a3a507a29c7706cfc6f3ad1f454d40`
- 输出：真 `TaskMemberReader.java:93` + 25 个真业务 caller 文件
- 之前 mock 是 5 个假文件
- 之后 webhook server S3 报告里全是真文件路径

## KuzuDB 1.4.1 read-only 守卫 bug

字符串字面量含写操作关键字 (`create`/`delete`/`merge`/`drop`/`alter`/`copy`/`detach`) 会被误拦。
解：`safeNameEqualsClause(name, alias)` —— 含 guard 关键字时拆 STARTS WITH + ENDS WITH 字符串绕开。

## 下一里程碑

- mvp/v1.3.0-llm-patch: 接 `claude -p` 真 LLM
- e2e/v0.4.0-live-bridge: LIVE 三因子全开 + 真发 MR
- cross-repo/v1.0.0: 跨仓 ContractLink + crossBlastRadius
