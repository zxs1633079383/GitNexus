# /Observe → Pipeline 无缝集成（2026-04-30）

> 本轮没打 tag，下次稳定后建议打 `observe-pipeline/v1.0.0`。
> 4 个 commit 在 `feat/agentic-devops-cross-repo` 分支：`9905147b → 589ef237 → da530cfd → 5ef03b8b`。

## 目标

- /Observe skill 生成的 issue 能可靠触发 GitNexus pipeline 全 7 阶段
- 真 Jaeger trace（不靠手工塞 stacktrace）能反查到真 handler
- mattermost (Go) 仓不再挂 Java 错位测试 / Java 错位 fallback UID
- S2 报告只显示真 handler，子 span 透明可审计

## 4 个 commit 内容

### 1. `9905147b` · D + E + E-deep — 消除 Unknown 错位输出

| 改动 | 文件 | 行数 |
|---|---|---|
| **D** · `resolveHandler` 加 Function 标签查询 | `gitnexus/scripts/mcp-bridge.ts` | +6 |
| **E-deep** · `resolveSpan` 子 span 不再凑假 fallbackUid | `gitnexus/scripts/start-webhook-server.ts` | +5 −3 |
| **E** · orchestrator 加 `isFallbackUid` 护栏 filter S5 前 | `gitnexus/src/core/pipeline/orchestrator.ts` | +20 |

根因：
- mattermost Go handler 在 KuzuDB 是 `Function` 节点（例 `Function:server/channels/csesapi/posts.go:createPosts:271`），但 `resolveHandler` 只 `MATCH (m:Method)` 必 0 行返回 → fallback 到 `src/main/java/Unknown.java` 形成 Java/Go 错位
- 同文件 `crossBlastRadius` 已经做对双 label 查询；这次只是把 `resolveHandler` 对齐
- 旧 `resolveSpan` 容错过度凑 `Method:Unknown_xxx`，污染 S3/S5 → 改返 `resolved:false`

### 2. `589ef237` · B-strong + tier-3 fuzzy

| 改动 | 文件 | 行数 |
|---|---|---|
| 抽出 `resolveHandlerByContract(contractId, repo)` 共享算法 | `gitnexus/scripts/mcp-bridge.ts` | +180 |
| `resolveSpan` 弱 candidates miss 后调强反查 | `gitnexus/scripts/start-webhook-server.ts` | +30 |
| `parseMethodId` 扩展接受 Function label | `gitnexus/scripts/mcp-bridge.ts` | regex 改一行 |

根因：
- 弱 candidates `[stackMethod, codeName, contractMethod]` 中 `contractMethod` 仅取 path 末段（"getschedule"），无法命中真 handler "getScheduledPost"
- 复用 `crossBlastRadius` 已经验证的多形态名字候选 + 双 label + 评分算法
- 新增 tier-3 模糊：`lower(name) STARTS WITH lower(末段)` 解决 `normalizeConsumerPath` lowercase 后 candidates 丢失 camelCase 信息的问题
- `parseMethodId` 旧 regex 只匹配 `^Method:` → S3/S5 拿到 `Function:...` UID 解析失败回 fallback

### 3. `da530cfd` · S5 lang-aware skip

| 改动 | 文件 | 行数 |
|---|---|---|
| S5 前按 handler filePath 后缀决策 | `gitnexus/src/core/pipeline/orchestrator.ts` | +20 |

根因：
- R-1 scaffold 模板硬编码 Java 风格 (`Test_xxx.java` + JUnit)
- 之前 mattermost 仓 issue 拿到 `Function:.go` handler 时 S5 仍照模板出 `Test_getScheduledPost.java` 挂在 Go 仓上 — 新错位
- 修复：`!filePath.endsWith('.java')` → S5 skip with reason

### 4. `5ef03b8b` · S2 报告只显示真 handler

| 改动 | 文件 | 行数 |
|---|---|---|
| `issue-handler.ts` S2 渲染前过滤 + 加统计行 | `gitnexus/src/core/observability/issue-handler.ts` | +24 −8 |

根因：
- E-deep 后 resolveSpan 对子 span 返 `resolved:false`，但渲染层还是把所有 r.output 列出来 → 一堆 `(unknown)` 占位
- 改：先过滤 `resolved:true` 才进列表；统计行写明"共 N 条 spans, 真接到 handler M 条, K 条非 handler span 省略"

## 真 trace 验证 evidence

### 单向 / 双向 / 批量全跑

| issue | trace | side | S2 命中 | cross-link | S7 |
|---|---|---|---|---|---|
| cses #34 | `4e5ce407` POST /doc/document/view | java handler | ✓ View.java:view:28 | (单仓) | ✅ MR !36 |
| mattermost #11 | `3b637277` POST /api/cses/posts/getSchedule | go handler | ✓ Function:posts.go:getScheduledPost:411 | — | ✅ MR !7 (S5 skipped, 不产 .java) |
| cses #35 | `0b63c667` POST /api/cses/posts/create | consumer | ✓ IMService:createPost:32 | ✓ mattermost→posts.go:393 conf=0.70 | ✅ MR !37 |
| mattermost #12 | 同 trace | provider | ✓ Function:posts.go:createPost:393 | ✓ cses-java→orient.py conf=0.40（假阳性，已知）| ✅ MR !8 |
| cses #36 | 同 trace | clean S2 | "共 9 条 spans, 真接 1 条, 8 条非 handler 省略" | ✓ | ✅ MR !38 |

### 批量 batch (4 trace × 2 dir = 8 issue)

| trace | path | cses S2 | mm S2 | cross-link | 备注 |
|---|---|---|---|---|---|
| `72f468aa` | channel/create | ✓ IMService:createChannel:28 | ✓ api4/channel.go:203 | ✓ conf=0.70（命中 api4 而非 csesapi）| 选优先级有 P1 |
| `3b380dbd` | channel/member/change | ✓ guide service | ✗ | ✗ | 末段 `change` 太通用 |
| `7a7961a7` | posts/getUpdatedPosts | ✗ | ✗ | ✗ | mm 真名 `queryUpdatedPosts`，前缀差异 |
| `08b68b76` | channels/load/increment | ✓ doc service | ✗ | ✗ | 末段 `increment` 太通用 |

batch 间发现 **P0**：eval-server 进程死了导致**第一轮 8 个 issue 全 0 cross-link**，重启后同 trace 立刻命中。

## 已知 backlog

| 等级 | 问题 | 修法 |
|---|---|---|
| **P0** | eval-server 进程不稳定，反复异常退出 | watchdog (cron / launchd / pm2) — 见 [eval-server-stability-analysis](./eval-server-stability-analysis.md) |
| **P1** | bridge 选 handler 优先级不对（IMService.createChannel vs MattermostClient.createChannel；api4/channel.go vs csesapi/channel.go）| `crossBlastRadius` 评分加 `filePath CONTAINS "csesapi"/"client"` 权重 |
| **P2** | 命名差异 candidates 命中不到（`getXxx` vs `queryXxx`；末段 `change`/`increment` 太通用）| 加语义 alias 词典或 grep csesapi 文件源码 fallback |
| **P3** | R-1 scaffold 仅 Java，Go/TS/Rust 仓 S5 永远 skip | 接 Go testgen 模板 |
| **P4** | normalizeConsumerPath 把 path lowercase → tier-3 才能补，能否保留 camelCase？ | 看 http-route-extractor.ts 改 normalize 策略 |

## 累计 issue/MR 表

| 仓 | issue 范围 | MR 范围 |
|---|---|---|
| cses-java | #32~#45 (新 14 条) | !36~!38 (新 3 条) |
| mattermost | #5~#21 (新 17 条) | !6~!8 (新 3 条 — mattermost 仓首次真发) |

## 与上一个里程碑 cross-repo/v1.0.0 的对比

| 维度 | cross-repo/v1.0.0 | 本轮 |
|---|---|---|
| 真接 handler | 仅 cses-java 用合成 stacktrace | cses-java + mattermost 真 Jaeger trace 都接 |
| 跨仓 link | 仅手工合成 spans 触发 | 真 Jaeger contractId 触发 |
| Go 仓 MR | 0 个 | 3 个 (!6/!7/!8) |
| 错位输出 | mattermost issue 挂 Java 路径 | 全消除 |
| S2 报告 | unknown 占位混杂 | 干净，统计行透明 |
| /Observe skill | 概念上能用 | 实测无缝集成 (4 trace × 2 dir batch) |

下一步：等 eval-server 守护方案落地，跑 LIVE 全自动巡检。
