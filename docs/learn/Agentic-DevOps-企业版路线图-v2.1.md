# 团队自建版 GitNexus 企业版 — 7 阶段闭环路线图 **v2.1**（增量补丁）

> 作者：GitNexus 核心维护者视角
> 日期：2026-04-30
> 上一版：[v2.0](./Agentic-DevOps-企业版路线图-v2.md)（2026-04-28，全闭环 commit + tag 完成）
> 状态：**🚀 v2.0 → v2.1 升级落地，主航道无偏移，4 个增量已实现并打 tag**

## 0. 这一版做什么

**v2.0 完成了 7 阶段骨架闭环**（10 个 tag）。**v2.1 不改主航道**，只把 v2.0 之后落地、但 v2.0 路线图未登记的 4 个增量补进去：

| 增量 | 来源 commit / tag | v2.0 没登记的原因 |
|---|---|---|
| **① R-1 → R-14.6 升级**（LLM 真断言 vs scaffold advisory 双轨）| `e2e/v0.5.0-llm-patch` (2026-04-29) + 本轮 `f4110f58` | v2.0 §3.6 写"R-1 scaffold + TODO 占位（不调 LLM 生成断言）"，patch-runner.ts 之后落地的真断言路径未补登 |
| **② S3 增量 · cross-repo/v1.0.0 DIY ContractLink** | `cross-repo/v1.0.0` (2026-04-29) | v2.0 §3.3 只写 "depth=2 crossDepth=1"，cross-repo 真跑要 lbug group sync (Intel Mac 缺 prebuilt 走不通)，DIY 替代方案未登记 |
| **③ S2 增强 · contract-strong + verifyHandlerIsReal + hard-reject** | `observe-pipeline/v1.0.0` (2026-04-30) | 本轮 P1-B / P2 实测发现，v2.0 没提 |
| **④ S5 lang-aware skip + advisory 不推 MR** | `observe-pipeline/v1.0.1` (2026-04-30) | 本轮 P1-A / da530cfd 实测发现，v2.0 没提 |

**主航道核对（v2.0 约束全部保留）**：

- ✅ 7 阶段闭环不新增 stage（改动全在 S2/S3/S5/S6/S7 内部）
- ✅ `OrchestratorDeps` 接口签名 0 改动（mock + 真双路径对称）
- ✅ K8s 写操作只打 `gitnexus-preview-*` ns
- ✅ R-12 auto-pr-policy block `.env/.pem/.key/.github/workflows/**` 完全保留
- ✅ R-14 patch-LLM systemPrompt 隔离（patch-runner.ts:227）
- ✅ Pipeline Orchestrator 单入口 `runPipeline`，buildPRBody + buildAutoPRReportFile

---

## 1. 增量 ① · R-1 → R-14.6 升级（LLM 真断言 vs scaffold advisory 双轨）

### 1.1 v2.0 原约束

> §3.6: "R-1 scaffold + TODO 占位（不调 LLM 生成断言）"
>
> §2.3 R-1 修正: "integration-gen 降期望：先生成调用链结构骨架 + TODO 占位，**不强求自动填值域**"

### 1.2 v2.1 升级（双轨）

| 路径 | 何时跑 | 输出 | push 到 MR? |
|---|---|---|---|
| **轨 A · R-1 scaffold (advisory)** | S5 阶段（orchestrator.ts），永远跑 | `Test_<methodName>.java` (TODO 占位 fail) | **否**（P1-A 修复后，仅评论显示 "advisory，未推 MR"） |
| **轨 B · patch-runner LLM (R-14.6)** | S5 之后独立流程，命中真 handler 时跑 | `fixFiles[]` (改业务代码) + `testFiles[]` (真断言) | **是**（LLM 真出 patch 时推） |

### 1.3 R-14.6 硬约束（patch-runner.ts:24-30）

```
绝对硬约束 (违反任意一条 → 必须 abort, 不要硬塞):
  R-14.1  systemPrompt 隔离 (跟 wiki LLM 不共用 prompt)
  R-14.4  fixFiles + testFiles 总条数 ≤ 5, 总改动行数 (加+删) ≤ 200
  R-14.5  fixFiles 必须只动 handler 路径或它直接依赖的少量文件 (在 blast radius 内)
  R-14.6  testFiles 必须含真断言, 复现 trace 报错的场景;
          不允许 fail("TODO") / @Disabled / @Ignore
```

### 1.4 真 evidence

| MR | trace | LLM 行为 | testFiles 类型 |
|---|---|---|---|
| MR !30 (issue#25) | `TaskMemberReader.loadSnapshot` NPE | 真 patch | 真断言 (`assertThrows(DataException, ...)`) |
| MR !33 (issue#29 ⭐) | `MattermostClient.createPosts` JsonObject NPE | 跨仓真改 | 真断言 |
| MR !44 (issue#58) | trace handler 跟 form_template 表无关 | abort | 0 testFiles，仅推报告（advisory 不推） |

### 1.5 buildTestScaffoldStub 状态

- 仍 export 在 `orchestrator.ts:830`（向后兼容）
- 内部 caller 0 处（P1-A 修复后不再调用，只剩 export）
- 下一版可考虑标 `@deprecated`

---

## 2. 增量 ② · S3 cross-repo/v1.0.0 DIY ContractLink

### 2.1 v2.0 原约束

> §3.3: Stage 3 "GitNexus blast radius，api_blast_radius depth=2 crossDepth=1"
> §0.3 状态表: "P2 Multi-hop crossDepth>1 — 🟡 未做（独立增强）"

### 2.2 v2.1 增量（DIY 替代 lbug group sync）

**为什么 DIY**：mcp-bridge.ts:398 注释明示 — "Intel Mac 缺 `@ladybugdb/core-darwin-x64` prebuilt, group sync 走不通. 用户已提 ladybugdb MR 补 darwin-x64; 等新版本发布后切回原生 ContractLink 注册表 (跟踪 task #14)."

| 角色 | 文件 | 职责 | 状态 |
|---|---|---|---|
| `parseContractId` | `mcp-bridge.ts:455-493` | 解析 3 种 contractId 格式 (`POST /...` / `http::POST::/...` / `/...`) | ✅ 落地 |
| `deriveHandlerNameCandidates` | `mcp-bridge.ts:503-525` | 多形态名字候选 (`createPost` / `CreatePost` / `createPosts` ...) | ✅ |
| `safeNameEqualsClause` | `mcp-bridge.ts:418-456` | 绕开 KuzuDB 1.4.1 read-only-guard bug（字面量含 `create` 等关键字会被误拦） | ✅ |
| `crossBlastRadius` | `mcp-bridge.ts:846-876` | partner 仓 cypher 双 label (Method ∪ Function) + 评分 + name+path/name-only 两层 | ✅ |
| Orchestrator S3 跨仓集成 | `orchestrator.ts:272-313` | 给每个 ok 的 S3 output 注入 `crossLinks[]` 字段 | ✅ |
| OrchestratorDeps | `pipeline/types.ts:248` | 加 `crossBlastRadius` 字段（不破坏对称） | ✅ |

### 2.3 跨仓 LIVE 真 evidence

| iid | 方向 | 跨仓 ContractLink | MR |
|---|---|---|---|
| cses #29 ⭐ | consumer | mattermost `csesapi/posts.go:createPosts` (conf=0.70) | MR !33 — LLM 真改 cses-java 业务代码 |
| cses #31 ⭐ | consumer | partner suspects 首次显示（git log ∩ blast）| MR !35 |
| mattermost #6/#7/#8 | provider | cses-java 反向反查 | MR !6/!7/!8 — **mattermost 仓首次真发** |
| cses #35 | consumer | mattermost `posts.go:393 createPost` (conf=0.70) | MR !37 |

### 2.4 长期路线

- 等 `@ladybugdb/core-darwin-x64` Intel Mac prebuilt（task #14）发布
- 切回 GitNexus 原生 `core/group/cross-impact.ts` + `matching.ts` (`runExactMatch` / `runWildcardMatch`)
- DIY `crossBlastRadius` 标 `@deprecated`，保留作为 fallback

---

## 3. 增量 ③ · S2 contract-strong + verifyHandlerIsReal + hard-reject

### 3.1 v2.0 原约束

> §3.1 Stage 2 "Phase 0 Trace2Code Resolver — Jaeger/OTel 双格式 + 5 层 HTTP fallback + stacktrace"
>
> v2.0 假设 stacktrace 顶帧反查是主路径，没考虑 trace 没 stacktrace 的情况。

### 3.2 v2.1 增量（API path 归一化主导）

**核心转变**：从"靠 stacktrace 顶帧"到"靠 contractId 归一化反查"。stacktrace 现在是 bonus，不是必备。

#### a) B-strong (`mcp-bridge.ts:resolveHandlerByContract`)

把 contractId → 多形态 name 候选 → 双 label cypher 反查 → 评分挑最佳，作为弱 candidates ([stackMethod, codeName, contractMethod]) miss 后的强反查 layer。

```ts
弱 candidates miss
   ↓
resolveHandlerByContract(contractId, primaryRepo)
   ↓
parseContractId → pathSegments
   ↓
deriveHandlerNameCandidates → 多形态候选
   ↓
双 label (Method ∪ Function) + filePath parent 段过滤
   ↓
[score 评分] + [P2 verify] + [P2 hard-reject]
```

#### b) P2 verifyHandlerIsReal (`mcp-bridge.ts:verifyHandlerIsReal`)

调 `gitnexus context API`（`/tool/context`）拿候选符号的 360 度视图，判断是不是孤立假阳性：

- 解析 markdown 提取所有 `→ filePath` (callers + callees)
- 排除 self-pointing (filePath == self)
- **跨包 edges 都 0 → 孤立 → reject** → 走下一个候选
- **跨包 edges ≥ 1 → 真 handler / 工具类 → accept**

#### c) P2 hard-reject 工具类（HANDLER_NON_BIZ_KW）

`logger / util / helper / agent-harness` 路径下的候选**直接过滤**，不进 score 不进 verify。

理由：LOG.java:load 这种工具类有 9 个跨包 callers（verify 通过），但**不是 handler**。score -80 降权不够，必须 hard-reject。

#### d) P1-B 业务路径加权（HANDLER_BIZ_PATH_KW）

`controller / csesapi / client / service/impl / handler / webhook` 路径下候选 **+50 分**。

#### e) tier-3 模糊兜底

`normalizeConsumerPath` (http-route-extractor.ts:62) 把 path lowercase 后 candidates 丢失 camelCase → 加第三层 `lower(name) STARTS WITH lower(末段)` 模糊匹配。confidence 0.25（最低）。

末段 < 4 char 直接跳过（假阳性爆炸）。

#### f) S2 输出诚实化（issue-handler.ts）

旧渲染：所有 spans 列出来，0 真接显示 8 个 `(unknown)` 占位。
新渲染：先 filter `resolved=true` 才进列表 + 加统计行 "共 N 条 spans, 真接到 handler M 条, K 条非 handler span 省略"。

### 3.3 真 evidence

| issue | trace | S2 行为 | 结果 |
|---|---|---|---|
| cses #50 (旧 P1-B 单加权) | `bookmark/load` | 选 `PushController.load:51`（业务路径 +50 但孤立） | 假阳性 |
| cses #52 (P2 + hard-reject) | 同 trace | LOG.java hard-reject + 所有 *Controller.load verify reject | **0 真接 + 诚实 admit** |
| cses #54 | 真 cses error trace `/template/saveAndPublish` | Phase 0 stacktrace 顶帧反查命中 `TaskCommandExecutor.executeResult:59` | ✓ 真业务 handler |
| mattermost #9 | `getSchedule` | tier-3 模糊命中 `Function:getScheduledPost:411` | ✓ Go handler 首次真接 |

---

## 4. 增量 ④ · S5 lang-aware skip + advisory 不推 MR

### 4.1 v2.0 原约束

> §3.6 "S5 R-1 scaffold + TODO 占位"
> v2.0 假设所有仓都是 Java 风格，scaffold 永远 push 到 MR。

### 4.2 v2.1 增量

#### a) Lang-aware skip (`orchestrator.ts:da530cfd`)

S5 前按 handler `filePath` 后缀决策：

```
filePath.endsWith('.java')  → 跑 deps.genE2ETests (R-1 scaffold)
非 .java (.go / .rs / .ts / .py / ...) → skip with reason
```

**理由**：R-1 scaffold 模板硬编码 Java 风格 (`Test_xxx.java` + JUnit)。Go 仓 issue 拿到 `Function:posts.go:createPosts` handler 时，旧 S5 仍照模板出 `Test_createPosts.java` 挂在 Go 仓上 — 新错位。

#### b) Advisory 不推 MR (`orchestrator.ts:f4110f58`)

LLM abort 时（`genFixResult == null`）：
- **旧**：仍 push S5 R-1 scaffold (`buildTestScaffoldStub` 输出 `fail("TODO: implement test by developer")`) 到 MR
- **新**：只推 7 阶段诊断报告，**0 个 TODO scaffold**

#### c) 渲染诚实化 (`issue-handler.ts:f4110f58`)

S5 段渲染时检查 S7 `put-files` reason `pushed N file(s)`：
- N == 1 → 仅推报告 → 显示 "**未 push 到 MR** — P1-A advisory"
- N >= 2 → 含 LLM 真 patch → 正常显示

### 4.3 真 evidence

| MR | S5 段文案 | MR 真 diff |
|---|---|---|
| MR !39 (issue#48 旧) | "生成 1 个脚手架: Test_load.java" | 2 files (报告 + Test_load.java TODO) — **不一致** |
| MR !44 (issue#58 新) | "生成 1 个脚手架 (advisory, **未 push 到 MR**)" | 1 file (仅报告) — **一致** ✓ |
| MR !7 (mattermost #11) | S5 _skipped: handler 非 Java (filePath=*.go)..._ | 1 file (仅报告，0 个 .java 错位) ✓ |

---

## 5. v2.0 → v2.1 mermaid 总览（增量节点用 🟦 标记）

```
flowchart TB
    OBS["🔍 1.观测<br/>/observe + Jaeger + Prom"]
    PRE["⚙️ pre · P1 Auto-reindex Webhook ✅"]
    S2["🎯 2.锚点 · Phase 0 Trace2Code Resolver ✅<br/>🟦 + B-strong contract-strong (mcp-bridge.ts)<br/>🟦 + verifyHandlerIsReal (gitnexus context)<br/>🟦 + hard-reject 工具类 (P2)<br/>🟦 + tier-3 lower 模糊兜底"]
    S3["💥 3.爆炸 · GitNexus blast radius ✅<br/>🟦 + cross-repo/v1.0.0 DIY ContractLink (mcp-bridge.crossBlastRadius)<br/>🟦 + P3 跨仓 0 命中也显式 (本仓无 handler 时)"]
    S4["🔬 4.溯源 · Auto Regression Forensics ✅"]
    S5["🧪 5.生成 · E2E Test Generator ✅<br/>🟦 + Lang-aware skip (Go/Rust/TS 仓不产 .java)<br/>🟦 + Advisory 不推 MR (LLM abort 时)<br/>🟦 + 渲染诚实化 (显式标 advisory)"]
    S6["🚀 6.执行 · K8s Preview Env Spinner ✅<br/>🟦 + fake-S6 模板 (nginx + busybox + JUnit, demo 路径)"]
    S7["📤 7.回写 · Auto-PR/MR Creator ✅<br/>🟦 + R-14.6 真断言 vs R-1 advisory 双轨 (patch-runner)<br/>🟦 + 跨仓多 partner MR (cross-repo/v1.0.0)"]

    OBS -->|发现 error / 慢响应| PRE
    PRE --> S2
    S2 --> S3
    S3 --> S4
    S4 --> S5
    S5 --> S6
    S6 --> S7
    S7 -.->|🔁 闭环| OBS
```

---

## 6. v2.0 → v2.1 现状表更新

| 功能 | Pri | v2.0 状态 | v2.1 状态 | 备注 |
|---|---|---|---|---|
| Phase 0 Trace2Code Resolver | — | ✅ phase-0/v0.1.0 | ✅ + B-strong + verify + hard-reject + tier-3 | observe-pipeline/v1.0.0 |
| GitNexus blast radius | — | ✅ stage-3/v0.1.0 | ✅ + DIY cross-repo ContractLink | cross-repo/v1.0.0 |
| Auto Regression Forensics | P5 | ✅ stage-4/v0.1.0 | ✅ + 跨仓 partner suspects | cross-repo/v1.0.0 |
| **E2E Test Generator** | P4 | ✅ R-1 scaffold + TODO | ✅ + R-14.6 真断言双轨 + lang-aware + advisory 不推 | observe-pipeline/v1.0.1 |
| K8s preview env spinner | — | ✅ stage-6/v0.1.0 | ✅ + fake-S6 demo 路径 | F (Phase 3) |
| **Auto-PR/MR Creator** | — | ✅ stage-7/v0.1.0 | ✅ + 跨仓多 partner MR + LIVE 三因子真发 | cross-repo/v1.0.0 + e2e/v0.5.0-llm-patch |
| Pipeline Orchestrator | — | ✅ pipeline/v0.2.0 | ✅ + S2 unknown filter + S3 cross-link skipped 时显示 | observe-pipeline/v1.0.0 |

---

## 7. v2.1 累计真 evidence

### MR 数（cross-repo/v1.0.0 之后）

| 仓 | MR 范围 | 类型 |
|---|---|---|
| cses-java | !29~!44 (16 个) | 含 LIVE 真改业务代码 + advisory 报告 MR |
| mattermost | !6/!7/!8 (3 个) | **mattermost 仓首次真发** (cross-repo/v1.0.0 后) |

### 双向跨仓 demo

`cses #35 ↔ mattermost #12` (createPost contract 双向命中, conf=0.70)

### LLM abort 真验证

`MR !44`: handler 跟 form_template 表无关 → LLM 主动 abort → 仅推报告（advisory），符合 R-14.6 + P1-A 双重保险

---

## 8. v2.0 → v2.1 commit / tag 索引

### Tag

| tag | commit | 范围 |
|---|---|---|
| `cross-repo/v1.0.0` | `ac9b771f` | DIY 跨仓 ContractLink + 多仓 LLM context + S7 多 PR |
| `e2e/v0.5.0-llm-patch` | (内嵌 cross-repo) | LLM patch runner 接 claude -p 真出补丁 + R-14.6 真断言 |
| **`observe-pipeline/v1.0.0`** | `65c7cc4d` | 增量 ②③④ + P3 跨仓 explicit |
| **`observe-pipeline/v1.0.1`** | `f4110f58` | S5 advisory 渲染诚实化 |

### 本轮 9 个核心 commit (`feat/agentic-devops-cross-repo`)

```
f4110f58  fix(observability): S5 段诚实显示 "scaffold 未 push 到 MR" (LLM abort 时)
65c7cc4d  fix(orch+obs): P3 跨仓分析 0 命中也显式说明 (cses#54 evidence)
59728ca7  fix(bridge+orchestrator): P2 verifyHandlerIsReal + hard-reject + P3 跨仓 link
645c6e2c  fix(bridge+orchestrator): P1-A 不推 TODO scaffold + P1-B 业务路径优先
0cd6d2d4  docs(tags): eval-server SIGSEGV 根因诊断 + pm2 守护方案
d50622d9  docs(session+tags): 沉淀本轮 4 commit + 9 个里程碑 tag 描述
5ef03b8b  fix(observability): S2 报告只显示真 handler, 子 span 统计行透明
da530cfd  fix(orchestrator): S5 仅对 Java handler 生成 scaffold, Go/Rust/TS 仓 skip
589ef237  feat(bridge): B-strong contract-strong handler resolve + tier-3 模糊兜底
9905147b  fix(bridge+orchestrator): D+E+E-deep 消除 Unknown 错位输出
```

---

## 9. v2.0 剩余 backlog（v2.1 状态更新）

| backlog | v2.0 状态 | v2.1 状态 |
|---|---|---|
| **R-2** 镜像三级降级（Harbor + 手工版本号场景）| 🟡 backlog | 🟡 仍 backlog（fake-S6 临时绕过） |
| **R-4** 双 GitHub App（PR Reviewer + Auto-PR）| 🟡 单仓 demo 用同一 token | 🟡 仍 backlog（生产前必须拆） |
| **P2 Multi-hop crossDepth>1** | 🟡 未做 | 🟡 仍未做（DIY 跨仓 v1.0.0 用 crossDepth=1） |
| **P3 Auto Wiki 刷新** | 🟡 未做 | 🟡 仍未做 |
| **P6 OCaml LanguageProvider** | 🟡 未做 | 🟡 仍未做 |
| **eval-server 稳定性** | 未提 | 🆕 P0 — KuzuDB 1.4.1 N-API SIGSEGV，pm2 守护过渡，等 ladybugdb prebuilt |
| **bridge 切回 GitNexus 原生 cross-impact** | 未提 | 🆕 跟踪 task #14（@ladybugdb/core-darwin-x64 Intel Mac prebuilt）|

---

## 10. 下一步规划（v2.2 候选）

| 候选 | 阻塞 | 优先级 |
|---|---|---|
| 切回 GitNexus 原生 `cross-impact.ts` (DIY 删除) | ladybugdb prebuilt | 高 |
| stacktrace 顶帧多帧解析（跳过 jOOQ/Postgres 库帧到业务 frame） | 无 | 中（issue#53→#54 evidence） |
| 语义 alias 词典 (`getXxx` ↔ `queryXxx`，path 末段 `change`/`increment` 业务术语映射) | 无 | 中 |
| R-4 双 App 拆分（生产前必须） | 团队 GitHub org 政策 | 中 |
| OCaml LanguageProvider (P6) | 业务需求 | 低 |

---

## 附录 · 文档同生命周期

- session.md §22-§23 已沉淀本轮 9 commit + 4 增量 evidence
- docs/learn/tags/ 12 个 tag 描述（含 observe-pipeline-integration.md / cross-repo-v1.0.0.md / eval-server-stability-analysis.md 等）
- knowledge base score 100/100（170 知识点，L6 #151-#170 本轮新增 20 个）
- gitnexus-knowledge SKILL + gitnexus-dev agent 已重生成

---

## 11. lbug-switch v1.1 sprint 增量 (2026-04-30 ~ 05-01)

> 配套文档: [lbug-切换-回归测试-环境清单-v1.md](./lbug-切换-回归测试-环境清单-v1.md)
> tag: `lbug-switch/v1.0.0-LIVE` (cses MR !45) + `lbug-switch/v1.1.0-LIVE` (mattermost MR !9)

### 11.1 主线

把 §10 候选 "切回 GitNexus 原生 cross-impact.ts" **真落地** —— 解 LadybugDB#436 (Intel Mac darwin-x64 prebuild 缺) → fork & republish `@lichao176/ladybug-core-darwin-x64@0.16.0` 到公网 npm 临时桥 → orchestrator wiring 主路径切到 `lookupStandardCrossLink` (bridge.lbug ContractLink, conf=1.00), DIY `mcp-bridge.crossBlastRadius` 退到 fallback (conf=0.4-0.7).

### 11.2 v2.1 §10 候选 状态更新

| 候选 | v2.1 状态 | v1.1 状态 |
|---|---|---|
| 切回 GitNexus 原生 cross-impact.ts | 阻塞 ladybugdb prebuilt | ✅ **落地** (lbug-switch v1.1) |
| stacktrace 顶帧多帧解析 | backlog | 🟡 仍 backlog (v1.2 含 B2 Go trace 解析) |
| 语义 alias 词典 | backlog | 🟡 仍 backlog (v1.2 含 B1 case 保留) |
| R-4 双 App 拆分 | 团队政策阻塞 | 🟡 仍 backlog |
| OCaml LanguageProvider | 业务需求 | 🟡 仍 backlog |

### 11.3 v1.1 真增量 (落地)

| 增量 | 文件 | 真证据 |
|---|---|---|
| ① npm 桥 (@lichao176 fork) | 公网 npm | size=5.6MB, sha512=BTjVRUrK..., dist-tag latest |
| ② Java HTTP plugin Micronaut 模式 | `core/group/extractors/http-patterns/java.ts` | cses 仓 routes 0 → **1037** (+12000%) |
| ③ standard-cross-link wiring | `core/group/standard-cross-link.ts` + `start-webhook-server.ts:639` | matchType=manifest, conf=1.00 ★ |
| ④ CrossLinkOutput.matchType union 扩 | `core/pipeline/types.ts` | 兼容性扩 'exact'/'wildcard'/'manifest', mock 不破 |
| ⑤ GitLab put-files PUT-400-fallback-POST | `core/auto-pr/providers/gitlab.ts` | mattermost MR !9 真发 (新文件 POST 创建) |

### 11.4 双 MR 真发集齐 + 真 Jaeger 闭环

| MR | source | LLM | 验证点 |
|---|---|---|---|
| cses !45 | issue #61 (合成 trace) | $0.91 真断言 | R-14.6 真 patch + StubMattermostClient mock + assertThrows |
| mattermost !9 | issue #25 (合成 trace) | $0.46 abort | put-files fix 真生效 (advisory 报告新文件创建) |
| mattermost !10 | issue #26 ★ 真 Jaeger 56c8b | $0.37 abort | webhook 自取 traceUrl 真证据 (spans=2 fetched) |

### 11.5 真巡检 #62 暴露 v1.2 backlog

真 mattermost cross-repo error trace `43506ebd` (`incrementByChannelId`) → S2 0 handlers (path lowercase + Go trace 无 stacktrace 双重). 暴露 v2.2 → **v1.2** sprint 4 项 backlog (见 lbug-切换 文档 §6.3):

| backlog | 优先级 |
|---|---|
| B1 path 归一化保留 camelCase | 高 |
| B2 Go trace path-only anchor 增强 | 高 |
| B3 manifest 扩 80+ csesapi 接口 | 中 |
| B4 mattermost BaseRoutes chain extractor | 中 |
| B5 撤 lichao176 fork override (等上游 0.16.1) | 低 |

### 11.6 主航道约束验证 (全保留)

- ✅ 7 阶段闭环不新增 stage (改动全在 S2/S3/S5/S6/S7 内部 + ORCH wiring)
- ✅ OrchestratorDeps 接口签名 0 改动 (matchType union 兼容性扩)
- ✅ K8s 写操作只打 `gitnexus-preview-*` ns
- ✅ R-12 auto-pr-policy block 列表完整保留
- ✅ R-14 patch-LLM systemPrompt 隔离 + R-14.6 真断言
- ✅ LIVE 三因子真发 MR (label + env + S6 真绿勾)

### 11.7 回归测试

- 31/31 tests pass (orchestrator + cross-impact + manifest-extractor)
- 24/24 tests pass (lbug-adapter + pool-adapter + bridge-db)
- 12/12 tests pass (auto-pr providers, 含 put-files fix)
