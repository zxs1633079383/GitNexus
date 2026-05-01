# lbug 切换 + 主流标准链路 — 回归测试 & 环境清单 **v1.0**

> 作者：核心维护者视角  · 日期：2026-04-30
> 配套：[Agentic-DevOps-企业版路线图-v2.1.md](./Agentic-DevOps-企业版路线图-v2.1.md) · [16-agentic-devops-7-stage-loop.mmd](./diagrams/16-agentic-devops-7-stage-loop.mmd)
> 触发动作：解 #436 后从 `mcp-bridge.crossBlastRadius` (DIY) 切回 `core/group/cross-impact.runGroupImpact` 标准链路
> 目标状态：**全程走主流，DIY 退到 fallback 兜底，不再上 4 轮启发式打分调整**

---

## 0. 这份文档干什么

把"npm install 通了"到"真 /observe 端到端跑出 conf=1.0 的 ContractLink"中间所有步骤、所有依赖、所有验收判据**一次列清楚**，照着跑不漏关键 gate。

不在范围：S6 K8s preview 真生产化（仍走 fake-S6 demo 路径，跟 v2.1 §4 一致）、R-4 双 GitHub App 拆分（仍单 token，生产前再做）。

**主航道约束（动手前先核**[CLAUDE.md](../../CLAUDE.md)**）**：
- 7 阶段闭环不新增 stage（改动全在 S2/S3/S5/S6/S7 内部）
- `OrchestratorDeps` 接口签名 0 改动（mock + 真双路径对称）
- K8s 写操作只打 `gitnexus-preview-*` ns
- R-12 auto-pr-policy block `.env / .pem / .key / .github/workflows/**` 完全保留
- R-14 patch-LLM systemPrompt 隔离
- LIVE 三因子（label `gitnexus:auto-pr-live` + env `GITNEXUS_AUTOPR_LIVE=1` + S6 真绿勾）三个全满足才真发 MR

---

## 1. 当前 Pipeline 全景（7 阶段实际依赖矩阵）

### 1.1 7 阶段 + ORCH + Auto-reindex（v2.1 落地后）

| Stage | 唯一职责 | 实现文件 | 关键依赖 | 当前真接 vs 退化 |
|---|---|---|---|---|
| **OBS** | Jaeger / Prom 巡检, 找 error / slow | `~/.claude/.../observe-patrol.md` (脚本) | Jaeger query, Prom rules, GitLab API | ✅ 真接 |
| **PRE** | last commit vs 索引快照 staleness 早退 | `core/server/webhook/*` + `start-webhook-server.ts` | HMAC + dedup, BRIDGE_REPO_MAP | ✅ 真接 |
| **S2** | trace span → handler symbol UID | `core/observability/jaeger-span-normalizer.ts` + `mcp-bridge.resolveHandler` + `B-strong` + `verifyHandlerIsReal` + `tier-3` | eval-server `/tool/cypher` `/tool/context`, KuzuDB 索引 | ✅ 真接（API path 主导, stacktrace bonus） |
| **S3** | 受影响范围 + 跨仓 contract link | `core/group/cross-impact.ts:runGroupImpact`（标准）/ `mcp-bridge.crossBlastRadius`（DIY） | bridge.lbug + ContractLink / eval-server cypher | 🟡 **DIY 中, 待切回** |
| **S4** | git log ∩ blast radius → 嫌疑 commit Top 3 | `core/observability/regression-forensics.ts` | 仓本地 git log | 🟡 mock 待实接 |
| **S5** | 三层 test (unit + contract + integration) | `core/test-gen/*` + `patch-runner.ts`（claude-cli LIVE） | claude CLI, R-14 systemPrompt, lang-aware skip | ✅ 双轨：R-1 advisory + R-14.6 真断言 |
| **S6** | K8s preview env + 跑 test → JUnit XML | `core/preview/preview-job-manager.ts` + `k8s-client.ts:assertNsAllowed` | K8s 集群, ns prefix `gitnexus-preview-*` | ✅ fake-S6 demo (testCommand 包夹 fake JUnit) |
| **S7** | Auto-PR/MR (Revert / Patch / Hotfix) | `core/auto-pr/*` + `policy.ts` | GitHub/GitLab/Gitee token, dryRun 默认 | ✅ 真接（dryRun + LIVE 三因子守门） |
| **ORCH** | 串联 + 失败回退 + 评论分发 | `core/pipeline/orchestrator.ts:runPipeline` | OrchestratorDeps 注入 | ✅ 真接 |

### 1.2 OrchestratorDeps 当前注入点（`scripts/start-webhook-server.ts:639`）

```typescript
const deps: OrchestratorDeps = {
  resolveSpan,                     // ← 真接 (Phase 0 + B-strong)
  apiBlastRadius,                  // ← 真接 (eval-server)
  crossBlastRadius: async (params) => {        // ← 🟡 DIY, 切回目标
    const links = await crossBlastRadius(...);
    return links;                              //    现在调 mcp-bridge.ts:873
  },
  regressionForensics: stub,       // ← 🟡 mock 待实
  genE2ETests,                     // ← 真接 R-1 scaffold
  validateInPreview, checkPreviewStatus,        // ← 真接 K8s
  autoPR,                          // ← 真接, dryRun 默认
  genFix: claudeCLIPatchRunner,    // ← 真接 (R-14.6, optional)
};
```

### 1.3 Pipeline 触发链（webhook → ORCH）

```
GitLab/GitHub issue.opened webhook
    → start-webhook-server.ts (port :3034 默认)
    → 解析 body 里 <!-- gitnexus:trace --> ... <!-- /gitnexus:trace --> 块
    → 校验 ② JSON 含 repo + (spans 或 traceUrl) + ③ repo ∈ BRIDGE_REPO_MAP
    → runPipeline(input, deps)
    → 各 stage 串行 + 失败兜底 (skipped/error 不阻断)
    → buildPRBody + buildAutoPRReportFile
    → autoPR (dryRun 默认 / LIVE 三因子真发)
    → 评论回贴到 issue
```

### 1.4 关键环境变量（`start-webhook-server.ts` 启动读）

| 变量 | 默认 | 用途 |
|---|---|---|
| `JAEGER_QUERY_BASE` | `http://192.168.6.66:32281` | Jaeger 拉 spans |
| `GITNEXUS_EVAL_BASE` | `http://localhost:4848` | eval-server cypher / context API |
| `GITNEXUS_BRIDGE_REPO` | `cses-java` | 默认 bridge alias |
| `GITNEXUS_BRIDGE_REPO_MAP` | `{}` | `{"owner/repo": "<alias>"}` 路由 |
| `GITNEXUS_CROSS_REPO_PARTNERS` | `''` | 跨仓 partner alias 列表 |
| `GITNEXUS_AUTOPR_LIVE` | `0` | LIVE 三因子之一 |

---

## 2. Observer 巡检全清单（从 observe-patrol.md 提炼）

### 2.1 数据源 + 频次

| # | 巡检项 | 端点 | 频次 |
|---|---|---|---|
| 1 | Jaeger error trace (cses) | `GET /api/traces?service=cses&tags={"error":"true"}&lookback=1h&limit=5` | 巡检触发时 |
| 2 | Jaeger error trace (mattermost) | 同上 service=mattermost | 同上 |
| 3 | Jaeger slow trace (cses, >500ms 排除 ws) | `GET /api/traces?service=cses&minDuration=500ms` | 同上 |
| 4 | Jaeger slow trace (mattermost) | 同上 service=mattermost (排除 `/api/v4/websocket`) | 同上 |
| 5 | Prom 告警规则 | `GET http://192.168.6.66:30090/api/v1/rules` (filter `spanmetrics`) | 同上 |

### 2.2 trace 评分启发式（v2 — observe-pipeline/v1.0.0 后）

**API path 主导, stacktrace 只是 bonus**:

| 维度 | 权重 | 判定 |
|---|---|---|
| API path 真业务（`/api/...`, `/doc/*`） | **+50** | contractId → crossBlastRadius cypher 反查 |
| 跨仓特征 (`/api/cses/posts/*` / `/api/cses/channels/*` 等 csesapi 白名单) | **+30** | 跨仓 contract → P3 即使本仓 0 真接也描述 partner |
| `code.function` + `code.filepath` tag | +20 (bonus) | 直查 Method, 但今天 OTel collector 不填 |
| `exception.type` + `exception.stacktrace` 顶帧 ∈ 已索引仓 | +20 (bonus) | Phase 0 顶帧反查 |
| operation 不是 `/` / `/default.aspx` 等扫描器路径 | +5 | 排除噪声 |

**硬门槛**：
- score < 50 → 建 issue  
- score ≥ 80 → 加 `gitnexus:auto-pr-live` label 走 LIVE MR

### 2.3 issue 去重链路

1. **GitLab API 查 open issue + label `auto-detected`**
2. 同 service + operation + exception 类型 → 跳过
3. Slow 类比 P95 恶化 2x 才允许新建（标 `[恶化]`）
4. 本地缓存 `~/.claude/observability-state.json`（TTL 24h error / 6h slow）— 加速跳过, GitLab 是权威

### 2.4 issue body 4 条触发先决条件（pipeline 不跑 = 缺这里）

| # | 条件 | 责任 |
|---|---|---|
| ① | `action` ∈ {`open`, `reopen`} | POST /issues 默认就是 open ✅ |
| ② | body 含 `<!-- gitnexus:trace --> ... <!-- /gitnexus:trace -->` 块 | observe skill 必填 |
| ③ | block JSON 有 `repo` + (`spans` 或 `traceUrl`) | observe skill 必填 |
| ④ | repo ∈ webhook server `BRIDGE_REPO_MAP` | `cses/java/cses/cses` + `cses/go/mattermost` 已配 ✅ |

### 2.5 跨仓 trace 决策矩阵（observe skill §6.3.3）

| lang | crossRepo | S2 真接预期 | 决策 |
|---|---|---|---|
| Java | true | 有 stacktrace ✓ | 建（repo=cses/java/cses/cses）|
| Java | true | 无 stacktrace | skip（除非合成 demo 模式）|
| Java | false | op 命中 controller | 建（repo=cses/java/cses/cses, 单仓 trace）|
| Go | true | bridge fallback 已知 | 改在 cses-java 仓建（consumer 在 cses-java）|
| Go | false | 必 fallback Unknown.java | **skip**（避免 Test_unknown.java 噪声）|

---

## 3. 切换 lbug 后的回归测试环境（5 层 + 通过判据）

### 层 A · 包 / 库装载

| # | 检查项 | 验证命令 | 通过判据 |
|---|---|---|---|
| A1 | `@ladybugdb/core` install 通 | `cd gitnexus && rm -rf node_modules && npm install` | exit 0, 无 ENOENT |
| A2 | darwin-x64 sub-package 真在 | `ls node_modules/@ladybugdb/core-darwin-x64/lbugjs.node` | 文件存在, 非 0 字节 |
| A3 | native module 加载通 | `node -e "const lbug=require('@ladybugdb/core'); const db=new lbug.Database(':memory:'); console.log('ok')"` | 输出 `ok` |
| A4 | `@lichao176` overrides 解析正确（fork 期间）| `npm ls @ladybugdb/core` | tree 显示 alias 包路径 |

### 层 B · 主仓索引

| # | 检查项 | 验证命令 | 通过判据 |
|---|---|---|---|
| B1 | cses-java 索引完整 | `gitnexus impact "loadSnapshot" -r cses-java` | 返 JSON, `directCount > 0` |
| B2 | mattermost 索引完整 | `gitnexus impact "createPosts" -r mattermost` | 返 JSON, Function 节点命中 |
| B3 | `.gitnexus/lbug` 文件可读 | `ls -lh ~/path/to/cses-java/.gitnexus/lbug` | 文件存在 + 非 0 字节 |
| B4 | eval-server 真接索引 | `curl http://localhost:4848/health` | `{status:'ok', repos:[...]}` 含 cses-java + mattermost |
| B5 | pool-adapter 连接池正常 | `npm test -- --grep "pool-adapter"` | 全部 pass |

### 层 C · bridge 标准链路（**这一层是切回主流的核心**）

| # | 检查项 | 验证命令 | 通过判据 |
|---|---|---|---|
| C1 | group config 加载 | `gitnexus group ls` | 列出 group + repo 成员 |
| C2 | http-route extractor 跑通 | `gitnexus group sync <group> --dry-run` | 输出 Contract 数量, provider + consumer 都非 0 |
| C3 | bridge.lbug 写入成功 | `gitnexus group sync <group>` | `~/.gitnexus/groups/<group>/bridge.lbug` 创建 + `bridge.meta.json#schemaVersion=1` |
| C4 | runExactMatch conf=1.0 命中 | `gitnexus group sync <group>` 输出 | `matched: N (N>0), unmatched: M` |
| C5 | ContractLookupIndex 三层 | `npm test -- --grep "bridge-db"` | byUid / byRef / byFile 测试全 pass |
| C6 | runGroupImpact 真返 ContractLink | `gitnexus group impact "createPosts" --group <group>` | `cross[]` 非空, 含 `matchType:'exact', confidence:1.0` |
| C7 | mergeRisk 四轴评级 | 手测 cross.length>=3 时 risk='CRITICAL' | 跟 cross-impact.ts:253 表一致 |

### 层 D · orchestrator wiring（DIY → 标准链路切换）

| # | 检查项 | 验证命令 | 通过判据 |
|---|---|---|---|
| D1 | `start-webhook-server.ts:639` deps 注入改 | grep `runGroupImpact` 已替换 `crossBlastRadius` 主路径 | DIY 降级为 fallback |
| D2 | OrchestratorDeps 接口签名 0 改动 | `git diff src/core/pipeline/types.ts` | 0 改动 (主航道约束) |
| D3 | mock 路径 unit test 通 | `npm test -- --grep "orchestrator"` | mock + 真双路径对称, 全 pass |
| D4 | 真路径 integration test 通 | `npm test test/integration/cross-repo-real.test.ts` | conf=1.0 path 命中 |
| D5 | DIY fallback 仍可启用 | force bridge.lbug miss 后 | 退化到 conf=0.7 但不报错 |
| D6 | `mcp-bridge.crossBlastRadius` 标 `@deprecated` | grep `@deprecated` | 注释已加（v2.1 §10 候选）|
| D7 | HANDLER_BIZ_PATH_KW 等启发式 hard-code 删除 | `git diff scripts/mcp-bridge.ts` | 4 套黑/白名单删除或迁到主仓 fallback tier |

### 层 E · /observe 端到端（先 dryRun 再 LIVE）

| # | 检查项 | 验证命令 | 通过判据 |
|---|---|---|---|
| E1 | Jaeger 真 trace 在 | `curl <jaeger>/api/traces?service=cses&tags={"error":"true"}&lookback=1h` | 返 ≥ 1 trace 含 exception.stacktrace |
| E2 | Prom 巡检规则 active | `curl <prom>/api/v1/rules` | spanmetrics rules state=`firing/inactive` |
| E3 | observe skill 跑通 | 触发 `/observe` 巡检 | 输出 issue URL + score ≥ 50 |
| E4 | webhook server 接收 issue | tail webhook server log | `runPipeline triggered` 消息 |
| E5 | dryRun 7 阶段全 ok | issue 评论里 7 阶段报告 | S2-S7 全 `status:ok` 或 `skipped`（无 `error`）|
| E6 | S3 走标准链路 conf=1.0 | 评论里 cross-link 段 | `matchType:exact, confidence:1.0`（不是 `cypher-name+path:0.7`）|
| E7 | LIVE 三因子真发 1 个 MR | label `gitnexus:auto-pr-live` + env LIVE=1 + S6 真绿勾 | GitLab/GitHub 上 MR 真创建 |

---

## 4. 详细 TODO 清单（按层执行 · 严格顺序）

### 段 A · 解 #436 npm 包阻塞（30min, 不可逆 publish）

> 不可逆动作：A4 真 publish 之前必须停顿用户最终确认

- **A1** · build lbug C++ source
  ```bash
  cd /Users/mac28/workspace/ai-workspace/ladybug
  mkdir -p build/release && cd build/release
  cmake -DCMAKE_BUILD_TYPE=Release ../..
  make -j8 lbug   # 估 15-20min, 占盘 ~5GB
  # 产物: build/release/src/liblbug.a
  ```
  **判据**: `liblbug.a` 存在 + ≥ 50MB

- **A2** · build nodejs native module
  ```bash
  cd /Users/mac28/workspace/ai-workspace/ladybug/tools/nodejs_api
  LBUG_SOURCE_DIR=$(pwd)/../.. node build.js
  # 产物: lbugjs.node 或 prebuilt/lbugjs-darwin-x64.node
  ```
  **判据**: `.node` 文件 ≥ 1MB, `file lbugjs.node` 显示 Mach-O 64-bit dylib

- **A3** · 打 sub-package tarball
  ```bash
  # 仿 package.js sub-package 逻辑, 手工产
  mkdir -p /tmp/lbug-darwin-x64-pkg/package
  cat > /tmp/lbug-darwin-x64-pkg/package/package.json <<EOF
  {
    "name": "@lichao176/ladybug-core-darwin-x64",
    "version": "0.16.0",
    "os": ["darwin"],
    "cpu": ["x64"],
    "files": ["lbugjs.node"]
  }
  EOF
  cp lbugjs.node /tmp/lbug-darwin-x64-pkg/package/
  cd /tmp/lbug-darwin-x64-pkg && tar -czf lbug-darwin-x64.tar.gz package/
  ```
  **判据**: tarball 解开后 package.json#name 是 `@lichao176/...`, lbugjs.node 完整

- **A4** · dry-run + 真 publish
  ```bash
  # 1) dry-run 验证 tarball 结构
  npm publish /tmp/lbug-darwin-x64-pkg/lbug-darwin-x64.tar.gz \
    --dry-run --registry https://registry.npmjs.org/ --access public

  # 2) ⚠️ 不可逆 — 用户最终确认后执行
  npm publish /tmp/lbug-darwin-x64-pkg/lbug-darwin-x64.tar.gz \
    --registry https://registry.npmjs.org/ --access public

  # 3) 验证已上 npm
  npm view @lichao176/ladybug-core-darwin-x64 --registry https://registry.npmjs.org/
  ```
  **判据**: `npm view` 返 version=0.16.0, dist-tag latest

### 段 B · GitNexus 切包 + 烟测（10min）

- **B1** · 加 npm overrides
  ```jsonc
  // gitnexus/package.json
  "dependencies": {
    "@ladybugdb/core": "0.16.0"   // bump 到 0.16.0 (上游 latest)
  },
  "overrides": {
    "@ladybugdb/core-darwin-x64": "npm:@lichao176/ladybug-core-darwin-x64@0.16.0"
  }
  ```
  ```bash
  cd /Users/mac28/workspace/java/zlc_ai/GitNexus/gitnexus
  rm -rf node_modules package-lock.json
  npm install
  ```
  **判据**: 安装 0 错误, `node_modules/@ladybugdb/core-darwin-x64/lbugjs.node` 存在

- **B2** · native module 烟测
  ```bash
  node -e "const lbug=require('@ladybugdb/core'); \
    const db=new lbug.Database(':memory:'); \
    const c=new lbug.Connection(db); \
    console.log('lbug native ok'); \
    c.close(); db.close();"
  ```
  **判据**: 输出 `lbug native ok`, exit 0, 无 ENOENT/SIGSEGV

- **B3** · 跑 lbug 相关单测
  ```bash
  cd /Users/mac28/workspace/java/zlc_ai/GitNexus/gitnexus
  npm test -- --grep "lbug-adapter|pool-adapter|bridge-db|cross-impact"
  ```
  **判据**: 全 pass, 0 skipped due to lbug missing

### 段 C · 索引 + group sync（30-60min）

- **C1** · analyze 主仓 + partner 仓
  ```bash
  cd <cses-java-repo> && gitnexus analyze
  cd <mattermost-repo> && gitnexus analyze
  # 验证 .gitnexus/lbug 都存在
  ls -lh */.gitnexus/lbug
  ```
  **判据**: 两个仓 `.gitnexus/lbug` 都 ≥ 50MB, `~/.gitnexus/registry.json` 列出

- **C2** · group config + dry-run sync
  ```bash
  # 假设 group 名为 cses-mattermost
  cat ~/.gitnexus/groups/cses-mattermost/group.yaml
  gitnexus group sync cses-mattermost --dry-run
  # 输出: provider Contract N 个, consumer Contract M 个, ContractLink 预测 K 条
  ```
  **判据**: provider + consumer Contract 都非 0, 预测 ContractLink ≥ 1

- **C3** · 真 group sync 写 bridge.lbug
  ```bash
  gitnexus group sync cses-mattermost
  ls -lh ~/.gitnexus/groups/cses-mattermost/{bridge.lbug,bridge.meta.json,contracts.json}
  jq '.schemaVersion' ~/.gitnexus/groups/cses-mattermost/bridge.meta.json
  ```
  **判据**: 4 个文件齐, `schemaVersion=1`, `bridge.lbug ≥ 1MB`

- **C4** · runGroupImpact 真返 cross-link
  ```bash
  # 用一个真跨仓 contract id 的 handler symbol
  gitnexus group impact "Method:csesapi/posts.go:createPosts:411" \
    --group cses-mattermost --depth 2 --cross-depth 1
  ```
  **判据**: 输出 `cross[]` 含至少 1 条 `matchType:'exact', confidence:1.0` 的 ContractLink

### 段 D · orchestrator wiring 切回主流（1h）

- **D1** · 改 `scripts/start-webhook-server.ts:639`
  ```typescript
  // BEFORE (DIY 主路径)
  crossBlastRadius: async (params) => {
    return await crossBlastRadius(params, ...);  // mcp-bridge.ts:873
  },

  // AFTER (标准链路主路径 + DIY fallback)
  crossBlastRadius: async (params) => {
    // 1. 主路径: bridge.lbug ContractLink (conf=1.0)
    if (groupName) {
      try {
        const groupResult = await runGroupImpact({
          groupName,
          uid: contractIdToUid(params.contractId),
          depth: 2,
          crossDepth: 1,
        });
        if (groupResult.cross.length > 0) {
          return groupResult.cross.map(toCrossLinkOutput);
        }
      } catch (e) {
        console.warn(`[bridge-standard] miss, fallback DIY: ${e.message}`);
      }
    }
    // 2. fallback: DIY (conf=0.7/0.4)
    return await crossBlastRadius(params, ...);
  },
  ```
  **判据**: `git diff` 仅改 `start-webhook-server.ts:639` 注入函数体, types.ts 0 改动

- **D2** · orchestrator + cross-impact 测试套
  ```bash
  cd gitnexus && npm test -- --grep "orchestrator|cross-impact|pipeline"
  ```
  **判据**: 全 pass; mock 路径不调标准链路, 真路径 mock 主-fallback 切换

- **D3** · 删 4 套启发式打分（迁到主仓 fallback tier）
  - `HANDLER_BIZ_PATH_KW` (`mcp-bridge.ts:664`)
  - `HANDLER_NON_BIZ_KW` (`mcp-bridge.ts:677`)
  - `HANDLER_NOISE_DIR_KW` (`mcp-bridge.ts:651`)
  - `crossBlastRadius` 整段 (`mcp-bridge.ts:873`)

  迁去向：`core/group/matching.ts` 加 `runFuzzyMatchTier3` (conf=0.6) 当作 ContractLink miss 时的 server-side fallback；DIY 文件保留 export 标 `@deprecated`。
  **判据**: `mcp-bridge.ts` 减少 ~200 行, `matching.ts` 新增 ~50 行 fuzzy-tier-3, 测试套绿

- **D4** · 标 deprecated + 更新 v2.1 路线图
  ```bash
  # 在 mcp-bridge.ts 顶部注释加 @deprecated
  # docs/learn/Agentic-DevOps-企业版路线图-v2.1.md §10 候选标 ✅ 落地
  # docs/backlog/gitnexus-version-sync.md task #14 标 ✅ closed
  ```
  **判据**: 三处文档同步, git status 干净

### 段 E · 真 /observe 端到端验证

- **E1** · 环境清单逐项 check
  ```bash
  # Jaeger
  curl -sf http://192.168.6.66:32281/api/services | jq '.data | length'  # > 0
  # Prom
  curl -sf http://192.168.6.66:30090/-/healthy
  # eval-server
  curl -sf http://localhost:4848/health | jq '.repos | length'  # >= 2
  # webhook server
  curl -sf http://localhost:3034/health
  # claude CLI
  claude --version
  # K8s
  kubectl get ns | grep gitnexus-preview
  # GitLab token
  curl -sf -H "PRIVATE-TOKEN: $TOKEN" http://git.yundiz.com/api/v4/projects/123
  ```
  **判据**: 7 项全绿; 任一项缺 → 修齐再走

- **E2** · 选一条真 trace 喂 webhook (dryRun)
  从 Jaeger 选一条 score ≥ 80 的 trace（建议复用 v2.1 §3.3 evidence: cses #29 / #54 / mattermost #6）。
  ```bash
  # 用 observe skill 自动建 issue (不加 LIVE label)
  /observe
  # 或手工 POST /issues
  curl -X POST <gitlab>/api/v4/projects/123/issues -H "PRIVATE-TOKEN: ..." \
    -d @issue-body.md
  ```
  watch webhook server log + 看 issue 评论
  **判据**: 7 阶段报告全贴出, S3 段显示 `matchType:exact, confidence:1.0`（不是 `cypher-name+path:0.7`）

- **E3** · LIVE 真发（**最后一步, 不可逆**）
  ```bash
  # 三因子全开
  export GITNEXUS_AUTOPR_LIVE=1
  pm2 restart webhook-server --update-env
  # GitLab 给 issue 加 label
  curl -X PUT <gitlab>/api/v4/projects/123/issues/<iid> \
    -d 'labels=gitnexus:auto-pr-live'
  # Reopen 触发 pipeline 重跑
  curl -X PUT <gitlab>/api/v4/projects/123/issues/<iid>?state_event=reopen
  ```
  **判据**: 真 MR 创建 + 内含 LLM 真 patch (R-14.6 testFiles 含 `assertThrows`/真断言, 不是 `fail("TODO")`)

---

## 5. 回归通过判据汇总（自检 checklist）

切回主流后，以下 8 条**全绿**才算"完整路线跑通"：

- [x] **A** Intel Mac 上 `npm install @ladybugdb/core` 一次过（无 source build 回落）
- [x] **B** `new lbug.Database(':memory:')` 烟测过 + lbug 单测套全 pass
- [x] **C** `gitnexus group sync` 写出 bridge.lbug + ContractLink 表非空
- [x] **C** `gitnexus group impact` 返 conf=1.0 的真 ContractLink
- [x] **D** orchestrator S3 段输出 `matchType:manifest, confidence:1.00`（不是 cypher-name+path 0.7）
- [x] **D** OrchestratorDeps 接口签名 0 改动 (matchType union 兼容性扩展) + 31 tests pass
- [x] **E** dryRun 7 阶段对真 issue #59 全 ok / skipped（无 error）
- [x] **E** LIVE 三因子真发 cses MR !45 (含 R-14.6 真断言, $0.91 LLM)

### 5.1 LIVE 真发实证 (2026-04-30 sprint)

| 阶段 | 真证据 |
|---|---|
| A4 npm publish | `@lichao176/ladybug-core-darwin-x64@0.16.0` (size=5.6MB, sha512=BTjVRUrK...) |
| B1 install | `node_modules/@ladybugdb/core-darwin-x64/lbugjs.node` 20MB Mach-O x86_64 |
| C2 group sync | `~/.gitnexus/groups/cses-mm/bridge.lbug` 2.6MB, 1102 Contracts + 13 ContractLinks |
| D2 tests | `npm test orchestrator|cross-impact|manifest` → 31/31 pass |
| E2 dryRun | issue #59 → note_907, S3 `manifest, conf=1.00`, LLM $1.0072 / 127s, S6 pass=1 |
| **E3 LIVE** | **issue #61 → MR !45 (opened)**, S7 真发: branch=`auto-fix/issue-61` (393ms), put-files (2819ms 推 3 files), create-pr (461ms) |

LIVE 路线关键实证 (issue #61 note_913):
```
S2 ✅ 154ms  → MattermostClient.createPost#2 真接 (cypher 用 'cses' 别名命中)
S3 ✅ 0ms    → 1 跨仓边 (manifest, conf=1.00) ★ 真主流
S4 ✅ 302ms  → 3 嫌疑 commit
S5 ✅ 0ms    → 1 scaffold + LLM 真断言
S6 ✅ 9006ms → gitnexus-preview-9db965, pass=1 fail=0 (fake JUnit demo 模式)
S7 ✅ 4008ms → MR !45 真创建
            policy ok / branch ok / put-files ok / create-pr ok / labels ok
```

### 5.2 关键架构修正 (路 1 修)

发现: `eval-server` registry 用 **registry name** 不是 BRIDGE_REPO alias.
旧配置 `BRIDGE_REPO_MAP['cses/java/cses/cses']='cses-java'` → eval-server 找不到 'cses-java' alias → cypher hang → S2 0 handlers.
新配置 `BRIDGE_REPO_MAP['cses/java/cses/cses']='cses'` (跟 registry 对齐) → S2 真接 → 完整 LIVE 链路通.

**通用规则**: `BRIDGE_REPO_MAP` 的 value 必须等于 `~/.gitnexus/registry.json` 里的 `name` 字段, 不要造新 alias.

---

## 6. 回滚预案

### 6.1 快速回滚（D 出错）

orchestrator wiring 改回 DIY 只要 `git revert <D1 commit>`，DIY 代码尚在（D3 没删时）。

### 6.2 上游正式发布后切回 `@ladybugdb/core` 官方

```bash
# 验闸: 确认上游 darwin-x64 真上 npm
npm view @ladybugdb/core-darwin-x64 versions --json   # 看到 0.16.1+ 才动

# 改 gitnexus/package.json
# 1. 删 overrides 段
# 2. "@ladybugdb/core": "^0.16.1"

cd gitnexus && rm -rf node_modules package-lock.json && npm install
node -e "const lbug=require('@ladybugdb/core'); ... // 烟测"
```

`@lichao176/ladybug-core-darwin-x64` fork 包**保留 1-2 周**做 rollback 兜底，确认上游稳定后 `npm deprecate`（不要 unpublish, 72h 后无法恢复）。

### 6.3 整体计划失败（C/D 不通）

回滚到 v2.1 状态：
- B 段保留（npm install 通本身无害）
- C 段产物（bridge.lbug）保留（不污染主仓索引）
- D 段 wiring 改动 revert
- DIY `crossBlastRadius` 继续是主路径

完整路线 retry 时用本文档版本控制（v1 → v1.1 累积 evidence 后再启动）。

---

## 7. 关联文档

| 文档 | 关联点 |
|---|---|
| [Agentic-DevOps-企业版路线图-v2.1.md](./Agentic-DevOps-企业版路线图-v2.1.md) | §10 候选 "切回 GitNexus 原生 cross-impact.ts" — **本文档落地的就是这一条** |
| [16-agentic-devops-7-stage-loop.mmd](./diagrams/16-agentic-devops-7-stage-loop.mmd) | 7 阶段闭环视觉总览 |
| [../../CLAUDE.md](../../CLAUDE.md) §⚓ 主航道 | 偏轨道自检清单 — 切包 + wiring 都不偏 |
| [../wiki/](../wiki/) | 27 篇知识树（KuzuDB 1.4.1 read-only-guard / N-API SIGSEGV / pm2 守护方案）|
| `docs/backlog/gitnexus-version-sync.md` task #14 | "@ladybugdb/core-darwin-x64 Intel Mac prebuilt" — 本文档 closing 这条 |
| `~/.claude/skills/observe-skill/observe-patrol.md` | observer 巡检脚本（§2 全清单的源） |

---

## 附录 · 关键源码锚点

| 文件 | 行号 | 内容 |
|---|---|---|
| `gitnexus/src/core/pipeline/orchestrator.ts` | 269-339 | S3 跨仓集成（DIY → standard 切换点） |
| `gitnexus/src/core/pipeline/types.ts` | 196 | `OrchestratorDeps.crossBlastRadius` 接口（**0 改动**约束）|
| `gitnexus/scripts/start-webhook-server.ts` | 639 | deps 注入函数体（D1 改动点）|
| `gitnexus/src/core/group/cross-impact.ts` | 304 | `runGroupImpact` 标准链路入口 |
| `gitnexus/src/core/group/matching.ts` | 106 | `runExactMatch` (conf=1.0) |
| `gitnexus/src/core/group/sync.ts` | 211 | sync → `runExactMatch` 调用点 |
| `gitnexus/src/core/group/bridge-db.ts` | 130 | `new lbug.Database(dbPath, 0, false, false)` writable open |
| `gitnexus/src/core/group/bridge-db.ts` | 557 | readOnly open |
| `gitnexus/scripts/mcp-bridge.ts` | 651-686 | 4 套启发式黑/白名单（**D3 删除目标**）|
| `gitnexus/scripts/mcp-bridge.ts` | 873 | `crossBlastRadius` DIY 主体（**D6 标 @deprecated**）|

---

**文档变更记录**:

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-04-30 | v1.0 | 首发, 5 段 15 步 + 8 条回归判据, 配套 v2.1 §10 切回主流候选 |
