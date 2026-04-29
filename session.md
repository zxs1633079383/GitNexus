# Session 接力文档 — 新 Claude 会话直接续上

> **写给下一个 Claude 会话**：读完本文 + `RULES.md` + roadmap §0-§2，就能直接动手做所有功能。
> 本文不重复 roadmap 内容，只提供"去哪读 + 现在做什么 + 怎么做 + DOD"。
> 最后更新：**2026-04-29（MVP v1.1.0 + 真 Jaeger 端到端验证完成）**

---

## 0. 用户的本意（不要忘）

把现有零散资产（`/observe` + Jaeger/Prom + GitNexus OSS + git + K8s + GitHub/GitLab）串成一条
**从"线上出错"到"自动开 PR 修复"** 的 7 阶段 Agentic DevOps 闭环 —— 团队自建版的 GitNexus 企业版。

GitNexus 在闭环里的位置：**确定性知识基础设施**（唯一不靠 LLM 的层）。

---

## 1. 你现在在哪

```
工作目录: /Users/mac28/workspace/java/zlc_ai/GitNexus  (← 主仓，git 管理)
当前分支: docs/agentic-devops-roadmap-v2
镜像目录: /Users/mac28/workspace/ai-workspace/Agentic-Devops  (非 git，用户跨项目笔记)
```

git 状态：
- 路线图分支 `docs/agentic-devops-roadmap-v2` 已有 6+ commits（最新见 §14）
- 还未 push 到 remote（用户决定时机）
- 还未发 PR

**本文件 (`session.md`) 和 `RULES.md` 都在 GitNexus 仓根目录** —— 跟代码同生命周期 git 版本化。
Agentic-Devops 那边只是镜像副本（用户跨项目对照用，非 source of truth）。

---

## 2. 必读顺序（10 分钟）

按顺序读完才能动手：

1. **`RULES.md`**（同目录）—— 自律守则，红线，**违反就退回重做**
2. **路线图 §0-§2**（770 行的前 327 行）：
   - GitNexus 仓: `docs/learn/Agentic-DevOps-企业版路线图-v2.md`
   - Agentic-Devops 仓: `docs/Agentic-DevOps-企业版路线图-v2.md`
3. **§3.X**：开始某个 Stage 前才读对应小节
4. **mermaid 流程图**（视觉总览）：
   - GitNexus: `docs/learn/diagrams/16-agentic-devops-7-stage-loop.mmd`
   - Agentic-Devops: `docs/16-agentic-devops-7-stage-loop.mmd`

---

## 3. 7 阶段闭环速记（详见 §0.2）

```
pre   P1 Auto-reindex Webhook         ← 索引保鲜
1     /observe + Jaeger + Prom        ← 已有
2     Phase 0 Trace2Code Resolver     ← 🟡 第一刀
3     GitNexus blast radius           ← OSS 已有，仅参数化包装
4     P5 Auto Regression Forensics    ← 🟡
5     P4 E2E Test Generator           ← 🟡 (unit + contract + integration)
6     K8s Preview Env Spinner         ← 🟡 待 R-2/R-3 拍板
7     Auto-PR/MR Creator              ← 🟡 待 R-4 拍板
横切  Pipeline Orchestrator + Comment Policy
side  P3 Auto Wiki                    ← 顺手挂 P1
并行  P2 Multi-hop / P6 OCaml         ← 不抢主链路资源
```

---

## 4. 已完成清单

### 文档
- ✅ 路线图 v2（770 行，双仓 byte 级一致）
- ✅ mermaid 流程图（双仓副本）
- ✅ session.md（本文）
- ✅ RULES.md（205 行自律守则）

### 代码
- ✅ P0 PR Review Bot（已上线，含 `crossDepth=1` 跨仓影响分析；GitHub App `gitnexus-pr-reviewer-zxs`）

### 评审留痕
- ✅ 第一轮 review（gitnexus-dev）：2 硬 bug + 4 中 + 多低 → 路线图 §2.2（Bug-1/2 + Fix-1..9）
- ✅ 第二轮 review（gitnexus-dev）：6 高 + 8 中 + 4 低 → 路线图 §2.3（R-1..R-18）

### Fixture
- ✅ 真实 trace JSON: `/tmp/jaeger-trace.json` (17.8 KB, pre 环境)
- ✅ Jaeger Query API 拉法: `curl http://192.168.6.66:32281/api/traces/a9a3a507a29c7706cfc6f3ad1f454d40 -H "Accept: application/json"`

---

## 5. 待做功能清单（按优先级）

### 🚀 Phase 0 · Stage 2 Trace2Code Resolver —— 第一刀

**RULES §5.1 强制：第一个 PR 必须是 Phase 0**（不依赖 R-2/R-3/R-4，可立即开工）

#### 启动命令
```bash
git checkout docs/agentic-devops-roadmap-v2  # 确保在路线图分支
git checkout -b feat/jaeger-span-normalizer  # 开 Phase 0 分支
```

#### 文件清单（照搬 §3.1）
| 文件 | 类型 | 行数 | 说明 |
|---|---|---|---|
| `gitnexus/src/core/observability/jaeger-span-normalizer.ts` | 🆕 | ~80 | 双格式 detect + 5 层 HTTP fallback |
| `gitnexus/src/core/observability/jaeger-span-types.ts` | 🆕 | ~60 | `SpanInput` / `NormalizedSpan` / `FallbackHop` |
| `gitnexus/src/core/observability/stacktrace-parser.ts` | 🆕 | ~60 | OTel exception event 顶帧 → (file, class.method, line) |
| `gitnexus/src/mcp/local/local-backend.ts` | 🔧 | +50 | 加 `resolveSpanToHandler` 方法 |
| `gitnexus/src/mcp/tools.ts` | 🔧 | +30 | 加 `resolve_span` MCP 工具 + 拓展 `api_impact` |
| `gitnexus/test/observability/jaeger-span-normalizer.test.ts` | 🆕 | ~250 | 8 fixtures 单测 |

#### 必须遵守的修正点
- **Bug-1**：用 `normalizeConsumerPath`（`http-route-extractor.ts:78`），**不是** `normalizeHttpPath`（防裸数字路径 `/api/users/123`）
- **R-6**：文件头加 `// query-only — must not be called from any pipeline phase`
- **R-6 进阶**：CI lint 规则禁止从 `core/ingestion/**` import `core/observability/**`
- **Fix-9**：被动推模式（caller POST span 数组），不主动拉 Jaeger

#### 8 fixtures 必覆盖
| # | 输入特征 | 期望输出 |
|---|---|---|
| 1 | 真实 trace JSON（`/tmp/jaeger-trace.json`，含 `http.route` + stacktrace）| handler symbol UID = `Method:.../TaskMemberReader.java:loadSnapshot#1` |
| 2 | 旧 conv `http.url`（构造，无 path 参数）| `http::POST::/api/cses/posts/create` |
| 3 | 新 conv `url.path`（构造）| `http::POST::/Collaborate/loadWorkOrientForMember` |
| 4 | 裸数字 ID `/api/users/12345`| `normalizeConsumerPath` 归一为 `/api/users/{param}` |
| 5 | gRPC `rpc.service` + `rpc.method` | `grpc::package.service/method` |
| 6 | Topic `messaging.destination` | `topic::order.created` |
| 7 | 仅 `code.function + code.filepath` | Method 直查命中 |
| 8 | 全空 attribute | `kind: 'unknown'` |

#### 完成定义（DOD）
- [ ] 8 fixtures 单测全过
- [ ] `mcp__gitnexus__resolve_span(<jaeger json>)` 返回 `{kind: 'http', contractId, symbolUid}`
- [ ] fixture #1 真实 trace 跑通（stacktrace 顶帧反查命中 `loadSnapshot#1`）
- [ ] commit message 格式正确（见 §7）
- [ ] PR 描述链接到 §3.1
- [ ] PR 通过 P0 PR Bot review

---

### Stage 3 · Blast Radius 包装（0.5 周）

**依赖**：Phase 0 完成

**单点改动**：`gitnexus/src/mcp/tools.ts` 加新 MCP 工具（包装现有 `impact`）：
```ts
// 默认 depth=2 crossDepth=1，可被 caller override
api_blast_radius({ symbol_uid, depth = 2, cross_depth = 1, ... })
```

无新文件。复用 `local-backend.ts:2341` 的 `impact()` 入口。

---

### Stage 4 · P5 Auto Regression Forensics（1 周）

**依赖**：Phase 0 + Stage 3 包装

**详细方案**：路线图 §3.3

**关键修正**：
- Fix-1：suspects 必须加文件路径过滤（只交叉 handler 所在文件直接改动）
- Fix-2：自跑 `git log --format="%H %at"` 拿 commit 时间戳

---

### Stage 5 · P4 E2E Test Generator（2 周）

**等 R-1 修正确认**：integration-gen **降期望**——只生成"调用链结构骨架 + TODO 占位"，不强求自动填值域。

**详细方案**：路线图 §3.6

**关键修正**：R-1 / R-6 / R-7 / R-13 / R-18

---

### Stage 6 · K8s Preview Env（1.5 周）—— ⛔ 锁定

**待 R-2 + R-3 拍板才能开工**（RULES §4.2）

需要用户回答：
- R-2: 团队 CI registry 镜像保留多久？
- R-3: MCP 客户端能否接受异步 job 模式？

**详细方案**：路线图 §3.7

---

### Stage 7 · Auto-PR/MR Creator（1 周）—— ⛔ 锁定

**待 R-4 拍板才能开工**

需要用户回答：
- R-4: 团队 GitHub org 能否新增第二个 App？

**详细方案**：路线图 §3.8

---

### 横切 · Pipeline Orchestrator（0.5 周）

**依赖**：Stage 1-7 全部完成

**详细方案**：路线图 §3.10

---

### 并行（互不阻塞，可同时开）

- **P2 Multi-hop crossDepth>1**（1.5 周）—— §3.4
- **P3 Auto Wiki 刷新**（0.5 周，搭 P1 webhook 顺风车）—— §3.5
- **P6 OCaml LanguageProvider**（2 周）—— §3.9

---

## 6. 🔴 待用户拍板（动工 Stage 6/7 前必须）

| # | 决策点 | 锁定 | 用户需要明确回答 |
|---|---|---|---|
| **R-2** | 团队 CI registry 保留策略 | Stage 6 | 镜像保留 14d / 30d / 永久？on-demand build 是否真需要？ |
| **R-3** | MCP 客户端能否接受异步 job | Stage 6 | tool 立返 `{jobId}` + 轮询 vs 阻塞等结果 vs webhook 回调 |
| **R-4** | 团队 GitHub org 拆 App | Stage 7 | 能否拆 App-1（PR Bot）+ App-2（Auto-PR）？还是只能复用一个？ |

**未拍板的 Stage 不能开工**（RULES §4.2）。

---

## 7. 工作流程（硬规定，RULES §3）

```
改方案 → 改文档 → review → 实现 → 跑评审
```

**顺序固定，不能颠倒**。

每开一个 Stage：
1. 读 §3.X 该 Stage 详细文件清单
2. 读 §2.2 + §2.3 review 修正点（找该 Stage 涉及的 R-X）
3. 写代码必须遵守 R-X
4. commit message 引用 R-X 编号
5. PR 描述链接到 §3.X
6. 通过 P0 PR Bot review + 真人 review

### Conventional Commits 格式（中文 description）

```
<type>(<scope>): <中文描述, ≤50 字>

<可选 body, 中文, 解释 why>
```

`type`：feat / fix / refactor / perf / docs / test / chore / ci / style

`scope` 推荐用：`phase-0` / `stage-3` / `stage-4` / `stage-5` / `stage-6` / `stage-7` / `orchestrator` / `roadmap` / `p2` / `p3` / `p6`

修 review 抓出的问题必须引用 R-X：

```
fix(stage-7): R-5 加 squash merge revert 前置 diff 检查

squash merge 场景下 git revert <hash> 容易失败，加前置：
- git log <hash>^..<hash> 验证可达
- diff 行数超 max_revert_diff_lines 自动降级 Patch
```

---

## 8. Mermaid 维护规则

任何 Stage 实现完成后**必须同步更新** 4 处：

1. `docs/learn/Agentic-DevOps-企业版路线图-v2.md` §0.2 内嵌 mermaid（GitNexus 仓）
2. `docs/learn/diagrams/16-agentic-devops-7-stage-loop.mmd` 独立文件（GitNexus 仓）
3. `docs/Agentic-DevOps-企业版路线图-v2.md` §0.2 内嵌 mermaid（Agentic-Devops 仓）
4. `docs/16-agentic-devops-7-stage-loop.mmd` 独立文件（Agentic-Devops 仓）

视觉规则（实现完成后改色）：
- 🟢 绿（`existing`）：OSS / 外部已有，**或**本路线图新增已实现并 merge
- 🟡 黄（`new`）：本路线图新增**未完成**
- 🔵 蓝（`cross`）：横切层
- 🔴 粉（`side`）：side-effect
- ⚪ 灰（`parallel`）：并行线

例：Phase 0 完成并 merge 后，`S2` 的 class 从 `:::new` 改为 `:::existing`。

---

## 9. 双仓同步规则

GitNexus 是**主仓（git 管理，source of truth）**，Agentic-Devops 是**镜像（文件系统）**。

任何 4 个文件改动后都要同步到 Agentic-Devops：

```bash
GN=/Users/mac28/workspace/java/zlc_ai/GitNexus
AD=/Users/mac28/workspace/ai-workspace/Agentic-Devops

# 路线图主文档
cp "$GN/docs/learn/Agentic-DevOps-企业版路线图-v2.md" \
   "$AD/docs/Agentic-DevOps-企业版路线图-v2.md"

# mermaid 流程图
cp "$GN/docs/learn/diagrams/16-agentic-devops-7-stage-loop.mmd" \
   "$AD/docs/16-agentic-devops-7-stage-loop.mmd"

# session.md (本文)
cp "$GN/session.md" "$AD/session.md"

# RULES.md
cp "$GN/RULES.md" "$AD/RULES.md"
```

校验一致性（4 个文件）：

```bash
for f in \
  "docs/learn/Agentic-DevOps-企业版路线图-v2.md|docs/Agentic-DevOps-企业版路线图-v2.md" \
  "docs/learn/diagrams/16-agentic-devops-7-stage-loop.mmd|docs/16-agentic-devops-7-stage-loop.mmd" \
  "session.md|session.md" \
  "RULES.md|RULES.md" ; do
  GN_FILE="${f%%|*}"; AD_FILE="${f##*|}"
  diff -q "$GN/$GN_FILE" "$AD/$AD_FILE" && echo "✓ $GN_FILE"
done
```

---

## 10. 关键路径速查（复制粘贴用）

### 路径
```
GitNexus 仓 (主, git 管理):  /Users/mac28/workspace/java/zlc_ai/GitNexus
  当前分支:                  docs/agentic-devops-roadmap-v2
  本文 session.md:           ./session.md            (root)
  自律守则 RULES.md:         ./RULES.md              (root)
  路线图主文档:              docs/learn/Agentic-DevOps-企业版路线图-v2.md
  路线图 mermaid:            docs/learn/diagrams/16-agentic-devops-7-stage-loop.mmd
  源码根:                    gitnexus/src/

Agentic-Devops 仓 (镜像, 非 git): /Users/mac28/workspace/ai-workspace/Agentic-Devops
  路线图副本:                docs/Agentic-DevOps-企业版路线图-v2.md
  mermaid 副本:              docs/16-agentic-devops-7-stage-loop.mmd
  session 副本:              session.md
  RULES 副本:                RULES.md
```

### 关键源码锚点（复用现有 OSS）

| 文件 | 行号 | 用途 |
|---|---|---|
| `gitnexus/src/core/group/extractors/http-route-extractor.ts` | `:78` | `normalizeConsumerPath`（Phase 0 用）|
| `gitnexus/src/core/group/extractors/http-route-extractor.ts` | `:61` | `normalizeHttpPath`（**不要**用，Bug-1）|
| `gitnexus/src/mcp/tools.ts` | `:285` | `impact` JSONSchema（Stage 3 包装）|
| `gitnexus/src/mcp/local/local-backend.ts` | `:2341` | `impact()` 入口（Stage 4 复用）|
| `gitnexus/src/mcp/local/local-backend.ts` | `:2865` | 四轴风险评级 |
| `gitnexus/src/mcp/local/local-backend.ts` | `:1410` | `resolveSymbolCandidates` |
| `gitnexus/src/core/group/cross-impact.ts` | `:34` | `CY_NEIGHBORS_UPSTREAM` Cypher |
| `gitnexus/src/core/group/cross-impact.ts` | `:253` | `mergeRisk`（P2 改）|
| `gitnexus/src/core/group/cross-impact.ts` | `:519` | `closeBridgeDb`（P2 修句柄泄漏）|
| `gitnexus/src/core/git-staleness.ts` | — | HEAD 早退（P1 复用）|
| `gitnexus/src/cli/analyze-worker.ts` | — | analyze 任务执行（P1 复用）|
| `gitnexus/src/core/wiki/llm-client.ts` | — | LLM 客户端模式（Stage 5/7 复用）|
| `gitnexus/src/core/ingestion/pipeline-phases/processes.ts` | — | Process / STEP_IN_PROCESS（Stage 5 复用）|
| `gitnexus/src/core/ingestion/languages/index.ts` | — | satisfies 编译期校验（Stage 5 适配器 / P6 复用）|
| `gitnexus/src/core/ingestion/languages/c-cpp.ts` | `:324` | `wildcard-transitive`（P6 OCaml `include` 参考）|
| `gitnexus/src/scope-resolution/registry-primary-flag.ts` | `:67` | `MIGRATED_LANGUAGES`（P6 不进）|

---

## 11. Skills / Agents 使用规范

- `/gitnexus-knowledge` skill：写代码前**事实校对**源码细节（行号 / API / schema）
- `/gitnexus-dev` agent（background 跑）：高风险变更或新 Stage 完成后**独立评审**
- 不要用 LLM 在 index-time（RULES §0.4）—— 摄入管线 12 阶段绝不调 LLM

---

## 12. ✅ 接力检查清单（新会话第一件事 — 跨仓阶段, 2026-04-29 起）

> 单仓 single-repo/v1.0.3 已完整闭环（issue#25 → MR!30, $1.11, 234s）。
> 新会话目标：把单仓闭环扩到**跨仓**（`cross-repo/v1.0.0`）。
> 老的 Phase 0 接力清单（jaeger-span-normalizer 起步）已 obsolete，看 §19 单仓最终成果。

按顺序过（10 分钟）：

- [ ] 读 [`/CLAUDE.md`](CLAUDE.md) §⚓ 主航道（守轨规则 + 7 条偏轨道清单）
- [ ] 读 [`docs/learn/全流程演示-issue到真改代码.md`](docs/learn/全流程演示-issue到真改代码.md)（§0 TL;DR + §3 实跑剖析 = 5 分钟）
- [ ] 读 [`docs/learn/跨仓-Agentic-DevOps-roadmap.md`](docs/learn/跨仓-Agentic-DevOps-roadmap.md) **必读**（§1 单仓 vs 跨仓 7 维度对比 + §2 9 个缺口 D-1..D-9）
- [ ] 跳读 [`docs/learn/单仓-Agentic-DevOps-闭环-真跑通-SOP.md`](docs/learn/单仓-Agentic-DevOps-闭环-真跑通-SOP.md) §6（每段对应源码位置, 跨仓改要看哪些点）
- [ ] 看 §19（单仓最终成果速查）
- [ ] 确认当前分支：`feat/jaeger-span-normalizer`（保留），跨仓开新分支 `feat/cross-repo-bridge`
- [ ] 确认 server / eval-server 都活：`curl :3034/health` + `curl :4848/health`
  - eval-server 18+ 仓含 cses-java / mattermost / clawlive / clawlive-api
  - webhook server PID `cat /tmp/gnx-server.pid` 跑 v1.0.3
- [ ] **第一刀必须 0 周 spike — 不要直接进 Phase 1**:
  ```bash
  # 不动生产, 在 staging registry 验真 OSS 1.4.1 group 命令真签名
  gitnexus group --help                          # 看真 subcommand: 是 sync 不是 analyze?
  gitnexus group create yundiz-staging
  gitnexus group add --help                      # 看真参数: positional 还是 --group/--repo flag?
  # 实测后, 拿真签名回填 docs/learn/跨仓-...-roadmap.md §2 D-1
  ```
- [ ] spike 输出存 `/tmp/group-spike-output.json`, 作为 Phase 2 fixture
- [ ] **第二刀**：拿到真签名后再开 Phase 1 — bridge.lbug + contract registry 接入

---

## 13. 状态总览（2026-04-29 MVP v1.1.0）

```
✅ 路线图 v2 (含闭环跑通审计表 + 平台支持总览)
✅ Mermaid 可视化 (全部 ✅ 标绿)
✅ session.md (本文，本次更新)
✅ RULES.md
✅ R-2 / R-3 / R-4 全部锁定 (用户已拍板)
─────────────────────────────────────────
✅ MVP v1.0.0  完整 7 阶段闭环代码 + tag
✅ MVP v1.1.0  Jaeger 真接入 + 路线图闭环审计
✅ MVP v1.2.0-bridge  webhook S2/S3 走全局 eval-server 真索引 (cypher-only, 替 4 处 mock)
✅ MVP v1.2.0-bridge.1  CLI 主路径 + cypher fallback + 多仓 token map
✅ MVP v1.3.0-llm-patch  claude-cli stream-json 接入, LLM 真改 Java 代码 + 真断言
─────────────────────────────────────────
✅ single-repo/v1.0.0  单仓 Agentic DevOps 闭环达成 (issue → 真发 MR 含真改代码)
✅ single-repo/v1.0.1  gitnexus-dev review 整改 5 项 (dryRun env 闸 / R-14 黑名单 / LLM 并发 / S4 真 git log / 删死文件)
✅ single-repo/v1.0.2  P1 reindex 真接 + M-2/M-3/L-3 polish + 跨仓 roadmap 文档
✅ single-repo/v1.0.3  issue 评论 S4 表格渲染对齐 (两套 renderer 都修)
─────────────────────────────────────────
✅ cross-repo/v1.0.0   跨仓 ContractLink + 多仓 LLM context + S7 多 PR (D-1~D-6 + D-9 落地)
✅ D-7 P1 group reindex 自动化 (commit 2b7ffff7 + eeead2c8 fix)
🟡 D-4/D-8 多 service preview + LIVE 闸严格化 → docs/backlog/cross-repo-v1.1-multi-service-preview.md
─────────────────────────────────────────
真实 e2e 验证 (3 次 tag):
  · e2e/v0.1.0-yundiz       git.yundiz.com 单次真 MR (issue #2/#3)
  · e2e/v0.2.0-overnight    隔夜 13 维度 100% 通过 (issue #4-#6)
  · e2e/v0.3.0-real-jaeger  真 Jaeger trace 全链路 (issue #7)
─────────────────────────────────────────
backlog (并行线，不阻塞闭环):
  · S6.2 image-injector R-2 4 级降级
  · P2 Multi-hop crossDepth>1
  · P3 Auto Wiki 刷新
  · P6 OCaml LanguageProvider
  · ⚠️ GitNexus 版本对齐 (本仓 lbug ↔ 全局 1.4.1 KuzuDB 不通)
    详见 docs/backlog/gitnexus-version-sync.md
    短期 MVP: eval-server HTTP 桥接 (方案 A.2)
    长期: OSS 2.x 时切 KuzuDB
```

---

## 14. Git 历史 (按 tag 分组，17 个 milestone)

```
mvp/v1.0.0              ⭐ 完整 7 阶段闭环 MVP
mvp/v1.1.0              ⭐ Jaeger 真接入 + 闭环审计

phase-0/v0.1.0          S2 Trace2Code Resolver
stage-1/v0.1.0          P1 Auto-reindex Webhook (GitHub HMAC)
stage-1/v0.2.0-gitlab   GitLab webhook 路由
stage-3/v0.1.0          S3 api_blast_radius
stage-4/v0.1.0          S4 Auto Regression Forensics
stage-5/v0.1.0          S5 E2E Test Generator
stage-6/v0.1.0          S6 K8s Preview Env (R-3 异步)
stage-7/v0.1.0          S7 Auto-PR/MR (GitHub + GitLab)
stage-7/v0.2.0-gitee    Gitee PR provider

pipeline/v0.1.0         Orchestrator dry-run
pipeline/v0.2.0         S2-S7 全真跑
pipeline/v0.3.0         issue.opened webhook 真闭环

e2e/v0.1.0-yundiz       真 git.yundiz.com 单次验证
e2e/v0.2.0-overnight    隔夜 13 维度
e2e/v0.3.0-real-jaeger  真 Jaeger 端到端
e2e/v0.4.0-live-bridge  完整 7 阶段 LIVE 闭环 (S2-S7 全绿) — issue#18 → MR!24
e2e/v0.5.0-llm-patch    LLM 真改 Java 代码 + 真断言 — issue#22 → MR!27

mvp/v1.2.0-bridge       eval-server HTTP 桥接, S2/S3 真索引数据
mvp/v1.2.0-bridge.1     CLI 主路径 + cypher fallback + 多仓 token map
mvp/v1.3.0-llm-patch    claude-cli stream-json + R-14 system prompt + StructuredOutput

single-repo/v1.0.0      ⭐ 单仓 Agentic DevOps 闭环达成
single-repo/v1.0.1      ⭐ 5 项 review 整改 (dryRun 三因子 / R-14 黑名单 / LLM 并发 / S4 真 / 删死)
single-repo/v1.0.2      ⭐ P1 reindex + M-2/M-3/L-3 polish + 跨仓 roadmap
single-repo/v1.0.3      ⭐ issue/MR 双 renderer S4 渲染对齐
single-repo/v1.0.4      ⭐ 单仓收尾 (本次基线)

cross-repo/v1.0.0       ⭐⭐ 跨仓 ContractLink + 多仓 LLM context + S7 多 PR
                         · D-1 DIY bridge (lbug 替代版, cypher 启发式) ✓
                         · D-2 S3 跨仓 BFS (cross_depth=1) ✓
                         · D-3 S4 跨仓 forensics (partner git log) ✓
                         · D-4 S6 单 service preview (多 service 留 v1.1) ✓
                         · D-5 S7 多 PR 联动 ✓
                         · D-6 LLM 多仓 context (--add-dir + R-14.7) ✓
                         · D-9 多仓 token / clone 配置 ✓
                         5 次 e2e: issue#26-30, MR!31-34
                         · #29 → !33  ⭐ MVP — LLM 真改 createPosts 返 void 对齐 mattermost
                         · #30 → !34  ⭐ 单仓回归 PASS, 0 cross-link 干净退化
                         (commit ac9b771f)

post-v1.0.0:
  · D-7 P1 group reindex 自动化 (commit 2b7ffff7 + fix eeead2c8)
                         e2e 验证: cses-java push → P1 reindex 19s →
                         group rebuild spawn mattermost reindex 715ms ✓
  · D-8 backlog: docs/backlog/cross-repo-v1.1-multi-service-preview.md (commit 98b6eaf7)

🟡 task #14 future: lbug 新版 (darwin-x64 prebuilt) 发布后切回原生 group sync
```

### 19. 单仓闭环最终成果 (single-repo/v1.0.3, 2026-04-29)

**端到端真跑通**: 在 cses/java/cses/cses 仓共发 5 次 LIVE MR (!24~!30 跨多个版本):

| issue → MR | tag | 验证点 | LLM cost |
|---|---|---|---|
| #18 → !24 | e2e/v0.4.0-live-bridge | 7 阶段 LIVE 首跑通 (S6 K8s preview pass) | (无 LLM) |
| #22 → !27 | e2e/v0.5.0-llm-patch | LLM 真改 Java 代码 + 真断言首发 | $1.42 |
| #23 → !28 | single-repo/v1.0.1 验证 | 多仓 token + 重启 server 不丢 secret | $1.07 |
| #24 → !29 | single-repo/v1.0.2 验证 | S4 真喂 dc92d9f1 给 LLM, patch 质量提升 | $0.98 |
| #25 → !30 | single-repo/v1.0.3 验证 | 双 renderer 对齐, 真 commit/subject/author 显示 | $1.11 |

**关键产物**:
- `docs/learn/单仓-Agentic-DevOps-闭环-真跑通-SOP.md` (454 行) — 给新人 10 分钟读懂
- `docs/learn/跨仓-Agentic-DevOps-roadmap.md` (374 行) — 9 个缺口 D-1..D-9 + Phase 1-6 路径
- `docs/learn/全流程演示-issue到真改代码.md` (本次新增) — 实跑数据 walkthrough
- `CLAUDE.md` §⚓ 主航道 — 7 阶段守轨 + 7 条偏轨道清单

**剩余 backlog (未在 single-repo/v1.0.x)**:
- M-1 类型治理 (orchestrator 内 as any 集中点) — 单独 PR
- 跨仓 D-1~D-9 (跨仓 roadmap §2) — 等 Phase 0 spike 验真
- GitHub 平台回归测试 — 待 user 提供 GitHub PAT 后跑 zxs1633079383/clawlive 仓



### 18.5 LIVE bridge e2e (2026-04-29 落地, e2e/v0.4.0-live-bridge)

**触发**：cses/java/cses/cses 仓 issue#18 含 `gitnexus:auto-pr-live` label + `serviceImage=nginx:alpine` + `testCommand` 输出固定 PASS JUnit。

**全 7 阶段实跑结果**：

| Stage | Status | Duration | 真产物 |
|---|---|---|---|
| S2 resolve | ✅ ok | 663ms | `Method:server/.../TaskMemberReader.java:loadSnapshot:93` |
| S3 blast | ✅ ok | 791ms | 40 真业务文件 (ViewReader/WorkItemReader/TaskCreateCmdHandler …) |
| S4 forensics | ✅ ok (空) | 0ms | bridge 已通, 仓盘 git log 接入留 backlog |
| S5 testgen | ✅ ok | 0ms | scaffold `Test_loadSnapshot.java` |
| S6 preview | ✅ pass=1 fail=0 | 9004ms | ns `gitnexus-preview-fe54c1` (TTL 30min, 自动 GC) |
| S7 auto-pr | ✅ MR opened | 2483ms | [!24](http://git.yundiz.com/cses/java/cses/cses/-/merge_requests/24) — 推了 .gitnexus/reports/auto-pr-issue-18.md + Test_loadSnapshot.java |

**关键证据** — MR !24 的 diff 真有 `.gitnexus/reports/auto-pr-issue-18.md`，里面全部是真 cses-java 业务文件路径，没有任何 mock。`cses-server-pre` 等生产 pods 没动（AGE 不变），preview ns 自动 teardown。

**重启命令** (LIVE 模式 + 多仓 token):

```bash
GITNEXUS_GITLAB_SECRET='cd05ce77556a47bbc26a6fad307bcf12b90564a7c20f28f8' \
GITNEXUS_AUTOPR_TOKEN_MAP='{"cses/java/cses/cses":"glpat-Fb2DYtGYDWZe2FG245KZ","cses/go/mattermost":"glpat-pk29rffrzn_nxZgC6DkK"}' \
GITNEXUS_BRIDGE_REPO_MAP='{"cses/java/cses/cses":"cses-java","cses/go/mattermost":"mattermost"}' \
GITNEXUS_AUTOPR_LIVE=1 GITNEXUS_PROVIDER=gitlab \
GITLAB_API_BASE=http://git.yundiz.com/api/v4 \
JAEGER_QUERY_BASE=http://192.168.6.66:32281 \
PORT=3034 \
nohup npx tsx scripts/start-webhook-server.ts > /tmp/gnx-server.log 2>&1 &
```

未 push 到 remote。push 时机由用户决定。

---

## 15. 心法

> GitNexus 是 Agentic DevOps 闭环的"代码真相层"——别的层可以不准，**它必须确定**。
> 每一次改动先问：这会让 Agent 多一份能信任的硬约束，还是多一层概率猜测？

---

## 15.5 🔥 单开窗口接力 — MCP 桥接 (方案 A.2) 任务说明

**任务名**：把 webhook server 的 mock S2/S3/S4 替换成真索引数据（通过 HTTP 桥接全局 gitnexus）。

**为什么需要**：
- 全局 `gitnexus` 1.4.1 (KuzuDB) 已索引 cses-java (65k nodes) + mattermost (46k nodes)
- 本仓 src tree (lbug) 跟全局 schema 不通，webhook server 拿不到这份索引
- 当前 webhook server 在 S3-S5 返回 mock 数据 (`note: '业务仓未 GitNexus 索引'`)
- **MR diff 里 contractId 真实，但 blast radius / forensics 都是 stub**

**桥接架构**：
```
webhook server (本仓 lbug, port 3034)
   │ S2 resolveSpan / S3 apiBlastRadius / S4 forensics
   ▼ HTTP fetch
gitnexus eval-server (全局 1.4.1, port 4848)
   ▼
KuzuDB 真索引 (cses-java / mattermost)
```

**第一步**：启全局 eval-server
```bash
gitnexus eval-server --port 4848 &
# 探活
curl http://localhost:4848/api/heartbeat
```

**第二步**：写桥接模块 `gitnexus/scripts/mcp-bridge.ts` (~80 行)
```ts
const BASE = process.env.GITNEXUS_EVAL_BASE ?? 'http://localhost:4848';

export async function callImpact(target: string, repo: string, opts: { depth?: number; cross_depth?: number } = {}) {
  const r = await fetch(`${BASE}/api/impact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, repo, ...opts }),
  });
  return r.json();
}

export async function callCypher(query: string, repo: string) {
  const r = await fetch(`${BASE}/api/cypher`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, repo }),
  });
  return r.json();
}
```

**注意**：先 `curl http://localhost:4848/` 探一下 eval-server 实际的 API 路径（可能是 `/tool/impact` / `/api/impact` / `/mcp/tools/call`），路径不一定跟我写的一样。

**第三步**：改 `start-webhook-server.ts`，注入 deps 替换 mock：
```ts
import { callImpact, callCypher } from './mcp-bridge.js';

const REPO_BY_PATH: Record<string, string> = {
  'cses/java/cses/cses': 'cses-java',     // gitnexus list 里的本地 alias
  'cses/go/mattermost': 'mattermost',
};

const deps: OrchestratorDeps = {
  resolveSpan: async (span) => {
    const norm = normalizeJaegerSpan(span);
    const repo = REPO_BY_PATH[fullName] ?? 'cses-java';
    // 用 cypher 反查 Route → handler
    const r = await callCypher(
      `MATCH (rt:Route {name: '${norm.contractId}'})-[:HANDLES_ROUTE]-(m:Method) RETURN m.uid, m.filePath LIMIT 1`,
      repo,
    );
    if (r.rows?.[0]) {
      return { resolved: true, handler: { uid: r.rows[0]['m.uid'], filePath: r.rows[0]['m.filePath'] } };
    }
    // fallback: 用 contractId 当 UID
    return { resolved: true, handler: { uid: norm.contractId } };
  },
  apiBlastRadius: async (p) => callImpact(p.target_uid, REPO_BY_PATH[fullName], {
    depth: p.depth, cross_depth: p.cross_depth,
  }),
  // ... 其他 stage 类似
};
```

**第四步**：跑一次 e2e 验证 — 在 cses-java 建一个 issue，看评论里：
- ❌ 之前: `note: '业务仓未 GitNexus 索引'`
- ✅ 之后: `受影响文件: src/main/java/com/yundiz/真实文件路径.java`

**DOD**：
- [ ] eval-server 后台跑通 + 探活
- [ ] mcp-bridge.ts 写好 + 单测 (mock fetch)
- [ ] start-webhook-server.ts 替换 4 处 mock (S2 真 cypher / S3 真 impact)
- [ ] 在 cses-java 建 issue 跑 e2e
- [ ] MR diff 里 `.gitnexus/reports/auto-pr-issue-N.md` 含真业务文件路径
- [ ] 提 commit + tag `mvp/v1.2.0-bridge` (或类似)

**关键参考文档**：
- `docs/backlog/gitnexus-version-sync.md` — 完整背景 + 长期对齐路线
- `docs/multi-repo/quickstart.md` — 业务仓接入流程
- `gitnexus/scripts/start-webhook-server.ts` — 当前 mock deps 注入位置

**当前 server 状态（不要重启）**：
- PID: `cat /tmp/gnx-server.pid`
- 监听 0.0.0.0:3034
- LIVE 模式开着
- 你单开窗口跑 eval-server 不会冲突（不同端口）

### 15.5 实施落地 (2026-04-29, mvp/v1.2.0-bridge)

落地差异（跟 §15.5 草案不同的几处）：

1. **eval-server 实际 API 路径**：`POST /tool/{cypher,impact,context,query}` + `GET /health`（不是草案里假设的 `/api/impact`）。
2. **响应不是纯 JSON**：eval-server 回 `{json}\n---\nNext: <hint>` 拼接体, bridge 必须切掉 `\n---\n` 之后的 trailer 才能 `JSON.parse`。已修在 `mcp-bridge.callCypher`。
3. **`/tool/impact` 在 1.4.1 有 crash bug**：调一次让 server 死。bridge 改用 `/tool/cypher` 走 `MATCH (m:Method {name})<-[*1..N]-(caller)` 自己算 blast radius（关系表只有 `CodeRelation` 一种）。
4. **cses-java 1.4.1 schema 没有 `Route` 节点**：草案里的 `MATCH (rt:Route)-[:HANDLES_ROUTE]-(m:Method)` 跑不通。改用 `Method.name + filePath/className` 三层 fallback 反查（`mcp-bridge.resolveHandler`）。
5. **Method id 真格式**：`Method:<filePath>:<name>:<startLine>`（不是 UID 风格的 `Method:Symbol_xxx`）。
6. **验证**：`scripts/smoke-bridge.ts` 不依赖 webhook 重启，直接命中 fixture #1 — 真 `TaskMemberReader.java:93` + 25 个真业务 caller 文件。

剩余的"在 cses-java 建 issue 看 MR 报告"DOD 需要重启 webhook server 用上新 deps（保持原 LIVE 模式 env）：

```bash
# 老 server 含 LIVE secrets，stop 时记得保留
GITNEXUS_GITLAB_SECRET=<原值>  GITNEXUS_AUTOPR_TOKEN=<原值>  \
GITNEXUS_AUTOPR_LIVE=1  GITNEXUS_PROVIDER=gitlab  \
JAEGER_QUERY_BASE=http://192.168.6.66:32281  \
GITNEXUS_BRIDGE_REPO=cses-java  \
npx tsx scripts/start-webhook-server.ts
```

启动会打印 `bridge ✅ eval-server 通` 行；以后 issue 触发的 pipeline S2/S3/S5 自动走 bridge。

---

## 16. 给新会话的开场白（粘贴用 — cross-repo/v1.0.0 后, 2026-04-29 起）

复制粘贴这段给新会话开第一句（10 分钟读完上下文）：

> 我接力上一个会话，做**跨仓 Agentic DevOps v1.1**（cross-repo/v1.1.x，多 service preview + 严格 LIVE 闸）。
>
> **cross-repo/v1.0.0 已稳**：tag 落地，5 次真跑（issue#26~#30 → MR!31~!34），D-1~D-6+D-9 全实现，D-7 P1 group reindex 已 e2e 验证（cses-java push → mattermost 自动 reindex 715ms）。
>
> **必读**:
> 1. [`/CLAUDE.md`](CLAUDE.md) §⚓ 主航道 — 守轨规则
> 2. [`docs/learn/跨仓-Agentic-DevOps-闭环-真跑通-SOP.md`](docs/learn/跨仓-Agentic-DevOps-闭环-真跑通-SOP.md) — 跨仓 v1.0.0 SOP 9 节
> 3. [`docs/backlog/cross-repo-v1.1-multi-service-preview.md`](docs/backlog/cross-repo-v1.1-multi-service-preview.md) — v1.1 计划
>
> **下一步候选**：D-4/D-8（K8s 多 service preview + 严格 LIVE 闸）/ lbug 切原生（task #14）/ GitHub 平台跨仓回归 / 真发场景找一个跨仓 partner MR 触发的 trace.

— 老接力清单（cross-repo/v1.0.0 之前）保留如下供历史参考：

> 我接力上一个会话，做**跨仓 Agentic DevOps**（cross-repo/v1.0.0）— **此版本已落地, 见上**。
>
> **单仓闭环已稳**：`single-repo/v1.0.3` tag 落地，5 次真跑（issue#21~#25 → MR!25~!30），LLM 真改 Java 代码 + 真断言，每次 ~$1.1 / 4 分钟。最后一次 issue#25 → MR!30 ([URL](http://git.yundiz.com/cses/java/cses/cses/-/merge_requests/30))。
>
> **必读三篇**（10 分钟）：
> 1. [`/CLAUDE.md`](CLAUDE.md) §⚓ 主航道 — 守轨规则 + 7 条偏轨道清单
> 2. [`docs/learn/全流程演示-issue到真改代码.md`](docs/learn/全流程演示-issue到真改代码.md) §0 TL;DR + §3 实跑剖析
> 3. [`docs/learn/跨仓-Agentic-DevOps-roadmap.md`](docs/learn/跨仓-Agentic-DevOps-roadmap.md) — 9 个缺口 D-1..D-9 + Phase 1-6 路径
>
> **第一刀 = 0 周 spike**（不动生产）：实测 `gitnexus group --help` / `group add --help` 真签名，gitnexus-dev agent 知识库训练于 2026-04-26 可能漂，roadmap 文档里 D-1 段的 CLI 命令必须现场验。把真签名回填进 roadmap 再开 Phase 1。
>
> **现成可用素材**:
> - eval-server :4848 已索引 19 仓，含 `cses-java` / `mattermost` / `clawlive` (TS) / `clawlive-api` (Java Spring)
> - webhook server PID `cat /tmp/gnx-server.pid` 跑 v1.0.3，多仓 token map / bridge repo map / repo path map 都通
> - 跨仓 demo 拓扑可用 cses-java↔mattermost (yundiz 内网 GitLab) 或 clawlive↔clawlive-api (GitHub 公开, 但 GitHub e2e 需公网中转, 留 backlog)
>
> **不要做的事**（守轨）:
> - 不要直接照 roadmap §2 D-1 的 CLI 跑（agent review 抓出 4 个 CRITICAL CLI 命令幻觉）
> - 不要碰 ns 前缀守门（K8s `gitnexus-preview-*` 强制）
> - 不要绕 R-12 / R-14 安全闸
> - 不要新增 stage 改 OrchestratorDeps 接口（mock + 真两路对称）
>
> 用户接下来希望 [X]。

[X] 候选（按推荐顺序）：
- **Phase 0 spike**：实测 group CLI + 在 staging 跑通 `bridge.lbug` 生成（推荐第一刀）
- **Phase 1 D-1**：拿到 spike 输出后接入 group analyze + bridge.lbug 查询
- **Phase 2 D-2/D-3**：S3 跨仓 BFS + S4 跨仓 git log
- **GitHub 平台 e2e**：clawlive-api 仓做 GitHub webhook 全流程（需 GitHub PAT + ngrok 公网中转）
- **M-1 类型治理**：orchestrator 内 `as any` 集中点（独立 PR，不阻塞跨仓）

---

## 17. 🚀 新仓 / 跨仓 group 接入快速指南

### A. 单仓接入（5 分钟）

**前提**：你已经知道仓 URL + 可拉的 token。

```bash
# 1. clone + index 仓 (让 GitNexus 算 blast radius / 建 contract registry)
cd /Users/mac28/workspace/java/zlc_ai/GitNexus/gitnexus
gitnexus analyze --path /path/to/your/repo
# 或者用 URL 自动 clone
gitnexus analyze --url http://git.yundiz.com/owner/repo.git

# 2. 启动 GitNexus 服务（含 webhook + MCP）
export GITNEXUS_GITLAB_SECRET=<webhook 密码>           # 你自定义
export GITNEXUS_AUTOPR_TOKEN=<gitlab PAT>              # contents:write
export GITNEXUS_PROVIDER=gitlab
export GITLAB_API_BASE=http://git.yundiz.com/api/v4    # 内网用
export JAEGER_QUERY_BASE=http://192.168.6.66:32281     # /observe 触发用
gitnexus serve --port 8080 --host 0.0.0.0

# 3. 仓库 Settings → Webhooks 添加
#    URL: http://<server-ip>:8080/webhook/gitlab
#    Secret token: 同 GITNEXUS_GITLAB_SECRET
#    Events: 勾 Issues + Push + Merge requests
#    SSL verification: 看你 server 协议

# 4. 让 /observe 自动建 issue (body 嵌 metadata 块)
#    见 §17.D 模板
```

**验证**：往该仓建一个测试 issue（body 含 metadata），看是否自动出 GitNexus 评论 + dryRun PR/MR。

### B. 跨仓 group 接入（GitNexus 招牌能力）

**用途**：A 仓改了 API contract → 自动算 B 仓 / C 仓被影响的 handler；S3 `api_blast_radius` 走 `cross_depth>=1` 跨仓 BFS。

```bash
# 1. 创建 group 目录 + 注册多个仓
gitnexus group create --name yundiz-prod
gitnexus group add --group yundiz-prod --repo /path/to/repo-A
gitnexus group add --group yundiz-prod --repo /path/to/repo-B
gitnexus group add --group yundiz-prod --repo /path/to/repo-C

# 2. 一次性 group analyze（自动建跨仓 contract registry + bridge.lbug）
gitnexus group analyze --group yundiz-prod
# 这一步会:
#   · 索引每个仓的 Route / RPCMethod / TopicProducer / SQLTable 节点
#   · 收集成 group 级 contract-registry/contracts.csv
#   · 建立 bridge.lbug 跨仓边 (HTTP route ↔ HTTP consumer / proto / Kafka topic / SQL table)

# 3. 跨仓 blast radius 查询验证
gitnexus mcp --tool api_blast_radius --params '{
  "target_uid": "Method:OrderService.createOrder",
  "direction": "both",
  "depth": 2,
  "cross_depth": 1
}'
# 期望返回里 cross[] 字段含其他仓被影响的 handler

# 4. webhook 配置：每个仓单独配 webhook → 同一个 server
#    不同仓互相之间的影响通过 group bridge 算
```

**Group 工作原理**（一句话）：每个仓 push → P1 自动 reindex → contract-registry 重算 → bridge.lbug 自动更新 → 下次 `api_blast_radius` 命中真跨仓边。

### C. 三平台 webhook 配置速查（同一 server 可并存）

| 平台 | 路由 | 鉴权头 | 鉴权模式 | env 变量 |
|---|---|---|---|---|
| GitHub | `/webhook/github` | `X-Hub-Signature-256: sha256=...` | HMAC sha256 | `GITNEXUS_WEBHOOK_SECRET` |
| GitLab | `/webhook/gitlab` | `X-Gitlab-Token: <secret>` | 明文 | `GITNEXUS_GITLAB_SECRET` |
| Gitee | `/webhook/gitee` | `X-Gitee-Token: <secret>` | 明文（"密码"模式）| `GITNEXUS_GITEE_SECRET` |

**最少配置** — 只用某一个平台：只设它的 secret + provider env 即可，其他路由 404 不挂。

### D. /observe 建 issue 的 metadata 块模板

issue body 必须含 `<!-- gitnexus:trace --> ... <!-- /gitnexus:trace -->` 块。
**最简版（让 jaeger-fetcher 自动拉 spans）**：

```markdown
## 巡检告警

<!-- gitnexus:trace -->
{
  "repo": "owner/your-repo",
  "baseBranch": "main",
  "traceUrl": "http://192.168.6.66:32281/trace/<traceId>"
}
<!-- /gitnexus:trace -->
```

**完整版（带 S6 真 K8s 验证）**：

```markdown
<!-- gitnexus:trace -->
{
  "repo": "owner/repo",
  "baseBranch": "main",
  "traceUrl": "http://192.168.6.66:32281/trace/<traceId>",
  "serviceImage": "harbor.jinqidongli.com/x9-java/cses-server:1.3.20",
  "testImage": "harbor.jinqidongli.com/x9-java/cses-test:1.3.20",
  "testCommand": ["sh", "-c", "java -jar /test.jar"]
}
<!-- /gitnexus:trace -->
```

**字段表**：

| 字段 | 必需 | 说明 |
|---|---|---|
| `repo` | ✅ | `owner/repo`，自动 PR/MR 目标 |
| `baseBranch` | ⚪ | 默认 `main` |
| `spans` | A/B 二选一 | 直接传 Jaeger spans 数组（不依赖 Jaeger 在线）|
| `traceUrl` | A/B 二选一 | Jaeger 链路 URL；fetcher 自动拉 spans（需 `JAEGER_QUERY_BASE` env）|
| `serviceImage` | ⚪ | 提供则触发 S6 真 K8s 验证；省略 S6 skip |
| `testImage` | ⚪ | 默认与 serviceImage 一致 |
| `testCommand` | 跟 serviceImage 配对 | sh -c 输出 `===JUNIT-XML=== ... ===END-JUNIT-XML===` 包夹 XML |

### E. 默认安全闸（你不需要任何额外配置就生效）

| 闸 | 行为 |
|---|---|
| `dryRun` 默认 true | issue 没 `gitnexus:auto-pr-live` 标签 → 永远不真发 PR/MR |
| `require_stage6_pass` | S6 没绿勾 → 自动拒绝创建 PR + 评论解释（即使 live 标签在）|
| auto-pr-policy 默认 | 自动 block `.github/workflows/**` / `.env*` / `.pem` / `.key` / `secrets/**` |
| patch-llm systemPrompt | 硬编码不允许动 workflow / 凭证 / 引入新依赖 |
| ns 前缀守门 | 所有 K8s 写操作必须命中 `gitnexus-preview-*` ns，否则代码层抛错 |

### F. 真发 live PR/MR 的双因子开关

```bash
export GITNEXUS_AUTOPR_LIVE=1
# 同时 issue 上加 'gitnexus:auto-pr-live' 标签
# 还需要 S6 真给绿勾 (require_stage6_pass)
```

三个条件**同时满足**才会真发。少一个都不会上生产副作用。

---

## 18. Jaeger 真接入 (2026-04-29 落地, e2e/v0.3.0-real-jaeger)

### 18.1 一行配置启用

```bash
export JAEGER_QUERY_BASE=http://192.168.6.66:32281    # 你的 jaeger query NodePort
```

issue body 给 `traceUrl` (不必嵌 spans)，pipeline 自动 `GET /api/traces/<id>` 拉真 spans。

### 18.2 Jaeger Query API 兼容性

`jaeger-fetcher.ts` 走 HTTP Query API：
- `GET /api/traces/<traceId>` → `{ data: [{ spans: [...] }] }`
- 兼容 Jaeger v1 / v2 (OTel collector distribution，jaeger_query 扩展)

### 18.3 真验证产物

| 项 | 值 |
|---|---|
| 拉的 trace | `291393efa15b1778` (mattermost) |
| 真 spans 数 | **8** |
| Phase 0 normalize 真产出 | `kind=http`, `contractId=http::POST::/api/cses/posts/create` |
| issue | http://git.yundiz.com/zhanglichao/devops-test-backend/-/issues/7 |
| comment | `#note_706`（评论里含完整 7 阶段 markdown 报告）|
| 端到端耗时 | 129.8s |

### 18.4 业务仓 GitNexus 索引前的限制

S2 normalize 真接，但 **handler UID 反查**仍兜底（用 contractId 当 UID）。
要让 S3-S5 真跑必须：

```bash
gitnexus analyze --url <业务仓>     # 让 GitNexus 索引业务仓代码
```

之后 `resolveSpanToHandler` 才能从 `Route` 节点反查到真实 `Method:XxxController.xxx` UID，
`api_blast_radius` 才能真算业务仓内部影响 + 跨仓 contract 影响，
`regression_forensics` 才能从真实 git log 找嫌疑 commit。

业务仓索引一次后，整条链路 100% 真跑。
