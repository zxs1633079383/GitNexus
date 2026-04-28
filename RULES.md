# Agentic DevOps Roadmap 自律守则

> **作用域**：本文件**仅约束**与 `docs/learn/Agentic-DevOps-企业版路线图-v2.md` 相关的贡献（Phase 0 / Stage 2-7 / Pipeline Orchestrator / 配套 mermaid）。
> **不替代**仓库已有的 `AGENTS.md` / `GUARDRAILS.md` / `CLAUDE.md` / `CONTRIBUTING.md`——通用 GitNexus 贡献以那几份为准。
> 偏离前必须在 PR 描述里写明：原因 + 与哪条 §X 冲突 + 如何处理。
> 配套接力文档：`session.md`（同根目录）。

---

## 0. 顶层约束（不可商量）

### 0.1 7 阶段闭环不偏离

- 主链路只能是 §0.2 的 7 阶段 + precondition (P1) + 横切 (Orchestrator)
- **新增任何 stage 必须先改文档过 review**，不能私自加
- 加 stage 是扩展，**不是替换**（保持 1-7 backward compat）

### 0.2 Stage 3（GitNexus blast radius）是 anchor

- `impact()` + contract registry 是闭环可信任性的根
- 任何"为快速实现暂时跳过 Stage 3"的提议必须打回
- 触碰 Stage 3 的 PR 必须有 `gitnexus-dev` agent review

### 0.3 业务零侵入

- 所有 Stage 都不能要求业务代码改动
- OTel auto-instrument / Jaeger 标准字段 / git 标准命令是允许的依赖
- 如果某 Stage 需要业务侧加 attribute / 标签 / SDK call，**必须改方案**

### 0.4 LLM 边界

- LLM 只在 **query-time** 调用（test-gen / wiki / patch generation）
- LLM **绝不**进入 index-time（摄入管线 12 阶段）
- 文件头加 `// query-only — must not be called from any pipeline phase`
- CI lint 禁止从 `core/ingestion/**` import `core/test-gen/**` / `core/wiki/**`

---

## 1. 实现纪律

### 1.1 确定性 vs 概率分层

| Stage | 必须确定性 | 允许概率 |
|---|---|---|
| 1 观测 | Jaeger trace / Prom 指标 | — |
| 2 锚点 | Route lookup / stacktrace 反查 | — |
| 3 爆炸 | GitNexus 图 + impact BFS | — |
| 4 溯源 | git log + 文件路径过滤 | — |
| 5 生成 | 调用链结构骨架 + TODO 占位 | LLM 填 fixture 值域 |
| 6 执行 | test pass/fail 二元 | — |
| 7 回写 | git revert / patch apply | LLM 生 patch 内容 |

**Stage 6 不允许"likely fail"**——验证结果必须二元。

### 1.2 fixture 期望降低（R-1）

- `integration-gen` **只**生成"调用链结构骨架 + TODO 注释占位"
- DB seed / 微服务 mock schema / 业务值域 留给开发者补
- Stage 6 验证目标 = "调用链能不能通"，**不是**"业务正确性"

---

## 2. 安全栅栏（红线）

### 2.1 GitHub App 权限分割（R-4）

- **App-1（PR Review Bot）**：read-only（`pull_requests:write` 仅评论用）
- **App-2（Auto-PR）**：`contents:write`，**绝不**加 `workflows:write`
- 任何想给单个 App 加更多权限的 PR 直接打回

### 2.2 自动 PR 不允许 auto-merge

- 必须 `draft: true` + label `auto-generated`
- 必须经 P0 PR Review Bot review
- 必须真人手动 ready-for-review + merge
- per-repo `.gitnexus/auto-pr-policy.yaml` 必填字段：
  ```yaml
  auto_pr:
    enabled: true
    allowed_paths: ["src/", "lib/"]
    blocked_paths: ["src/config/"]
    max_revert_diff_lines: 200
    max_patch_diff_lines: 100
    require_stage6_pass: true
    blocked_file_extensions:
      - ".env"
      - ".pem"
      - ".key"
      - ".github/workflows/**"
  ```

### 2.3 Destructive 操作前必须验证

- Stage 7 revert 前先 `git log <hash>^..<hash>` 验证可达
- diff 行数超 `max_revert_diff_lines` 自动降级 Patch
- preview env 销毁前先 dump 日志到 forensics 报告
- on-demand build 必须在隔离 namespace 跑（不污染主 registry）

---

## 3. 评审纪律

### 3.1 双层 review 强制

- `gitnexus-knowledge` skill：事实校对（行号、API 现状）
- `gitnexus-dev` agent：独立可行性评审
- 高风险项必须文档留痕（§2.2 + §2.3 表格）

### 3.2 不允许"先实现再补文档"

```
改方案 → 改文档 → review → 实现 → 跑评审
```

顺序固定，不能颠倒。

### 3.3 Commit message 必须引用 R-X

- 修 review 抓出的问题，commit message 引用具体 R-X 编号
- 例：`fix(stage-7): R-5 加 squash merge revert 前置 diff 检查`
- 否则不允许 merge

### 3.4 路线图变更走 PR review

- 任何 `docs/Agentic-DevOps-企业版路线图-v2.md` 改动必须开 PR
- PR 必须 @ 至少一名 gitnexus 维护者
- mermaid 流程图改动必须同步更新 `.mmd` 文件

---

## 4. 状态管理

### 4.1 Session 日志

- 每次有重大决策的 session 写 `session-YYYY-MM-DD.md`
- 内容：目标 / 产出 / 决策 / 待拍板 / 下一步
- 不重复 roadmap 内容

### 4.2 待拍板事项不动手

| 未拍板项 | 锁定的 Stage |
|---|---|
| R-2 镜像 GC 策略 | Stage 6 |
| R-3 MCP 异步 job 模式 | Stage 6 (`validate_in_preview` MCP tool) |
| R-4 GitHub App 拆分 | Stage 7 |

**未拍板的 Stage 不能开工**——除非用户明确改写本文件。

---

## 5. 优先级红线

按 §2.1 关键路径**串行**：

```
pre P1 → Stage 2 Phase 0 → Stage 3 wrap → Stage 4 P5
       → Stage 5 P4 → Stage 6 K8s → Stage 7 Auto-PR
       → 横切 Orchestrator
```

并行可同时开 P2 / P6 / P3，**不能挤占主链路资源**。

### 5.1 第一刀必须是 Phase 0

- Phase 0（Stage 2）是唯一**不依赖 R-2/R-3/R-4** 的关键路径功能
- 第一个 PR 必须是 Phase 0 + 真实 trace fixture
- 跑通后再决定下一刀

### 5.2 stop-the-line 触发条件

发生以下任一，**立即停手**反馈用户：

1. 实现需要 §0 顶层约束的妥协
2. 评审抓到新的高风险（>= R-2/R-3/R-4 同级别）
3. 7 阶段中任一 Stage 实际工时 > 文档估算 2x
4. 真实 trace fixture 跑不通

---

## 6. 偏离申请流程

如果遇到**确实需要偏离 roadmap** 的场景：

1. 在对应 PR 描述里加 `## ROADMAP DEVIATION` 章节
2. 写明：哪条 §X 冲突 / 为什么必须偏离 / 修正方案
3. @ gitnexus 核心维护者
4. 同步开 PR 改 `docs/Agentic-DevOps-企业版路线图-v2.md` + `RULES.md`
5. 两个 PR **同时 merge**，不允许只 merge 实现不更文档

---

## 7. 自检清单（每次 PR 提交前过一遍）

- [ ] 这次改动属于哪个 Stage / 哪个 R-X 修正？
- [ ] 是否触碰 Stage 3 anchor？如是，已 cc gitnexus-dev review？
- [ ] 是否引入 LLM 调用？如是，是否在 query-time？文件头加注释了吗？
- [ ] 是否需要业务侧改动？如是，已改方案？
- [ ] 是否触碰 GitHub App 权限？如是，遵守 §2.1 拆分原则？
- [ ] 是否触发 destructive 操作？如是，加了前置验证？
- [ ] commit message 引用了 R-X 编号？
- [ ] roadmap 文档同步更新了？
- [ ] mermaid 图同步更新了？

---

> **最后一句心法**：GitNexus 是 Agentic DevOps 闭环的"代码真相层"——别的层可以不准，**它必须确定**。
> 每一次改动都先问一句：这会让 Agent 多一份能信任的硬约束，还是多一层概率猜测？
