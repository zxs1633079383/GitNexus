# GitNexus × Agentic DevOps —— 企业版剩余功能路线图 v2

> 作者：GitNexus 核心维护者视角
> 日期：2026-04-28
> 状态：**review 通过**（gitnexus-knowledge 事实校对 + gitnexus-dev 独立评审，2 处硬 bug + 4 处细节修正已合入）
> 上一版：`docs/learn/PR-Review-Bot-方案.md`（2026-04-26，P0 PR Review Bot 已上线）

---

## 0. 全局 Goal —— 这件事到底为什么做

### 0.1 一句话目标

> **把整个研发生命周期，从"人驱动的流程"翻译成"Agent 可执行的协议"。**

GitNexus 在这个目标里扮演**确定性知识基础设施**——给 Agent 提供"代码的真相"，是闭环里**唯一不靠 LLM 的层**。Synapse 的编排会抖动，TraceWeaver 的观测会缺失，但 GitNexus 给的"X 改动会影响 Y"是**索引时算好的事实**，可以被 Agent 当作硬约束信任。

### 0.2 Agentic DevOps 闭环（六动词 → 进化）

```
                  ┌─ Synapse ────────────────────┐  编排 + 调度
                  │ brainstorm → plan → exec     │
                  │   → review → ship            │
                  └──────────┬───────────────────┘
                             │ 用 ↓ 拿"代码真相"
              ┌──────────────┴──────────────┐
              │  GitNexus（知识基础设施）     │  跨仓真相 + 影响半径
              │  · 32 节点表知识图           │  → 给 Agent 喂"结构化记忆"
              │  · 跨仓 contract registry    │     而非 RAG 概率匹配
              │  · impact / api_impact       │
              └──────────────┬──────────────┘
                             │ 反喂 trace
              ┌──────────────┴──────────────┐
              │  Jaeger + OTel（观测层）     │  观测 + 反馈
              │  · OTel auto-instrument      │  → 喂回 Trace2Skill 蒸馏
              │  · Jaeger Query API          │
              └─────────────────────────────┘
```

**六动词**：调度 / 编排 / 观测 / 约束 / 反馈 / 愿景 → **进化**

### 0.3 用户描绘的 ideal state

> 巡检发现 error / 高响应时间 → 跨仓分析 → 对应 TestCase / 测试集合

具体到 GitNexus 能力：

| 闭环步骤 | 落地功能 | 当前状态 |
|---|---|---|
| 巡检发现 error（Jaeger 已能做） | OTel auto-instrument + Jaeger Query API | ✅ 已有（业务零侵入） |
| Trace span → handler symbol UID | **Phase 0 Jaeger Span Normalizer** | 🟡 本路线图新增 |
| 自动定位"哪个 commit / 哪条调用路径感染" | **P5 Auto Regression Forensics** | 🟡 本路线图核心 |
| 跨多个仓追踪传染源（不止 1 跳） | **P2 Multi-hop crossDepth>1** | 🟡 并行线 |
| 触发 → 自动重织受影响仓的图 | **P1 Auto-reindex Webhook** | 🟡 关键路径 |
| 拿到调用链 → 生成对应 TestCase | **P4 E2E Test Generation** | 🟡 并行线 |

---

## 1. 现状（2026-04-28）

| 功能 | Pri | 状态 | 备注 |
|---|---|---|---|
| **PR Review Bot** | P0 | ✅ 已上线 | 含 `crossDepth=1` 跨仓影响分析；GitHub App `gitnexus-pr-reviewer-zxs` 已发布 |
| Auto-reindex Webhook | P1 | 🟡 未做 | 关键路径 |
| Auto Regression Forensics | P5 | 🟡 未做 | 关键路径核心 |
| Multi-hop crossDepth>1 | P2 | 🟡 未做 | 并行线（不阻塞 P5） |
| Auto Wiki 刷新 | P3 | 🟡 未做 | 顺手挂 P1 |
| E2E Test Generation | P4 | 🟡 未做 | 并行线 |
| OCaml LanguageProvider | P6 | 🟡 未做 | 并行线 |

---

## 2. 路线图 v2（按 Agentic DevOps 闭环优先重排）

### 2.1 关键路径 vs 并行线

```
═══════════════════════════════════════════════════════════════
关键路径（串行，3.5 周闭环跑通）：
═══════════════════════════════════════════════════════════════

Phase 0  Jaeger Span Normalizer（1 周）
   │
   ▼
P1  Auto-reindex Webhook（1 周）
   │
   ├──► P3 Auto Wiki 顺手挂同 webhook（半周）
   │
   ▼
P5  Auto Regression Forensics（1 周）

═══════════════════════════════════════════════════════════════
并行线（互不阻塞，1.5-2 周）：
═══════════════════════════════════════════════════════════════

P2  Multi-hop crossDepth>1（1.5 周）
P4  E2E Test Gen 选 B 外挂（1.5 周）
P6  OCaml LanguageProvider（2 周）

═══════════════════════════════════════════════════════════════
总工期：单人 5.5 周 / 双人 3.5 周
═══════════════════════════════════════════════════════════════
```

### 2.2 关键修正点（v1 → v2）

review 抓出 **2 处硬 bug + 4 处细节**，已经全部合入：

| 编号 | 严重度 | v1 错误 | v2 修正 | 源码锚点 |
|---|---|---|---|---|
| Bug-1 | 中（防御） | Phase 0 用 `normalizeHttpPath` 查 Route，**只折叠 `:id`/`{id}`/`[id]`，不识别裸数字段** | 改用 `normalizeConsumerPath`，把 `/api/users/123 → /api/users/{param}`；lookup 加置信度排序（exact > consumer-normalized） | `gitnexus/src/core/group/extractors/http-route-extractor.ts:61,78` |
| Bug-2 | 高 | P5 排在 P2 后，等 multi-hop 完成 | **P5 不阻塞 P2**：crossDepth=1 大多数场景够用，P2 后续增强深度而非门槛 | — |
| Fix-1 | 高 | P5 `suspects = detect_changes ∩ (upstream ∪ downstream)` 太宽（同期 unrelated 变更全误归） | 加**文件路径过滤**：只交叉 handler symbol 所在文件的直接改动 | `regression-forensics.ts`（新建） |
| Fix-2 | 中 | `detect_changes` 不返回 commit timestamp，"时间近度"排序无据 | forensics 层自跑 `git log --format="%H %at"`，不改 `detect_changes` 接口 | — |
| Fix-3 | 中 | P1 `job-queue` 没去重，force-push 20 次会打满 worker pool | 同 repo 入队去重：pending job 列表已有同 repo → 丢弃新 job | `server/job-queue.ts`（新建） |
| Fix-4 | 中 | P2 `mergeRisk(localRisk, cross)` 不接受 depth；`cross.length>=3 → CRITICAL` 在多跳后假性触发 | 改签名加 `maxCrossDepth`，深度衰减 `0.85^depth`；只对 depth=1 保留原阈值 | `gitnexus/src/core/group/cross-impact.ts:253` |
| Fix-5 | 中 | P2 `closeBridgeDb` finally 只关本地，多跳打开多个 group bridge 会泄漏句柄 | 每个 bridge handle 进 finally 关 | `gitnexus/src/core/group/cross-impact.ts:519` |
| Fix-6 | 中 | P6 `importSemantics: 'wildcard-leaf'` 一刀切，OCaml `open` vs `include` 语义不同 | 在 `ocaml.ts:resolveImport` hook 区分 AST：`open` → `wildcard-leaf`；`include` → `wildcard-transitive`（参考 `c-cpp.ts:324`） | — |
| Fix-7 | 中 | P6 直接进 `MIGRATED_LANGUAGES` 走 RFC #909 新路 | 走旧 DAG 路（不实现 `emitScopeCaptures`，不进 `MIGRATED_LANGUAGES`），等 grammar 成熟再迁移 | `gitnexus/src/scope-resolution/registry-primary-flag.ts:67` |
| Fix-8 | 低 | P4 BFS 没说防递归 | `process-traversal.ts` BFS 加 visited set | — |
| Fix-9 | 低 | P5 主动拉 Jaeger 假设过重 | 改**被动推**：caller POST span 数组进 MCP tool | — |

---

## 3. 各功能详细实现方案

### 3.1 Phase 0 · Jaeger Span Normalizer

**目标**：业务零侵入。Jaeger / OTel span JSON → handler symbol UID（GitNexus 内部反查 Route 节点 + stacktrace 兜底）。

**为什么必须独立**：它是 P5 的输入层，但同时也是未来所有"运行时信号 → 静态代码"桥梁的复用件。剥出来单测 + 单独发版，避免和 P5 业务逻辑耦合。

#### 文件清单

| 角色 | 文件 | 职责 | 新建/改/复用 |
|---|---|---|---|
| 入口归一器 | `gitnexus/src/core/observability/jaeger-span-normalizer.ts` | 双格式 detect + 扁平化 + 5 层 HTTP fallback | 🆕 新建 (~80) |
| Stacktrace 解析器 | `gitnexus/src/core/observability/stacktrace-parser.ts` | 解析 OTel exception event 顶帧 → `(file, class.method, line)` | 🆕 新建 (~60) |
| 类型定义 | `gitnexus/src/core/observability/jaeger-span-types.ts` | `SpanInput` / `NormalizedSpan` / `FallbackHop` | 🆕 新建 (~60) |
| 路径归一 | `gitnexus/src/core/group/extractors/http-route-extractor.ts:78` | `normalizeConsumerPath` 把数字段 → `{param}` | ♻️ 复用 |
| Symbol 反查 | `gitnexus/src/mcp/local/local-backend.ts` | 加 `resolveSpanToHandler`：1) Route 查 handler 2) stacktrace fallback | 🔧 +50 |
| MCP 工具 | `gitnexus/src/mcp/tools.ts` | 加 `resolve_span` + 拓展 `api_impact` 接受 `span` 参数 | 🔧 +30 |
| 测试 fixtures | `gitnexus/test/observability/jaeger-span-normalizer.test.ts` | 8 fixtures，**fixture #1 = 真实 trace**（见 §5） | 🆕 新建 (~250) |

#### 主链路（HTTP）

```ts
const method = pick(flat, ['http.request.method', 'http.method']) ?? 'GET';
const path = pick(flat, [
  'http.route',          // 框架模板，最准（你的 Micronaut trace 命中这层）
  'url.path',            // OTel ≥1.21 新 conv（你的 prod trace 命中）
  'url.full',            // OTel ≥1.21 全 URL，取 path
  'http.url',            // OTel ≤1.20 旧 conv
  'http.target'          // 老老 conv
]);

// 关键修正：用 normalizeConsumerPath 防御未来裸数字 ID
const contractId = `http::${method}::${normalizeConsumerPath(path)}`;
```

#### 多 fallback 链

| 优先级 | 路径 | 信号来源 |
|---|---|---|
| 1 | HTTP route → contractId → Route 节点 → handler | `http.route` / `url.path` 等 |
| 2 | gRPC → `grpc::svc/method` → Route 节点 | `rpc.service` + `rpc.method` |
| 3 | Topic → `topic::name` → Tool 节点 | `messaging.destination` |
| 4 | code.* 直接 Method 反查 | `code.function` + `code.filepath` |
| 5 | Stacktrace 顶帧反查（独有） | `exception.stacktrace` log event |
| — | 都未命中 | `kind: 'unknown'` |

### 3.2 P1 · Auto-reindex Webhook

**目标**：push / PR sync / merge → 自动重织受影响仓的图，给 P5 / Wiki / impact 查询提供 fresh data。

| 角色 | 文件 | 职责 | 状态 |
|---|---|---|---|
| Webhook 端点 | `gitnexus/src/server/webhook-server.ts` | GitHub App 验签 + 路由 | 🆕 (~200) |
| 任务队列 | `gitnexus/src/server/job-queue.ts` | 内存队列 + **同 repo 入队去重** | 🆕 (~150) |
| Analyze worker | `gitnexus/src/cli/analyze-worker.ts` | 拿任务跑 `gitnexus analyze` | ♻️ 已有 |
| Staleness 早退 | `gitnexus/src/core/git-staleness.ts` | HEAD 未变直接退出，幂等保险 | ♻️ 已有 |
| GitHub App | P0 PR Bot 已发的 App | 共用 App ID + private key（合并 push 权限） | ♻️ 复用 |
| CLI 命令 | `gitnexus/src/cli/serve.ts` | `gitnexus webhook serve --port 8080` | 🔧 加子命令 |

**并发安全性**：`lbug.lock` 单写者锁本来就保证多 push 串行；staleness 早退保证 no-op 安全。**真正风险是 force-push 风暴**——靠 job-queue 同 repo 去重防御。

### 3.3 P5 · Auto Regression Forensics

**目标**：caller 喂一条 / 一组失败 trace span，输出嫌疑提交清单（带 commit hash + 改了哪个 method + 距 trace 时间多久）。

| 角色 | 文件 | 职责 | 状态 |
|---|---|---|---|
| 取证主流程 | `gitnexus/src/core/observability/regression-forensics.ts` | 算法 + ranker | 🆕 (~150) |
| Span normalize | Phase 0 | trace span → handler symbol UID | ♻️ Phase 0 |
| 影响分析 | `gitnexus/src/mcp/local/local-backend.ts:impact()` | 反向 BFS | ♻️ 已有 |
| 改动检测 | `gitnexus/src/mcp/local/local-backend.ts:detect_changes` | HEAD~N..HEAD 变更符号 | ♻️ 已有 |
| Commit 时间戳 | forensics 内部 | 自跑 `git log --format="%H %at"` | 🆕 不改 detect_changes |
| MCP 工具 | `gitnexus/src/mcp/tools.ts` | `regression_forensics({spans, repo, lookback})` | 🔧 加工具 |

#### 算法（修正版）

```ts
async function regressionForensics(spans: NormalizedSpan[], opts) {
  const failedHandlers = spans
    .filter(s => s.errorEvent)         // OTel exception event 标记
    .map(s => s.symbolUid);

  const commitTimes = await loadCommitTimestamps(opts.lookback);  // git log 自跑
  const changes = await detectChanges(opts.lookback);

  const suspects: Suspect[] = [];
  for (const handler of failedHandlers) {
    const upstream = await impact(handler, 'upstream', { crossDepth: 1 });
    const downstream = await impact(handler, 'downstream', { crossDepth: 1 });
    const handlerFile = lookupFile(handler);

    // 关键修正：加文件路径过滤，只算 handler 所在文件的直接改动
    const filtered = changes.filter(c =>
      c.filePath === handlerFile ||
      [...upstream, ...downstream].some(n => n.uid === c.symbolUid)
    );

    for (const change of filtered) {
      suspects.push({
        commitHash: change.commitHash,
        symbolUid: change.symbolUid,
        confidence: change.confidence,
        timeAgoSec: nowSec() - commitTimes[change.commitHash],
      });
    }
  }

  // ranker: 时间近度 × confidence
  return suspects.sort((a, b) =>
    (b.confidence / Math.log(b.timeAgoSec + 2)) -
    (a.confidence / Math.log(a.timeAgoSec + 2))
  );
}
```

### 3.4 P2 · Multi-hop crossDepth>1

**目标**：A→B→C 多跳跨仓影响分析（超过当前 `MAX_SUPPORTED_CROSS_DEPTH=1` 硬上限）。

| 角色 | 文件 | 职责 | 状态 |
|---|---|---|---|
| 跨仓 BFS 引擎 | `gitnexus/src/core/group/cross-impact.ts:runGroupImpact` (l.304) | frontier queue + depth counter | 🔧 重写 (+200) |
| 去重 + cycle 检测 | 同上 | visited set key=`(repo, uid, contractId)` | 🔧 加 |
| 风险合并 | `gitnexus/src/core/group/cross-impact.ts:mergeRisk` (l.253) | 改签名 `(local, cross, maxDepth)`，**深度衰减 0.85^depth**；**仅 depth=1 保留 ≥3=CRITICAL 阈值**，depth=2 降 HIGH | 🔧 改 |
| 配置上限 | `gitnexus/src/core/group/cross-impact.ts:MAX_SUPPORTED_CROSS_DEPTH` | 1 → 配置可变（默认 3，硬上限 5） | 🔧 改 |
| Bridge 查询 | `gitnexus/src/core/group/cross-impact.ts:CY_NEIGHBORS_*` (l.34) | 多次调用串成多跳 | ♻️ 已有 |
| Deadline / fan-out 限制 | `runGroupImpact` | 每跳 timeoutMs，每层节点上限 | 🔧 加 |
| **句柄泄漏修复** | `gitnexus/src/core/group/cross-impact.ts:519` | 每个 bridge handle 进 finally | 🔧 改 |

### 3.5 P3 · Auto Wiki 刷新

**目标**：搭 P1 webhook 顺风车，push 事件触发 wiki 重生成。

| 角色 | 文件 | 职责 | 状态 |
|---|---|---|---|
| Webhook handler | `gitnexus/src/server/webhook-handlers/wiki-handler.ts` | push 事件触发 `gitnexus wiki` | 🆕 (~80) |
| Wiki 生成器 | `gitnexus/src/cli/wiki.ts` + `core/wiki/generator.ts` | 跑全套 wiki 流程 | ♻️ 已有 |
| 增量缓存 | `gitnexus/src/core/wiki/{vector-cache, llm-cache}.ts` | embedding 哈希复用 + LLM 调用缓存 | 🆕 加 |

### 3.6 P4 · E2E Test Generation（选 B：外挂模式）

**为什么选 B**：保 GitNexus "no LLM at index time" 的卖点。GitNexus 只输出**调用链 JSON**，caller（Claude / Cursor / 自家 LLM）自带 LLM 生 fixture 代码。

| 角色 | 文件 | 职责 | 状态 |
|---|---|---|---|
| Process 遍历 | `gitnexus/src/core/test-gen/process-traversal.ts` | 沿 STEP_IN_PROCESS 走调用链 → JSON，**BFS 加 visited set 防递归** | 🆕 (~120) |
| 入口节点查询 | LadybugDB | Process / Route / Tool 节点已索引 | ♻️ 已有 |
| Fixture 模板 | `gitnexus/src/core/test-gen/fixture-templates.ts` | 输出语言无关 JSON schema | 🆕 (~80) |
| MCP 工具 | `gitnexus/src/mcp/tools.ts` | `gen_test_chain({process_uid})` | 🔧 加工具 |

### 3.7 P6 · OCaml LanguageProvider

**走旧 DAG 路**——不进 `MIGRATED_LANGUAGES`，等 tree-sitter-ocaml grammar 对 functor / 一等模块支持成熟再迁 RFC #909 新路。

| 角色 | 文件 | 职责 | 状态 |
|---|---|---|---|
| 语言枚举 | `gitnexus-shared/src/languages.ts` | SupportedLanguages 加 `'ocaml'` | 🔧 改 |
| Provider 实现 | `gitnexus/src/core/ingestion/languages/ocaml.ts` | tree-sitter-ocaml + treeSitterQueries（统一 capture tag）+ mroStrategy: 'first-wins' | 🆕 (~300) |
| **Import 语义区分** | 同上 `resolveImport` hook | `open` → `wildcard-leaf`；`include` → `wildcard-transitive`（参考 `c-cpp.ts:324`） | 🆕 关键 |
| Import 配置 | `gitnexus/src/core/ingestion/import-resolvers/configs/ocaml.ts` | OCaml module path 解析 | 🆕 (~80) |
| Provider 注册 | `gitnexus/src/core/ingestion/languages/index.ts` | `satisfies` 编译期校验 | 🔧 +1 |
| 不进 RFC #909 | `gitnexus/src/scope-resolution/registry-primary-flag.ts:67` | `MIGRATED_LANGUAGES` 不动 | ♻️ 不动 |

---

## 4. 工时

| 阶段 | 周数 | 备注 |
|---|---|---|
| Phase 0 | 1 周 | 含 stacktrace 解析器 + 双归一函数 |
| P1 + P3 顺手 | 1.5 周 | webhook + queue + wiki handler |
| P5 | 1 周 | 不依赖 P2 |
| **关键路径小计** | **3.5 周** | 闭环跑通 |
| P2 / P4 / P6 并行 | 1.5-2 周 | 同期开三条独立分支 |
| **总工期** | **3.5 - 5.5 周** | 单人 / 双人节奏 |

---

## 5. Fixture / 验证方法

### 5.1 Phase 0 真实 trace fixture（金矿）

来源：`http://192.168.6.66:32281/trace/a9a3a507a29c7706cfc6f3ad1f454d40`（pre 环境，CSES 后端）

```json
{
  "operationName": "POST /taskManage/task/member/readTaskMemberState",
  "tags": [
    {"key": "otel.scope.name", "value": "io.micronaut.http.server"},
    {"key": "http.request.method", "value": "POST"},
    {"key": "http.response.status_code", "value": 400},
    {"key": "http.route", "value": "/taskManage/task/member/readTaskMemberState"},
    {"key": "url.path", "value": "/taskManage/task/member/readTaskMemberState"},
    {"key": "otel.status_code", "value": "ERROR"}
  ],
  "logs": [{
    "fields": [
      {"key": "event", "value": "exception"},
      {"key": "exception.message", "value": "Cannot invoke ... TaskEntity.getStatusId() because taskEntity is null"},
      {"key": "exception.stacktrace", "value": "java.lang.NullPointerException ... at TaskMemberReader.loadSnapshot(TaskMemberReader.java:96) ..."}
    ]
  }]
}
```

**这条 trace 同时验证**：
- 双格式容器（Jaeger tags 数组）
- OTel ≥1.21 新 conv（`http.request.method` / `url.path`）
- 框架模板（`http.route` 命中 fallback 第 1 层）
- Java/Micronaut 自动插桩（业务零侵入）
- OTel exception event（stacktrace 解析独有路径）

### 5.2 验证清单（Phase 0 ✅ → P5 ✅）

- [ ] Phase 0 fixture #1 = 上述 trace JSON，期望输出：
  - `kind: 'http'`
  - `contractId: 'http::POST::/taskManage/task/member/readTaskMemberState'`
  - `symbolUid` 命中 `Method:.../TaskMemberReader.java:TaskMemberReader.loadSnapshot#1`（stacktrace 顶帧反查）
- [ ] Phase 0 fixture #2 = `/User/login`（prod，无路径参数）→ `http::POST::/User/login`
- [ ] Phase 0 fixture #3 = `/api/users/12345`（构造）→ `normalizeConsumerPath` 归一为 `/api/users/{param}`
- [ ] Phase 0 fixture #4 = gRPC → `grpc::pkg.svc/method`
- [ ] Phase 0 fixture #5 = topic → `topic::order.created`
- [ ] Phase 0 fixture #6 = code.* 兜底
- [ ] Phase 0 fixture #7 = stacktrace 顶帧反查（同 fixture #1 但单独验证）
- [ ] Phase 0 fixture #8 = 全空 → `kind: 'unknown'`
- [ ] P5 端到端：fixture #1 → forensics → 嫌疑提交清单（手工注入一个改 `loadSnapshot` 的 commit）

---

## 6. 关键源码锚点

### 摄入层（OSS 已有，复用）

| 文件 | 关键位置 |
|---|---|
| `gitnexus/src/core/group/extractors/http-route-extractor.ts:61` | `normalizeHttpPath`（处理 `:id` / `{id}` / `[id]`） |
| `gitnexus/src/core/group/extractors/http-route-extractor.ts:78` | `normalizeConsumerPath`（**多一步：裸数字 → `{param}`**，Phase 0 用这个） |
| `gitnexus/src/core/ingestion/pipeline-phases/processes.ts` | Process / STEP_IN_PROCESS / ENTRY_POINT_OF（P4 复用） |
| `gitnexus/src/core/ingestion/languages/c-cpp.ts:324` | `wildcard-transitive` 实现（P6 OCaml `include` 参考） |
| `gitnexus/src/scope-resolution/registry-primary-flag.ts:67` | `MIGRATED_LANGUAGES = {'python'}`（P6 不进） |

### MCP 工具层（OSS 已有，扩展）

| 文件 | 关键位置 |
|---|---|
| `gitnexus/src/mcp/tools.ts:285` | `impact` JSONSchema |
| `gitnexus/src/mcp/local/local-backend.ts:153` | `IMPACT_RELATION_CONFIDENCE` 表 |
| `gitnexus/src/mcp/local/local-backend.ts:1410` | `resolveSymbolCandidates` |
| `gitnexus/src/mcp/local/local-backend.ts:2341` | `impact()` 入口（P5 复用） |
| `gitnexus/src/mcp/local/local-backend.ts:2865` | 四轴风险评级 |

### 跨仓层（P2 改）

| 文件 | 关键位置 |
|---|---|
| `gitnexus/src/core/group/cross-impact.ts:34` | `CY_NEIGHBORS_UPSTREAM` Cypher |
| `gitnexus/src/core/group/cross-impact.ts:253` | `mergeRisk` —— **P2 改签名 + 深度衰减** |
| `gitnexus/src/core/group/cross-impact.ts:304` | `runGroupImpact` —— **P2 改 frontier queue** |
| `gitnexus/src/core/group/cross-impact.ts:519` | `closeBridgeDb` finally —— **P2 修句柄泄漏** |
| `gitnexus/src/core/group/cross-impact.ts:MAX_SUPPORTED_CROSS_DEPTH` | 1 → 配置 |

### 命令行 / Worker（P1 复用）

| 文件 | 关键位置 |
|---|---|
| `gitnexus/src/cli/analyze-worker.ts` | analyze 任务执行单元 |
| `gitnexus/src/cli/analyze-job.ts` | 任务定义 |
| `gitnexus/src/core/run-analyze.ts` | 10 步 analyze 编排 |
| `gitnexus/src/core/git-staleness.ts` | HEAD == lastCommit → 早退 |

---

## 7. 启动决策

**建议第一步**：开 `feat/jaeger-span-normalizer` 子分支（基于本 docs 分支），单独发 Phase 0 PR。Phase 0 完成 → 在 P0 PR Bot 已经在生产的基础上，把"运行时信号 → 静态代码"的桥铺通，后续 P5 / P1 / P3 都吃这块基础设施。

**节奏选项**：

| 选项 | 描述 | 适合 |
|---|---|---|
| A. 串行最小路径 | Phase 0 → P1 → P5 一周一个 | 一人节奏，3.5 周交付闭环 |
| B. 双线并行 | A 路径不变 + 同时开 P2 / P6 副线 | 两人节奏，4-5 周交付全部 |
| C. 三线全开 | A 关键路径 + B（P2）+ C（P4 + P6） | 团队 3+ 人，3.5-4 周交付全部 |

---

## 8. 决策点（等用户拍板）

1. 选哪个节奏选项（A / B / C）？
2. Phase 0 PR 是否独立发版（推荐）还是和 P5 合并？
3. P3 Auto Wiki 是搭 P1 顺风（推荐）还是单独立项？
4. P6 OCaml 真实客户优先级？没有的话可放到本路线图最后一阶段。

---

## 附录 A · 评审过程

| 步骤 | 工具 | 结果 |
|---|---|---|
| 事实校对 | `gitnexus-knowledge` skill | `normalizeConsumerPath` 存在 / `MAX_SUPPORTED_CROSS_DEPTH=1` 现状确认 / `MIGRATED_LANGUAGES={'python'}` 现状确认 |
| 独立评审 | `gitnexus-dev` agent | 抓出 2 处硬 bug + 4 处中风险 + 多处低风险细节 |
| Trace 验证 | Jaeger Query API（pre 环境） | `a9a3a507a29c7706cfc6f3ad1f454d40` 拉回 17.8KB JSON，作为 fixture #1 |

## 附录 B · 上一版历史

- `docs/learn/PR-Review-Bot-方案.md`（v1，2026-04-26）—— P0 PR Review Bot 方案，已交付
- 本文（v2，2026-04-28）—— 剩余 6 项企业版 + Phase 0 新增

---

> **核心心法**：GitNexus 是 Agentic DevOps 闭环的"代码真相层"——别的层可以不准，**它必须确定**。每一个新功能都先问一句：它会让 Agent 多一份能信任的硬约束，还是多一层概率猜测？
