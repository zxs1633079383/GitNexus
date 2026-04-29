# 跨仓 Agentic DevOps · roadmap (v2.0.0 路线)

> 写于 2026-04-29，承接 `single-repo/v1.0.0` → `single-repo/v1.0.2`。
> 单仓闭环已经端到端真跑通（issue → S2-S7 → claude LLM 真改代码 → 真发 MR）；
> 这份文档说明**从单仓走到跨仓还差什么**。
> 配套：[`/CLAUDE.md`](../../CLAUDE.md) §⚓ 主航道 + [`docs/learn/单仓-Agentic-DevOps-闭环-真跑通-SOP.md`](单仓-Agentic-DevOps-闭环-真跑通-SOP.md)。

---

## 0. 一句话定位

**单仓**：A 仓改 → A 仓自己测 → A 仓 PR。我们已经做完。
**跨仓**：A 仓改 contract → 自动算 B/C 仓被影响的 handler → 在所有受影响仓各发 PR / 单 PR 跨仓改。这是 **GitNexus 招牌能力**（contract registry + bridge.lbug + cross_depth），团队自建版没碰过。

---

## 1. 当前位置盘点（single-repo/v1.0.2）

| 维度 | 单仓做到了什么 | 跨仓必须升级 |
|---|---|---|
| **索引保鲜 (P1)** | ✅ webhook trigger 真接 `gitnexus analyze` (push → fetch+pull → staleness check → spawn) | 🟡 多仓时按 group 一次重建; 还要算跨仓 contract registry diff |
| **S2 锚点** | ✅ 反查到真 `Method:<filePath>:<name>:<line>` UID | 🟢 不变 (单仓内的 trace 解析跟跨仓无关) |
| **S3 爆炸** | ✅ cypher walk fallback (CLI 0 impact 时启用) 拿真 caller 文件 | 🔴 **crossDepth>1 必须开通** + bridge.lbug 跨仓边查 |
| **S4 溯源** | ✅ git log -- <handler.filePath> 找 Top 3 + Top1 diff 喂 LLM | 🔴 跨仓时必须查"上游 contract 改动" 的 git log (不是 handler 的) |
| **S5 生成** | ✅ R-1 scaffold + LLM 真断言 | 🟡 跨仓测试可能要 stub mock 跨仓依赖 |
| **S6 执行** | ✅ K8s preview ns 跑 nginx + busybox JUnit | 🔴 跨仓时要起多个 service (provider + consumer 同 ns) 还是分 ns 互通 |
| **S7 回写** | ✅ MR 推 fixFiles + testFiles + diagnostic md (单 repo) | 🔴 跨仓 patch 要决策: 单 PR 跨仓 vs 多 PR 联动 (stack-PR / linked-PR) |
| **R-12 Policy** | ✅ allowed_paths / blocked_paths / 黑名单 5 类 | 🟡 跨仓 LLM 必须按 repo 的 policy 分别过 |
| **R-14 LLM 安全** | ✅ systemPrompt 隔离 + violatesSafetyPolicy 二次门 | 🟢 不变 (LLM 调用本身跟跨仓无关) |
| **三因子 LIVE 闸** | ✅ label + env + S6Pass | 🟡 跨仓时是否每个 repo 都要全闸? 还是 group-level? |

---

## 2. 关键缺口（从大到小）

### 🔴 D-1 · GitNexus group / contract registry 没接入

**当前**：本仓 webhook server 只看单 repo 的索引（cses-java），eval-server 也只暴露 cypher / impact 两个 tool。
**缺口**：
- `gitnexus group create / add / analyze` CLI 没在我们的 webhook 上下文走过
- bridge.lbug 没 build (跨仓 Contract + ContractLink 还没存在)
- bridge.meta.json 版本校验路径没接

**做什么**：
1. 起步：
   ```bash
   gitnexus group create --name yundiz-prod
   gitnexus group add --group yundiz-prod --repo /tmp/cses-pre/cses-java
   gitnexus group add --group yundiz-prod --repo /tmp/cses-pre/mattermost
   gitnexus group analyze --group yundiz-prod
   ```
2. 验证：`~/.gitnexus/groups/yundiz-prod/{contracts.json, bridge.lbug, bridge.meta.json}` 生成，且 BRIDGE_SCHEMA_VERSION=1。
3. eval-server 跑 group 模式（如果支持）；不支持就 bridge 桥需要直查 bridge.lbug。
4. 检 `contracts.json` 里 `cses-java` 的 provider routes 跟 `mattermost` 的 consumer fetches 有没有 exact 匹配（http POST /api/...）。

**风险**：1.4.1 的 group 子命令成熟度未知，可能要踩坑。先在 staging 仓试跑，别动生产。

### 🔴 D-2 · S3 跨仓 BFS 链路（cross_depth>1）

**当前**：`mcp-bridge.blastRadius` 只走单仓 cypher / `gitnexus impact` CLI。
**缺口**：
- `MAX_SUPPORTED_CROSS_DEPTH = 1` 是 GitNexus 1.4.1 硬上限（OSS 知识库确认）
- 我们的 bridge 没调过 `runGroupImpact`（`core/group/cross-impact.ts:304`）
- 跨仓 frontier 队列 + cycle 检测 + fan-out 限制都没实现

**做什么**：
1. 短期 (cross_depth=1, OSS 当前能力)：bridge 加 `crossBlastRadius` 函数，走 `gitnexus impact <name> -r <repo> --cross-depth 1` CLI 形式（或直接在 bridge 查 bridge.lbug 的 ContractLink）。
2. 长期 (cross_depth>1，roadmap)：要么等 GitNexus OSS 升级，要么本仓自己写 frontier-queue BFS（`core/group/cross-impact.ts:34` 那条 Cypher 是入口）。
3. 把 `BlastResult` 加 `crossLinks: { repo, uid, contractId, matchType, confidence }[]` 字段，让 PR body 显示跨仓影响。

**测试 case**：cses-java 改 `POST /api/cses/posts/create` → mattermost 应该出现"我是 consumer，受影响"的 link。

### 🔴 D-3 · S4 跨仓 forensics（上游 contract 改动溯源）

**当前**：S4 只在 handler 仓查 `git log -- <handler.filePath>`。
**缺口**：跨仓 bug 经常是 **上游 (B 仓) 改了 contract → 下游 (A 仓) 报错**。当前 S4 只看 A 仓的 git log，看不到根因（在 B 仓的 commit）。

**做什么**：
1. S4 dep 升级：拿到 S3 的 cross_links → 对每条 link 的 `provider.repo` 跑一次 git log
2. 把所有 repos 的近 50 commits 合并按时间排序 → Top 3 嫌疑（可能跨多个 repo）
3. genFix 收到 cross-repo suspectCommit 时，在 prompt 里说明 "可能要在 X 仓改"

**实现复杂度**：中。需要扩 OrchestratorDeps.regressionForensics 接口让它返多 repo suspects。

### 🟠 D-4 · S6 跨仓 Preview env 拓扑

**当前**：单仓单 service。`gitnexus-preview-<id>` ns 里只起一个 nginx + 一个 busybox 跑测试。
**缺口**：
- 跨仓场景 A 仓改了 contract 想测 → 必须把 A 仓的新版 service + B 仓的 consumer 一起起
- 服务发现 / network policy / 数据初始化都没设计

**做什么**：
1. PreviewJobInput 扩多 service 数组：`services: [{ name, image, command }]`
2. PreviewJobManager 改成创建多个 Deployment + Service，加 ClusterDNS
3. test container env 注入 `<svc>_HOST=svc-name.<ns>.svc.cluster.local`
4. JUnit XML 收集逻辑不变（只一个 test container 出 marker）
5. ns 前缀守门保持 `gitnexus-preview-*`，不动

**对接 Stage6**：当前 issue body 接受单 `serviceImage`，跨仓要改 `services[]`。向后兼容（单 service 就 wrap 成数组）。

### 🟠 D-5 · S7 跨仓 PR 策略（单 vs 多 vs stack）

**当前**：单 issue → 单 MR（auto-fix/issue-N 分支）。
**缺口**：跨仓 patch 要在多个 repo 各发 PR：
- A 仓改 controller → A 仓 PR
- B 仓改 consumer client → B 仓 PR
- 两个 PR 之间有依赖（B 必须 A merge 后才能跑通）

**选项**：
1. **多独立 PR**：每个 repo 一个 PR，body 互引（`Linked: yundiz/cses-java#27`）。简单但合作复杂。
2. **stack-PR**：用 graphite / spr / sapling-stack 概念。门槛高。
3. **monorepo-style 跨仓 commit**：把多仓视为伪 monorepo，发到一个集成分支。需要工作树魔法。

**MVP 推荐**：先 (1) 多独立 PR + body 互引，cses-pre 当前用例够用。

### 🟠 D-6 · 多仓 LLM context window 设计

**当前**：claude -p 的 cwd = 单仓 clone，靠 Read/Glob/Grep 浏览这一个仓。
**缺口**：跨仓 patch 需要 LLM 同时看 A 仓的 Controller + B 仓的 Client。
**做什么**：
1. `--add-dir` 加多个 repoPath（已支持）
2. system prompt 加段 "你看到了多个仓，每个 patch 必须明确目标 repo"
3. JSON Schema 改：`fixFiles: [{ repo, path, content }]`，每条 patch 标 repo 名
4. R-14 violatesSafetyPolicy 按 repo 分别过 policy

**风险**：上下文 token 暴涨。budget 要从 $1.5 提到 $3-5。

### 🟡 D-7 · 跨仓 webhook 路由 + group state

**当前**：一个 webhook server 接两个仓。每个仓 push 触发独立 P1 reindex（不感知跨仓）。
**缺口**：A 仓 push → 应该自动重算 group bridge.lbug（contracts 可能跟着变）。

**做什么**：
1. P1 reindex 完成后挂 hook：`gitnexus group analyze --group <g> --incremental` 重建 bridge
2. group 状态查询接口：`/group/<name>/status` 返 `{ repos, lastBridgeBuild, contractCount }`
3. webhook server 自动发现：每个 push 事件查 repo 属于哪些 group → 触发对应 group rebuild

### 🟡 D-8 · 三因子 LIVE 闸的跨仓粒度

**当前**：单仓 issue 触发 → 单仓 MR。三因子 (label + env + S6) 都在单仓粒度判断。
**缺口**：跨仓 patch 影响 N 个仓。是 N 个仓**全部**满足三因子才发？还是**任一**满足？还是 group-level 标签？

**MVP 推荐**：保守起见 **全部满足**。每个目标 repo 单独看 dryRun 闸；任一不满足整组 dryRun（防止半 live 半 dry-run 状态错乱）。

### 🟢 D-9 · 多仓 token / clone 路径配置

**当前**：`GITNEXUS_AUTOPR_TOKEN_MAP` / `GITNEXUS_REPO_PATH_MAP` 已支持 N 仓 JSON。
**已就绪**：跨仓时只要补 entry 即可。

---

## 3. 实施路径（推荐顺序）

```
Phase 1 (1 周): bridge.lbug 接入                            ← 解锁 D-1, D-2 (cross_depth=1)
Phase 2 (1 周): S3 跨仓 + S4 跨仓                          ← 解锁 D-2 (查 bridge), D-3
Phase 3 (1 周): S6 多 service preview                      ← 解锁 D-4
Phase 4 (1 周): S7 多 PR 联动 + LLM 跨仓 prompt          ← 解锁 D-5, D-6
Phase 5 (0.5 周): P1 group-level reindex 自动化           ← 解锁 D-7
Phase 6 (0.5 周): 三因子 LIVE group 粒度 + 文档           ← 解锁 D-8 + 写 SOP v2

总计 ~5 周到 cross-repo/v1.0.0 (group 粒度全闭环)
```

---

## 4. 测试拓扑建议

最小可行跨仓 e2e：

```
[/tmp/cses-pre/cses-java]                [/tmp/cses-pre/mattermost]
  POST /api/cses/posts/create  ──────►   client.post('/api/cses/posts/create')
       (Spring Controller)                    (Go HTTP client wrapper)
                ↓                                       ↑
         provider Contract                       consumer Contract
                                bridge.lbug
                                ContractLink (exact, contractId='http::POST::/api/cses/posts/create')
```

跨仓 issue：在 mattermost 仓建 issue，stack 顶帧 = `client.go:42`，blast 跨仓回到 cses-java 的 controller。LLM 应该提议在两个仓各发一个 PR：
- mattermost 仓加 retry / null-check（防卡死）
- cses-java 仓加 input validation（防接收坏数据）

---

## 5. 风险登记

| 风险 | 描述 | 缓解 |
|---|---|---|
| GitNexus 1.4.1 group 命令未踩过 | bridge.lbug 生成 / Cypher 查询可能有兼容问题 | 先 staging 仓 group analyze, 不要直接生产 |
| cross_depth>1 OSS 未支持 | `MAX_SUPPORTED_CROSS_DEPTH = 1` 硬上限 | 先按 1 跑, 多跳放 v2.x roadmap |
| LLM token 暴涨 | 跨仓 prompt 含多仓源码 | 加 token 估算 + budget cap 提到 $5; LLM Schema 强制 reasoning ≤ 500 字 |
| 多 PR 联动失败 | A 仓 PR merge 但 B 仓 PR review 不通过 → 中间态 | S7 加 stack-PR 状态机, 但 MVP 不做; 文档说明给团队人工协调 |
| 跨仓 K8s preview 资源消耗 | 起 N 个 service 显著增加 ns 内 Pod | TTL 严格 1800s, ns concurrent cap (currently 3) 不动 |

---

## 6. 给下一个会话（接力 Phase 1）

读完顺序：
1. `/CLAUDE.md` §⚓ 主航道（守轨）
2. 本文 §0 + §1（盘点单仓 vs 跨仓 gap）
3. `docs/learn/单仓-Agentic-DevOps-闭环-真跑通-SOP.md`（单仓 SOP）
4. `docs/learn/Agentic-DevOps-企业版路线图-v2.md` §0.2 mermaid + §3.4 (P2 multi-hop)

第一刀建议：跑 `gitnexus group analyze` 起步（D-1 §3 步）+ 写一份 `gitnexus group inspect <name>` 输出当 fixture，再决定 D-2 怎么写。**不要直接动生产 cluster**。

---

## 7. 心法

> 跨仓 ≠ 单仓×N。**跨仓引入了"原子性"问题** — 多个仓改动要么全 merge 要么全回滚，否则中间态服务会真挂。
>
> GitNexus 给的硬约束是"X 改动会影响 Y" — 这条边是确定性的；但**怎么协调 N 个 PR 的 lifecycle** 是组织流程问题，不是工具能解决的。
>
> 守住单仓的 5 道闸（dryRun 三因子 + R-12 + R-14 + ns 前缀 + bridgeOk），跨仓时**逐仓单独过**，不要整组放行。半 live 半 dry-run 的状态比纯 dry-run 风险大得多。
