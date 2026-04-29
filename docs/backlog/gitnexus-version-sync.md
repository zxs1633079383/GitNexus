# GitNexus 版本对齐 TODO（MVP → latest）

> 创建于 2026-04-29，配套 mvp/v1.1.0 真闭环 e2e 落地
> 目的：当前 MCP 桥接是 MVP 临时方案，长期要把本仓的 src tree 跟 GitNexus latest 主版本同步
> 触发：每次 `npm i -g gitnexus` 看到大版本变更（尤其是 1.x → 2.x）必须同步评估

---

## 1. 当前状态（不一致点）

| 维度 | 本仓 src tree (`/Users/mac28/.../GitNexus/gitnexus/`) | 全局 binary (`gitnexus@1.4.1`) |
|---|---|---|
| 知识图存储 | LadybugDB (lbug, native binding) | **KuzuDB** (npm `kuzu` package) |
| MCP 工具入口 | `LocalBackend.callTool()` 内嵌 | `gitnexus mcp` (stdio) / `gitnexus eval-server` (HTTP) |
| schema 节点表 | 32 节点表 + 单 CodeRelation | 同样 32 节点表（**但库不同**）|
| 索引能否复用 | ❌ KuzuDB 数据 lbug 读不出 | ❌ lbug 数据 KuzuDB 读不出 |
| 业务仓索引数据当前在哪 | （空）| ✅ cses-java 65k nodes / mattermost 46k nodes / paas / mattermost 镜像版 等 15 个仓 |

**本质冲突**：本仓的 7 阶段闭环代码（pipeline orchestrator / S2-S7 / webhook handler）调 `LocalBackend`（lbug-based），但用户实际把业务仓索引到全局 1.4.1（KuzuDB-based），数据隔离。

---

## 2. 当前 MVP 桥接（方案 A.2）

只用于跑通端到端 demo，**不是长期方案**。

```
webhook server (本仓 lbug)
   │ S2 resolveSpan / S3 apiBlastRadius / S4 forensics
   ▼ HTTP fetch
全局 gitnexus eval-server :4848 (KuzuDB)
   ▼
真索引数据 (业务仓 cses-java / mattermost)
```

实现位置（待写）：
- `gitnexus/scripts/mcp-bridge.ts` — 80 行 HTTP fetch wrapper
- `gitnexus/scripts/start-webhook-server.ts` — 用 bridge 替代 mock S3-S5 deps

启动：
```bash
gitnexus eval-server --port 4848 &
GITNEXUS_EVAL_BASE=http://localhost:4848 npx tsx scripts/start-webhook-server.ts
```

---

## 3. 长期对齐 TODO（必做）

### 3.1 短期（mvp/v1.x 阶段）— 桥接稳定化

- [ ] eval-server 守护：systemd / pm2 / k8s deployment 挂掉自重启
- [ ] 桥接版本探测：bridge 启动时调 `gitnexus --version` 比对，主版本不匹配 → 警告 + 降级 mock
- [ ] 桥接超时：默认 5s，超时 fallback 到 mock + 日志告警
- [ ] gitnexus latest 升级 changelog 监控：订阅 npm `gitnexus` 包大版本变更（or 周巡检脚本 `npm view gitnexus version`）

### 3.2 中期（mvp/v2.0 起）— 切 KuzuDB 跟 latest 对齐

- [ ] 评估 lbug 还有没有保留必要：lbug 是历史包袱，KuzuDB 才是 latest
- [ ] 重构 `LocalBackend` lbug-adapter → KuzuDB adapter（参考全局 1.4.1 的 `gitnexus/src/core/kuzu/` 实现）
- [ ] 数据迁移：`gitnexus analyze --force` 重索引所有仓
- [ ] 测试矩阵：S2/S3/S4/S5 所有 cypher query 在 KuzuDB 跑通
- [ ] 删除 lbug 相关代码 + lbug-adapter / lbug 全局锁机制

### 3.3 长期（产品化）— 直接 fork upstream

- [ ] 决策：本仓继续做"团队自建版"（在 OSS 1.x 之上加 7 阶段闭环 + S6/S7），还是把这套贡献回 upstream
- [ ] 如果继续自建：每次 OSS 主版本升级，rebase 7 阶段闭环到新 main，跑全套 e2e 回归
- [ ] 如果回贡：拆 PR 到 abhigyanpatwari/GitNexus（webhook server / pipeline orchestrator / preview / auto-pr）

---

## 4. 升级时机决策（cheatsheet）

```
git fetch upstream  &&  npm view gitnexus version

主版本号变了 (1.x → 2.x):
  → 必须同步评估 (3.2 中期方案)
  → 跑 cypher 兼容性测试
  → 测 7 阶段闭环 e2e 没回归

次版本号变了 (1.4 → 1.5):
  → 探测 GitNexus 新加的 MCP 工具是否影响桥接
  → 跑 e2e 看 bridge 仍工作 → 没问题就保留 mvp 桥接

补丁版本 (1.4.1 → 1.4.2):
  → 通常无影响; 留意是否修了 KuzuDB schema bug
```

---

## 5. 危险信号（看到就立刻同步）

| 信号 | 来源 | 动作 |
|---|---|---|
| `gitnexus eval-server` 启动失败 | 升级后 binary 不兼容 | 立即 rollback 全局到 1.4.1 + 修桥接 |
| 桥接 fetch 报 `Cannot find tool 'impact'` | latest 改了 MCP 工具名 | bridge 适配层加路由表 |
| KuzuDB schema 报 `Table X does not exist` | latest 改了 schema | 重 analyze + 看 schema diff |
| webhook server 启动 lbug 报 dlopen 失败 | npm install 时 native build 没装好 | `cd gitnexus && npm install --build-from-source @ladybugdb/core` |

---

## 6. 给后续接手者（or 自己）

记住一条铁律：

> **真业务流量靠的是 `gitnexus eval-server` (latest binary)，
> 不是本仓 src tree 的 lbug。
> src tree 是开发 + 测试场，全局 binary 是数据源。**

短期不要动 lbug。等 OSS 2.0 出来后一起切。

---

## 7. 记录历史

| 日期 | 事件 |
|---|---|
| 2026-04-29 | mvp/v1.1.0 落地，全局 gitnexus 1.4.1 索引 cses-java + mattermost；本仓 src tree 跟全局不通；启用 eval-server HTTP 桥接 |
| TBD | OSS 1.5.x 升级 — 补此处 |
| TBD | OSS 2.0.x 升级 — 必须切 KuzuDB |
