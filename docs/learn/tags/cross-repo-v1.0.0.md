# cross-repo/v1.0.0（2026-04-29）

> Tag: `cross-repo/v1.0.0`，commit `ac9b771f`
> 分支: `feat/agentic-devops-cross-repo`

## 目标

把"线上出错 → 自动开 PR 修复"的 7 阶段闭环**首次扩到跨仓**：cses-java consumer 调 mattermost provider 的 csesapi 契约出错，pipeline 不仅能在 cses-java 仓里反查 caller 改 cses 端，还能在 mattermost partner 仓里找 provider handler、列嫌疑 commit、给两端候选根因。

## 关键改动

| 改动 | 文件 |
|---|---|
| `mcp-bridge.ts` 新增 DIY 跨仓 bridge (替代 lbug group sync 因 Intel Mac 缺 prebuilt) | `gitnexus/scripts/mcp-bridge.ts` (~250 行) |
| `crossBlastRadius(contractId, primaryRepo, partnerRepos)` 算 partner 仓 provider | 同上 |
| `parseContractId` + `deriveHandlerNameCandidates` + `safeNameEqualsClause` (KuzuDB read-only-guard 绕开) | 同上 |
| Orchestrator S3 串 crossLinks → S4 forensics 也对 partner 仓 git log | `orchestrator.ts` |
| `OrchestratorDeps` 加 `crossBlastRadius` 字段（不破坏对称）| `pipeline/types.ts` |

## 6 demo 真 evidence

| iid | trace 性质 | MR | 验证点 |
|---|---|---|---|
| #26 | 跨仓首次显示 ContractLink，LLM 触 budget abort | !31 | 跨仓 link 命中 |
| #27 | LLM 正确 abort 防硬塞 | !32 | safety guardrail |
| #28 | (无 MR — R-12 政策拒 638 行 patch >500) | — | policy 闸 |
| #29 ⭐ | LLM 真改 createPosts JsonObject→void 对齐 mattermost | !33 | 跨仓 MVP 首次达成 |
| #30 ⭐ | 单仓回归 PASS | !34 | 跨仓不破坏单仓 |
| #31 ⭐ | 二次跨仓 demo + **P2.3 partner suspects 真显示首发** | !35 | 跨仓 forensics 真出 commit Top 3 |

## 落地差异（vs §15.5 草案）

1. eval-server 实际 API 是 `POST /tool/{cypher,impact,context,query}` + `GET /health`（不是 `/api/impact`）
2. 响应是 `{json}\n---\nNext:` 拼接体，bridge 必须切 `\n---\n` 才能 `JSON.parse`
3. `/tool/impact` 在 1.4.1 有 crash bug；改用 `/tool/cypher` 走 `MATCH (m:Method {name})<-[*1..N]-(caller)` 自己算 blast radius
4. cses-java 1.4.1 schema 没 `Route` 节点；草案 `MATCH (rt:Route)-[:HANDLES_ROUTE]-(m:Method)` 跑不通；改用 `Method.name + filePath/className` 三层 fallback
5. Method id 真格式：`Method:<filePath>:<name>:<startLine>`（不是 UID 风格 `Method:Symbol_xxx`）
6. KuzuDB 1.4.1 read-only-guard bug — 字面量含 `create`/`delete`/`merge` 关键字会被误拦；用 STARTS WITH/ENDS WITH 拆开绕

## 仓内基础设施

```
GITNEXUS_BRIDGE_REPO_MAP={"cses/java/cses/cses":"cses-java","cses/go/mattermost":"mattermost"}
GITNEXUS_AUTOPR_TOKEN_MAP={...rotated...}
GITNEXUS_CROSS_REPO_PARTNERS={"cses-java":["mattermost"],"mattermost":["cses-java"]}
GITNEXUS_AUTOPR_LIVE=1 GITNEXUS_PROVIDER=gitlab
```

## 已知遗留（解决于本轮 observe-pipeline-integration）

- ✅ mattermost issue S2 fallback 到 `src/main/java/Unknown.java` (Java/Go 错位) — D 修
- ✅ S5 给 Go 仓产 `Test_xxx.java` — da530cfd 修
- ✅ resolveSpan 凑假 UID 污染下游 — E-deep 修
- ❌ eval-server 不稳定 — 待 watchdog 方案
