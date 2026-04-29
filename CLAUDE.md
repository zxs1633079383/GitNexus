<!-- version: 1.4.0 -->
<!--
  Metadata: version, last reviewed, scope, model policy, reference docs, changelog.
  Last updated: 2026-04-29 — 加 Agentic DevOps 7 阶段闭环守轨
-->

Last reviewed: 2026-04-29

## ⚓ 主航道 — Agentic DevOps 7 阶段闭环 (绝对不偏离)

> 本仓的**核心目标**：把"线上出错"到"自动开 PR 修复"串成一条 7 阶段闭环。
> **任何代码改动如果不能落到下面这张图的某条边上，必须先停下来问用户，不要擅自动手。**

```
┌──────────┐  webhook    ┌──────────────┐ 索引最新?  ┌─────┐ symbol  ┌─────┐ blast
│ /observe ├──issue─────►│ pre · P1     │───────────►│ S2  ├────────►│ S3  ├────►
│ +Jaeger  │ traceId+    │ Auto-reindex │            │锚点 │ UID     │爆炸 │
│ +Prom    │ service     │ Webhook      │            │     │         │     │
└──────────┘             └──────────────┘            └─────┘         └──┬──┘
                                                                        │
   ┌────────────────────────────────────────────────────────────────────┘
   │ 受影响范围(40+真业务文件) + 嫌疑 commit + handler 源码
   ▼
┌─────┐ git ∩ blast ┌─────┐ test 文件   ┌─────┐ K8s preview ┌─────┐ Auto-PR/MR
│ S4  ├────────────►│ S5  ├────────────►│ S6  ├────────────►│ S7  ├──────────►(LOOP)
│溯源 │ 嫌疑 commit │生成 │ unit+contract│执行 │ 注入候选+   │回写 │ Revert/
│     │ Top 3       │     │ +integration │     │ 跑 test     │     │ Patch/Hotfix
└─────┘             └─────┘              └─────┘             └─────┘
                              ▲                                  │
                              └──────────── 🎼 ORCH ─────────────┘
                                       Pipeline Orchestrator
                                       (串联 + 失败兜底 + 评论分发)
```

视觉总览源文件：[`docs/learn/diagrams/16-agentic-devops-7-stage-loop.mmd`](docs/learn/diagrams/16-agentic-devops-7-stage-loop.mmd)
完整路线图：[`docs/learn/Agentic-DevOps-企业版路线图-v2.md`](docs/learn/Agentic-DevOps-企业版路线图-v2.md)

### 7 阶段含义（每个阶段都有明确 boundary，写代码先对号入座）

| Stage | 名称 | 唯一职责 | 落地组件 |
|---|---|---|---|
| pre | 索引保鲜 | 校验目标仓 last commit vs 索引快照, stale → reindex | `core/server/webhook/*` (HMAC + dedup) |
| **S1** | **观测** | Jaeger / Prom 巡检, 发现 error → 建 issue (外部驱动) | `/observe` skill |
| **S2** | **锚点** | trace span → handler symbol UID (Jaeger/OTel 双格式 + 5 层 fallback + stacktrace) | `core/observability/jaeger-span-normalizer.ts` |
| **S3** | **爆炸** | impact(handler, depth=2, crossDepth=1) → 受影响文件集 | `core/group/cross-impact.ts` + `mcp-bridge.blastRadius` |
| **S4** | **溯源** | git log ∩ blast radius → 嫌疑提交 Top 3 (handler-file 过滤防误报) | `core/observability/regression-forensics.ts` (mock 待实) |
| **S5** | **生成** | 三层 test (unit + contract + integration), R-1 现 scaffold + TODO | `core/test-gen/*` + claude-cli (待接) |
| **S6** | **执行** | K8s preview env (ns 必须 `gitnexus-preview-*`) + 跑 test → JUnit XML | `core/preview/preview-job-manager.ts` |
| **S7** | **回写** | Auto-PR/MR (Revert / Patch / Hotfix), 三平台 + dryRun 默认 + R-12 policy | `core/auto-pr/*` (含未接的 `patch-llm.ts`) |

### 主要组件位置（写代码先看是否有现成的）

- **Pipeline Orchestrator** — `gitnexus/src/core/pipeline/orchestrator.ts` (串 S2-S7 + buildPRBody + buildAutoPRReportFile)
- **OrchestratorDeps** — `gitnexus/src/core/pipeline/types.ts` (依赖注入 surface, mock/真都从这里走)
- **MCP Bridge** — `gitnexus/scripts/mcp-bridge.ts` (HTTP fetch 全局 `gitnexus eval-server` 桥接 KuzuDB 索引)
- **Webhook Server (cses-pre)** — `gitnexus/scripts/start-webhook-server.ts` (生产入口, LIVE 模式 + token map + bridge repo map)
- **Patch LLM (LIVE 真接)** — `gitnexus/scripts/patch-runner.ts` (调本机 `claude -p` 出真补丁 + 真断言, R-14 systemPrompt 隔离 + R-14 黑名单 `violatesSafetyPolicy` 二次门)

### 偏轨道 = 必须停下来问

下面这些事**做之前必须先问用户**:

1. **新增 Stage 或绕过 Orchestrator**: 7 阶段是闭环的骨架, 不能擅自拓成 8 段或并行新流
2. **改 OrchestratorDeps 接口签名**: 会破坏 mock + 真两条路径的对称, 需要全链路同步
3. **碰生产 namespace** (cses / postgres-cses / jaeger-cses 等): 任何 K8s 写操作只允许打到 `gitnexus-preview-*` (`core/preview/k8s-client.ts:assertNsAllowed` 强制)
4. **改 R-12 auto-pr policy 的 block 列表** (`.github/workflows/**` / `.env*` / `.pem` / `.key` / `secrets/**`): 这是安全闸最后一道
5. **绕过 dryRun 默认**: 真发 MR/PR 必须**三个条件全满足** — issue label `gitnexus:auto-pr-live` + env `GITNEXUS_AUTOPR_LIVE=1` + S6 真绿勾
6. **大版本升级 GitNexus binary** (1.4.x → 2.x) 或切 KuzuDB schema: 见 `docs/backlog/gitnexus-version-sync.md`
7. **新增 LLM 调用点**: 必须用 `core/wiki/llm-client.ts` 同款 retry + R-18 隔离 pattern, 系统 prompt 必须有 R-14 安全约束 (不动 .github / .env / 凭证 / 不引新依赖)

### 不偏轨道的标志（自检清单）

- [ ] 新代码能映射到上图 S1-S7 中某条边
- [ ] 改 deps 时 mock 和真两条路径都跟着改
- [ ] 测试在 `gitnexus-preview-*` ns, 没碰其他 ns
- [ ] 真发 PR/MR 前 R-12 policy 过了 (block 列表 grep 一遍)
- [ ] dryRun 默认是关掉的, LIVE 触发条件齐
- [ ] 改 LLM prompt 的话, R-14 安全约束没被改弱
- [ ] commit message Conventional Commits + 中文 + 引 R-X 编号

### 当前进度 (2026-04-29)

- ✅ MVP v1.0.0 / v1.1.0 — 7 阶段全实现, 真 Jaeger e2e 跑通
- ✅ MVP v1.2.0-bridge / .1 — webhook S2/S3 走真索引 (eval-server cypher), 多仓 token + bridge repo 路由
- ✅ e2e/v0.4.0-live-bridge — issue#18 → MR!24, 全 7 阶段 LIVE 闭环 (S6 K8s preview pass + S7 真发)
- ✅ LIVE 真接: `scripts/patch-runner.ts` 接 `claude -p` (LIVE issue#22 → MR!27, 真改 Java 代码 + 真断言)
- 🟡 待接: S4 forensics 真 git log (现返 `suspects: []`)
- 🟡 待接: S5 LLM 生成真断言 (现 R-1 主动选 scaffold + TODO, 避幻觉)



**Project:** GitNexus · **Environment:** dev · **Maintainer:** repository maintainers (see GitHub)

Follow **AGENTS.md** for the canonical rules; this file adds Claude Code–specific deltas. Cursor-specific notes live only in `AGENTS.md`.

## Scope

See the **Scope** table in [AGENTS.md](AGENTS.md) for read/write/execute/off-limits boundaries. Cursor-specific workflow notes also live only in AGENTS.md.

## Model Configuration

- **Primary:** Pin per **Claude Code** / Anthropic org policy (explicit model id). Do not rely on an unversioned `latest` alias for governed workflows.
- **Fallback:** As configured in Claude Code (organization default or user override).
- **Notes:** The GitNexus CLI analyzer does not call an LLM.

## Execution Sequence (complex tasks)

Same discipline as [AGENTS.md](AGENTS.md): before large multi-step work, state which **AGENTS.md** / **GUARDRAILS.md** rules apply, current **Scope**, and planned validation commands (`npm test`, `tsc`, etc.). When pausing, summarize progress in the chat or a **local** scratch file (do not add `HANDOFF.md` to the repo), then `/clear` and resume with that summary.

## Claude Code hooks

Prefer **PreToolUse** hooks for hard gates (e.g. tests before `git_commit`). Adapt hook commands to `gitnexus/` npm scripts.

## Context budget

If always-on instructions grow, load deep conventions via conditional reads (e.g. *“When writing new code, read STANDARDS.md”*) instead of pasting long blocks here. In Cursor, prefer `.cursor/index.mdc` plus optional `.cursor/rules/*.mdc` globs (see [AGENTS.md](AGENTS.md) § Context budget).

## Reference Documentation

- **This repository:** [AGENTS.md](AGENTS.md) (Cursor + monorepo notes), [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), [GUARDRAILS.md](GUARDRAILS.md).
- **Call-resolution DAG:** See ARCHITECTURE.md § Call-Resolution DAG. Shared pipeline code in `gitnexus/src/core/ingestion/` must not name languages — use `LanguageProvider` hooks instead (see AGENTS.md).
- **GitNexus:** `.claude/skills/gitnexus/`; MCP and indexed-repo rules live only in [AGENTS.md](AGENTS.md) (`gitnexus:start` … `gitnexus:end`). See **GitNexus rules** below.

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-04-13 | 1.3.0 | Updated GitNexus index stats after DAG refactor. |
| 2026-03-24 | 1.2.0 | Removed duplicated gitnexus:start block and scope table; replaced with pointers to AGENTS.md. |
| 2026-03-23 | 1.1.0 | Updated agent instructions to match AGENTS.md. |
| 2026-03-22 | 1.0.0 | Added structured header and changelog. |

---

## GitNexus rules

See the `<!-- gitnexus:start --> … <!-- gitnexus:end -->` block in **[AGENTS.md](AGENTS.md)** for the canonical MCP tools, impact analysis rules, and index instructions.
