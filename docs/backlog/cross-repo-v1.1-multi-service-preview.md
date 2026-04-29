# cross-repo v1.1 — 多 service preview + partner LIVE 闸严格化

> Status: **backlog (planning)**
> Owner: 待领
> Created: 2026-04-29
> Targets: cross-repo/v1.1.0
> Related: cross-repo/v1.0.0 (ac9b771f), D-4, D-8

## 1. 一句话定位

**跨仓 v1.1 的两块硬骨头：partner 仓 patch 也得真跑 K8s 验证 (D-4 强化)，三因子 LIVE 闸要 partner-side 独立判 (D-8 严格化)。**

cross-repo/v1.0.0 把"多仓 patch 同时发 PR/MR"接通了；下一步要让"多仓 patch 同时被 K8s preview 验证"，并把 LIVE 闸的粒度切到 partner-side。

## 2. 现状（cross-repo/v1.0.0 之后）

### 2.1 单 service preview 拓扑

`gitnexus/src/core/preview/preview-job-manager.ts` 当前实现的 PreviewJob 是**单 service 拓扑**：

- 一个 `serviceImage`（候选修复镜像）+ 一个 `testImage`（测试 runner）
- 一个 namespace `gitnexus-preview-<shortId>` 内只起 1 个 Deployment + 1 个 Service
- 见 `gitnexus/src/core/preview/types.ts:17-34`：

```ts
export interface PreviewSpec {
  serviceImage: string;
  serviceName: string;
  servicePort?: number;
  serviceCommand?: string[];
  testImage: string;
  testCommand: string[];
  junitOutputPath?: string;
  ttlSeconds?: number;
}
```

只有一个 `serviceImage` 字段，结构上不支持"A 仓新版 + B 仓新版同 ns 同时起"。

### 2.2 S6 输入也是单 service

`gitnexus/src/core/pipeline/types.ts:37-50` 的 `S6PreviewInput`：

```ts
export interface S6PreviewInput {
  serviceImage: string;        // 单一镜像
  serviceCommand?: string[];
  testImage?: string;
  testCommand: string[];
  ttlSeconds?: number;
  pollTimeoutSec?: number;
}
```

orchestrator 拿到 `input.preview` 后扔给 `deps.runPreview`，跑单一 service。

### 2.3 partner MR 共享 primary 的 stage6Pass（D-8 缺口）

orchestrator S7 段创建 partner MR 时，**直接复用 primary 的 `stage6Pass`**：

- `gitnexus/src/core/pipeline/orchestrator.ts:461`

```ts
const stage6Pass = s6_preview.status === 'ok' && !!s6_preview.output?.pass;
```

- `gitnexus/src/core/pipeline/orchestrator.ts:587-592`（partner autoPR 调用处）

```ts
const partnerResult = await deps.autoPR({
  candidate: partnerCandidate,
  provider: input.prTarget!.provider,
  dryRun: input.prTarget!.dryRun !== false,
  stage6Pass,        // ← 这里复用 primary 的 stage6Pass
});
```

**问题**：partner patch 改的是 partner 仓的代码，primary preview 跑的是 primary serviceImage 的测试。partner patch 没单独跑过 K8s preview，stage6Pass 借的是邻居家的章。严格说 partner MR 不该用这个值判 LIVE 闸。

### 2.4 三因子 LIVE 闸现状

triple-gate（issue label + env + S6 真绿勾）当前是**全 pipeline 一份**：primary 满足就过，partner 跟着发。粒度太粗，partner 仓真要发 MR 时风险全转嫁到了 primary 的判定上。

## 3. 缺口

跨仓真验证场景需要的能力，v1.0.0 不具备：

1. **多 service 同 ns 同时起**
   - 场景：A 仓改了 contract `OrderClient.fetchOrder()`, B 仓 client 跟着升级。验证需要 A 仓的新版 service + B 仓的新版 service 同时在线，B 的测试要能调到 A。
   - 需要：N 个 Deployment + N 个 Service 在同一个 `gitnexus-preview-<shortId>` ns 里。

2. **服务发现 / ClusterDNS**
   - test container 要知道每个 svc 的地址，跨仓调用要走 K8s 内部域名 `<svc>.<ns>.svc.cluster.local`。
   - 注入方式：env var（`<SVC_NAME>_HOST`）或 init script 读 K8s downward API。

3. **partner serviceImage 候选镜像源**
   - LLM patch-runner 改了 partner 仓代码 → 谁负责把它打成镜像？候选：① caller 在 webhook 配置里预登记 `partnerImageBuilder` ② orchestrator 调 ad-hoc image build (kaniko / buildah) ③ 复用 partner 仓 baseImage + bind-mount patch（最轻量但只适合解释型语言 / static asset）。先选③做 MVP，①作 GA 选项。

4. **network policy（可选 GA）**
   - 同 ns 内默认 allow-all；如果未来跑多个 partner，互相隔离需要 NetworkPolicy。v1.1.0-alpha 不做。

5. **ns 前缀守门**
   - 任何 K8s 写操作仍必须打到 `gitnexus-preview-*`（CLAUDE.md §⚓ 偏轨道 #3，由 `core/preview/k8s-client.ts:assertNsAllowed` 强制）。多 service 拓扑改造**禁止**绕过这个守门。

## 4. 实施路径

### Phase 1: D-4 多 service preview 拓扑（3-4 天，v1.1.0-alpha）

**目标**：单 ns 内能起多个 service + 一个 test runner。

**改造点**：

- **`PreviewSpec` 扩 services 数组**（`core/preview/types.ts`）

  ```ts
  export interface ServiceSpec {
    name: string;
    image: string;
    port?: number;
    command?: string[];
    /** 可选 readiness probe path */
    readinessPath?: string;
  }

  export interface PreviewSpec {
    services: ServiceSpec[];   // ← 新字段，至少 1 个
    testImage: string;
    testCommand: string[];
    junitOutputPath?: string;
    ttlSeconds?: number;
    // 向后兼容：保留 serviceImage / serviceName / servicePort / serviceCommand
    // 但运行时优先看 services[]，single 字段做 deprecated alias
  }
  ```

- **PreviewJobManager 创建多 Deployment**（`core/preview/preview-job-manager.ts`）
  - `runJob` → `driver.spinUp(job)` 内部循环 `services` 数组，每个 service 起一份 Deployment + Service
  - 等待**全部** ready 后再起 test runner
  - 失败任何一个 → job.status = 'failed'，error 记录哪个 service spin 失败

- **K8sPreviewDriver 多 service 实现**（`core/preview/preview-driver.ts` 等）
  - applyDeployment / applyService 包成可批量调用
  - readiness 等待用 K8s Watch API 或 polling，超时整体 fail

- **test container env 注入**
  - 用 K8s downward API 注 ns / pod name
  - 用静态 env 注每个 svc：`{NAME_UPPER}_HOST=<name>.<ns>.svc.cluster.local`、`{NAME_UPPER}_PORT=<port>`
  - 这样 test 脚本 `curl http://$ORDER_HOST:$ORDER_PORT/...` 直接通

- **JUnit XML 收集逻辑不变**（result-collector 已经按 pod 取）

- **向后兼容**
  - 老调用方传 `serviceImage` 单字段，PreviewJobManager 自动 wrap 成 `services: [{ name: serviceName, image: serviceImage, port: servicePort, command: serviceCommand }]`
  - 现有单仓 e2e 不破

- **S6PreviewInput 同步**（`core/pipeline/types.ts`）
  - 加 `services?: ServiceSpec[]`（可选，传了优先用；不传则按老 `serviceImage` wrap）

- **资源消耗护栏**
  - `DEFAULT_MAX_CONCURRENT` 当前是 3 (`core/preview/types.ts:73`)；多 service 后单 ns 起 N 倍 pod，建议 1.1 默认降到 **2**
  - 单 job 内 services 数硬上限 `MAX_SERVICES_PER_JOB = 5`，超了直接 reject（不然资源失控）

- **测试**
  - unit：spec wrap 兼容性 + readiness wait 超时
  - integration：起 2 个 service（nginx + busybox echo server）+ test 跨调
  - e2e：跨仓真 issue（mock 一个 contract change），跑 multi-service preview，看 JUnit 是否双绿

### Phase 2: D-8 partner-side stage6Pass（1-2 天，v1.1.0-beta）

**目标**：partner MR 的 stage6Pass 必须由 partner 仓自己的 K8s preview 真跑出来。

**改造点**：

- **`crossRepoTargets` 扩 partnerS6 字段**（`core/pipeline/types.ts:77`）

  ```ts
  crossRepoTargets?: Record<
    string,
    {
      owner: string;
      repo: string;
      baseBranch: string;
      /** 可选：partner 仓自己的 S6 preview spec
       *  缺省 → partner stage6Pass 自动 false（保守安全）
       *  提供 → 创建 partner MR 前用这个 spec 跑独立 K8s preview job
       */
      partnerS6?: S6PreviewInput;
    }
  >;
  ```

- **orchestrator S7 段：partner 独立 preview**（`core/pipeline/orchestrator.ts:553-605`）
  - 在循环 `partnerFixGroups` 时，对每个 alias：
    1. 看 `crossRepoTargets[alias].partnerS6` 是否存在
    2. 存在 → 调 `deps.runPreview({ ...partnerS6, services 内含 partner serviceImage 候选 })`，等返回
    3. 不存在 → `partnerStage6Pass = false`（保守拒绝）
  - 把 partner 独立的 `partnerStage6Pass` 替换 line:591 的 `stage6Pass`
  - **不复用 primary 的 stage6Pass**

- **`AutoPRResult.crossRepoPRs[i]` 加字段**（`core/auto-pr/types.ts` 或对应位置）

  ```ts
  interface CrossRepoPREntry {
    partnerAlias: string;
    partnerFullName: string;
    partnerStage6Pass: boolean;    // ← 新字段
    partnerStage6JobId?: string;   // ← 可选，便于追溯
    result: AutoPRResult;
  }
  ```

- **报告 / PR body**
  - partner MR body 模板加一段「partner-side S6 preview: pass/fail (jobId=...)」
  - PipelineReport 头部摘要分别列 primary 和各 partner 的 stage6Pass

- **测试**
  - unit：partnerS6 缺失 → partnerStage6Pass=false
  - integration：mock partnerS6 返绿 → partner MR 真发；返红 → partner MR 不发但不阻塞 primary
  - e2e：跨仓 issue，primary 绿 + partnerA 绿 + partnerB 红 → primary MR 发、partnerA MR 发、partnerB 不发

### Phase 3: 三因子 LIVE 闸严格化（0.5 天，v1.1.0-beta 一起 ship）

**目标**：partner MR 真发的三个条件**全部 partner-side 判**，缺一不发；且 primary 闸独立判，互不阻塞。

**改造点**：

- **issue label 粒度**
  - 现：`gitnexus:auto-pr-live`（全局）
  - 新：保留全局兜底，但允许 sub-label `gitnexus:auto-pr-live:<alias>`（如 `gitnexus:auto-pr-live:mattermost`）
  - 解析顺序：sub-label 优先；缺 sub-label 再 fallback 到全局
  - 写在 `core/auto-pr/policy.ts` 或对应 gate 处

- **env 粒度**
  - 简单方案：保留单 env `GITNEXUS_AUTOPR_LIVE=1`（不加 partner-specific env，env 太多反而易误用）

- **partnerStage6Pass 必须 true**
  - 来自 Phase 2

- **三因子在 partner MR 创建处全部判一遍**
  - orchestrator 创建 partner MR 前 short-circuit：

    ```ts
    const partnerLive =
      hasIssueLabel(`gitnexus:auto-pr-live:${alias}`) ||
      (hasIssueLabel(`gitnexus:auto-pr-live`) && !hasOptOutLabel(alias));
    const live = partnerLive && process.env.GITNEXUS_AUTOPR_LIVE === '1' && partnerStage6Pass;
    if (!live) {
      // 走 dryRun，记录原因到 crossRepoPRs[i].liveBlockedReason
    }
    ```

- **primary 闸不变也不依赖 partner**
  - primary 失败、partner 成功的组合也允许（partner MR 真发，primary 走 dryRun 等人补）

- **测试**
  - 三因子矩阵：8 种组合（label / env / s6 各 2 态）至少覆盖关键 6 种
  - e2e：完整跑通 primary live + partner live 两端

## 5. 风险

- **K8s 资源消耗**
  - 单 job 内 N 个 Deployment + N 个 Service，pod 数量 N 倍
  - 缓解：`MAX_SERVICES_PER_JOB = 5` 硬上限 + concurrent cap 从 3 降到 2
  - 监控：preview ns 创建/销毁频率告警

- **TTL 与 GC**
  - 现 TTL 1800s 不变，但多 service teardown 时间略长（每个 svc 都要清）
  - 缓解：teardown 必须按"先 test pod → service → deployment → namespace"顺序兜底；reaper 兜底逻辑保持不变（删 ns 即可级联清理）

- **ns 前缀守门**（CRITICAL）
  - 多 service 改造**禁止**绕过 `assertNsAllowed`（CLAUDE.md §⚓ 偏轨道 #3）
  - PR review 必查：所有新增 K8s 写调用前是否走过 `assertNsAllowed(ns)`

- **partner serviceImage 怎么来**
  - v1.1.0-alpha 选最轻量的方案：partner 镜像由 caller 在 webhook config / `crossRepoTargets[alias].partnerS6.serviceImage` 里**预先指定**，orchestrator 不负责 build
  - GA 阶段再考虑接 kaniko / 自动 build（开 P-x 单独 issue）

- **环境隔离**
  - 跨 partner 之间共享 ns 简单但有耦合风险（同名 svc 冲突）；约定 service name 必须前缀化 `<alias>-<svcName>`
  - 写到 `ServiceSpec.name` 的 validator 里强制

- **回滚路径**
  - Phase 1 ship 后若发现资源/稳定性问题，回滚到 v1.0.x 单 service：`PreviewSpec.services` 字段做 deprecated alias 兜底，删除新代码前先关 multi-service feature flag (`GITNEXUS_PREVIEW_MULTI_SVC=0`)
  - 建议 Phase 1 ship 时就带 feature flag，stable 后下一版本拆掉

## 6. 拆 Issue / Sprint 建议

| 版本 | 范围 | 工作量 | 可独立 ship |
|---|---|---|---|
| **v1.1.0-alpha** | Phase 1 多 service preview | 3-4 天 | ✅ 单仓也用得上（多 service 单测场景） |
| **v1.1.0-beta** | Phase 2 partner-side stage6Pass + Phase 3 三因子严格化 | 1.5-2 天 | ❌ 依赖 Phase 1 ship |
| **v1.1.0 GA** | 全部 + e2e 跨仓真发 partner MR | +1 天 buffer | ✅ |

**总工作量预估：5-7 天**（含 e2e）。

**单条 PR 拆分建议**：

1. PR-1: PreviewSpec → services 数组 + 向后兼容 wrapper（types only + unit）
2. PR-2: PreviewJobManager + driver 多 service spin/teardown（integration test）
3. PR-3: S6PreviewInput services 字段 + orchestrator 透传
4. PR-4: crossRepoTargets.partnerS6 + orchestrator partner 独立 preview
5. PR-5: AutoPRResult.crossRepoPRs[i].partnerStage6Pass + PR body 渲染
6. PR-6: 三因子 partner-side gate（label sub-form + env + s6）
7. PR-7: e2e 跨仓真跑通

每条 PR 控制在 ≤ 400 行 diff，方便 review 闭环。

## 7. 关联

- **触发条件**：cross-repo/v1.0.x 真跑出现"partner 真要改"的场景。issue#29 的 LLM 选了单仓修复，没触发；下一个真跨仓 bug（contract 改动 / API breaking change）就会触发。
- **依赖**：cross-repo/v1.0.0 的 `crossRepoPRs` 接口（已落地，commit `ac9b771f`，tag `cross-repo/v1.0.0`）
- **不依赖**：S4 forensics 真接、S5 LLM 真断言（这俩是另一条平行路线）
- **关联文档**：
  - `docs/learn/跨仓-Agentic-DevOps-闭环-真跑通-SOP.md`（v1.0.0 真跑通 SOP）
  - `CLAUDE.md` §⚓ 主航道 7 阶段闭环（S6/S7 边界定义）
  - `docs/learn/Agentic-DevOps-企业版路线图-v2.md`（D-4 / D-8 在路线图位置）
- **预估总工作量**：5-7 天（含 e2e），适合一个 sprint 收掉。

## 8. 自检清单（启动前必看）

- [ ] 新代码所有 K8s 写调用前都走过 `assertNsAllowed(ns)`
- [ ] 单 service caller 不破（向后兼容 wrapper 有 unit 覆盖）
- [ ] `MAX_SERVICES_PER_JOB` 上限有 reject 路径 + 测试
- [ ] partner stage6Pass **不**复用 primary（grep 一遍 orchestrator.ts 没漏）
- [ ] 三因子 partner-side label 解析有 fallback（sub-label 缺 → 全局 label）
- [ ] dryRun 默认仍是开（真发要三因子全绿）
- [ ] feature flag `GITNEXUS_PREVIEW_MULTI_SVC` 可一键回滚到单 service 路径
- [ ] commit message Conventional Commits + 中文 + 引 D-4/D-8 编号
