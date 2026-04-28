# Session 接力文档 — 新 Claude 会话直接续上

> **写给下一个 Claude 会话**：读完本文 + `RULES.md` + roadmap §0-§2，就能直接动手做所有功能。
> 本文不重复 roadmap 内容，只提供"去哪读 + 现在做什么 + 怎么做 + DOD"。
> 最后更新：2026-04-28

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

## 12. ✅ 接力检查清单（新会话第一件事）

按顺序过：

- [ ] 读完本 session.md
- [ ] 读 RULES.md 全文
- [ ] 读 roadmap 主文档 §0-§2
- [ ] 跳读 §3.1 Phase 0 详细方案（如要做 Phase 0）
- [ ] 确认当前分支：`git -C /Users/mac28/workspace/java/zlc_ai/GitNexus branch --show-current` = `docs/agentic-devops-roadmap-v2`
- [ ] 确认 git status clean
- [ ] 确认 `/tmp/jaeger-trace.json` 仍在；不在则用 §10 的 curl 重新拉
- [ ] 开 `feat/jaeger-span-normalizer` 子分支
- [ ] 第一刀：写 `gitnexus/src/core/observability/jaeger-span-types.ts`

---

## 13. 状态总览

```
✅ 路线图 v2（770 行，2 轮 review 全过）
✅ Mermaid 可视化（双仓副本）
✅ session.md（本文）
✅ RULES.md（205 行自律守则）
✅ 真实 trace fixture（/tmp/jaeger-trace.json）
─────────────────────────────────────────
🟡 待用户拍板：R-2 / R-3 / R-4（锁 Stage 6/7）
🟢 立即可开工：Phase 0（Stage 2）— 不依赖任何待拍板
🟢 立即可开工：P2 / P6 / P3（并行线，不抢主链路）
```

---

## 14. Git 历史（路线图分支 6 commits）

```
b2d0f9d7  docs(roadmap): 合入 Stage 5/6/7 第二轮 review 修正
d9e6af3a  docs(roadmap): §0.2 加 mermaid 7 阶段闭环可视化
83d9a8e6  docs(roadmap): 重构为 7 阶段 Agentic DevOps 闭环（团队自建版）
3031f670  docs(roadmap): §0.2 重画为 /observe 触发的全自动管线
1966c12d  docs(roadmap): 修正 §0.2 闭环图聚焦运行时侧
8415cde5  docs(roadmap): 新增 Agentic DevOps 企业版路线图 v2
```

未 push 到 remote。push 时机由用户决定。

---

## 15. 心法

> GitNexus 是 Agentic DevOps 闭环的"代码真相层"——别的层可以不准，**它必须确定**。
> 每一次改动先问：这会让 Agent 多一份能信任的硬约束，还是多一层概率猜测？

---

## 16. 给新会话的开场白（粘贴用）

第一句对话建议这样开：

> 我接力上一个会话，目标是完成"团队自建版 GitNexus 企业版"7 阶段 Agentic DevOps 闭环。
> 我已经读完 `/Users/mac28/workspace/java/zlc_ai/GitNexus/session.md` 和 `RULES.md`，
> 知道当前在 `docs/agentic-devops-roadmap-v2` 分支，第一刀是 Phase 0。
> 用户接下来希望 [X]。

把 [X] 替换成：
- "我直接开始 Phase 0" 或
- "我先拍板 R-2/R-3/R-4" 或
- "我开始 P2 并行线" 或
- 其他具体动作
