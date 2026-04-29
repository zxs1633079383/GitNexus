# GitNexus Agentic DevOps 闭环 — 业务仓多仓接入 Quickstart

> 把 `cses/java/cses/cses` (Java 主仓 pre 分支) + `cses/go/mattermost` (Go Mattermost 二开 pre-k8s 分支)
> 接到 GitNexus，跑通真闭环：trace → 嫌疑 commit → 测试脚手架 → K8s preview → 自动 MR。
> 本次配置同时作为**生产可用范本**，沉淀给后续接入业务仓复用。
>
> 最后更新：2026-04-29 · 配套版本：mvp/v1.1.0

---

## 0. 目标 — 一图看懂这次接入要干什么

```
你内网 GitLab 仓 (cses 命名空间下)
       │
       ├─ /observe (你 skill, 外部) cron 巡检 Jaeger
       │   发现 5xx / 慢响应 / SLO 违约
       │   → 调 GitLab Issues API 自动建 issue (body 嵌 metadata 块)
       │
       │ webhook (Issue Hook)
       ▼
GitNexus server (本机 / 内网某 VM)
   POST /webhook/gitlab → X-Gitlab-Token 验签
   → issue-handler 解析 metadata
   → jaeger-fetcher 调你 192.168.6.66:32281 拉真 spans
   → run_pipeline (S2-S7)
       · S2 Phase 0 normalize → 算 contractId
       · S3 GitNexus blast radius (跨仓 contract registry)
       · S4 git log ∩ blast radius (找嫌疑 commit)
       · S5 沿调用链生成测试脚手架
       · S6 真 K8s namespace 起 preview pod 跑测试 (拿绿勾)
       · S7 真 GitLab createMR + addLabels + postIssueComment
       │
       ▼
你内网 GitLab 仓自动出现:
   · auto-fix/issue-N 分支
   · MR (description 含 7 阶段报告 + 嫌疑 commit + 测试列表 + 绿勾)
   · 原 issue 上自动评论 (markdown 格式 PipelineReport)
```

---

## 1. 本次要接的两个业务仓

| 仓 | URL | 业务定位 | pre 环境分支 | 主语言 |
|---|---|---|---|---|
| **cses-java** | http://git.yundiz.com/cses/java/cses/cses | CSES 后端核心 (Spring Boot) | `pre` | Java |
| **cses-go-mattermost** | http://git.yundiz.com/cses/go/mattermost | Mattermost 二次开发 (IM 后端) | `pre-k8s` | Go |

**两仓关系（这是为什么要做 group）**：
- cses-java 是核心业务，对外暴露 HTTP/gRPC API
- mattermost 二开消费 cses-java 的部分接口（IM 通道、用户中心）
- 跨仓 contract 边由 GitNexus group 自动算（HTTP route ↔ HTTP consumer / proto / Kafka topic）
- **一个仓改 contract，能在跨仓 blast radius 看到另一个仓被影响的代码** ← 招牌能力

---

## 2. 🔴 前置条件清单（你去配，每项打勾后我开干）

按以下清单跟我同步，每项缺一不可。**安全相关字段贴 issue 时只贴最后 4 位即可，全文私发我一份**。

### A. GitLab access token（必需，1 个）

我需要一个能**同时访问** `cses/java/cses/cses` + `cses/go/mattermost` 两个仓的 PAT，权限：

| Scope | 用途 |
|---|---|
| `api` 或 `read_api` + `read_repository` | clone + 调 API（必需）|
| `write_repository` | createMR 时推 branch + 文件（live mode 必需，dryRun 不需要）|

**获取**：GitLab → 你的头像 → Edit profile → Access Tokens → Create

> 当前你给的两个 token (`glpat-usw79WL...` / `glpat-ELT-_V-...`) 只能访问 `zhanglichao/...`，对 `cses/...` 返 404。需要新 token。

打勾后请告诉我：`GITNEXUS_AUTOPR_TOKEN=glpat-xxxxx`

### B. Webhook 共享密码（必需，1 个，你随便定）

用于 webhook 验签。GitLab webhook 设置里填 + GitNexus server env 里填，两边对得上即可。

例：`GITNEXUS_GITLAB_SECRET=cses-pre-webhook-2026`

打勾后告诉我密码原文（或你自己保管，告诉我"已配，密码是 X"）。

### C. 业务镜像信息（必需 — S6 真验证需要）

按之前看到的 Harbor 形态推断：

| 仓 | 镜像 tag 推测 | 测试命令推测 |
|---|---|---|
| cses-java pre | `harbor.jinqidongli.com/x9-java/cses-server:<pre-tag>` | `java -jar /test.jar`? mvn test? |
| cses-go-mattermost pre-k8s | `harbor.jinqidongli.com/x9-go/mattermost-pre:<tag>`? | `go test ./...`? |

**需要你确认**：

1. 两个仓 pre 分支 build 出来的镜像确切 tag
2. 测试入口命令（含 JUnit XML 输出方式）—— GitNexus S6 期望测试容器把 XML 包在
   `===JUNIT-XML===` / `===END-JUNIT-XML===` 之间打到 stdout
3. 如果测试需要外部依赖（数据库 / Pulsar / Redis），告诉我 K8s 上现有的 service DNS

如果业务镜像没有 ready test 容器：本次先用 `busybox:1.36` 跑虚拟测试验证链路通，**真实业务测试容器后做**。

### D. Jaeger / Prom（已就绪）

| 项 | 值 | 状态 |
|---|---|---|
| Jaeger Query base | http://192.168.6.66:32281 | ✅ 已修复 (你昨晚修 NetworkPolicy 后通) |
| Prom base | （这次链路不直接用）| — |

**无需你额外操作**，配 `JAEGER_QUERY_BASE` 即可。

### E. K8s preview namespace（已就绪）

之前 stage-6/v0.1.0 已在你 cluster apply 过：
- `gitnexus-preview-test` (test-root, 永不 GC)
- ServiceAccount `gitnexus-preview-runner`
- ClusterRole `gitnexus-preview-manager` (cluster-wide ns 创建/删除权限)
- ClusterRoleBinding

**无需你额外操作**。但如果你想加 NetworkPolicy 限制 `gitnexus-preview-*` ns 内的 pod 不能访问生产 ns（最佳实践），可以下次单独做。

### F. GitNexus server 跑在哪台机器（你定 + 提供 IP）

GitLab webhook 要能 POST 到这台机器 8080 端口（或你定的端口）。

候选：
1. **你内网某 VM** — 推荐，GitLab 内网直接访问最简单
2. **我本地 mac** — 我跑过 5 次 e2e 都用的本地，但 GitLab webhook 推不进我的 mac（mac 在外网）
3. **K8s 内 deployment** — 最规范但要写 yaml + service expose

**最快出 demo 的选择**：你现有任何一台能 ssh 的内网 Linux/mac VM 都行，我远程跑 `gitnexus serve` 即可。**告诉我能 ssh 的目标主机和路径**，或者你自己跑（我把启动命令写给你）。

### G. 业务仓的 push webhook（推荐配，但 issue 触发不依赖）

P1 Auto-reindex Webhook 用 — 仓里 push 后自动 reindex，让 S3-S5 用最新图。
跟 issues webhook 同一个 endpoint（GitLab 一个 webhook 配置勾 Push + Issues 即可）。

### H. /observe skill 输出格式（你那边产出 issue 的方式）

确认一下 `/observe` 建 issue 时 body 嵌的 metadata 块格式跟我们约定一致（见 §17.D 模板）。
如不一致，告诉我你那边输出什么字段名，我适配。

### I. 接入清单总结表（你抄一份打勾用）

| # | 项 | 你做完告诉我 |
|---|---|---|
| A | GitLab PAT 能访问 cses/* | `GITNEXUS_AUTOPR_TOKEN=glpat-xxxx` |
| B | webhook 共享密码 | `GITNEXUS_GITLAB_SECRET=xxxx` |
| C1 | cses-java pre 镜像 tag | `harbor.jinqidongli.com/x9-java/...` |
| C2 | cses-java 测试命令 | `java -jar ...` |
| C3 | mattermost pre-k8s 镜像 tag | `harbor.jinqidongli.com/x9-go/...` |
| C4 | mattermost 测试命令 | `go test ...` 或 jar |
| F | server 跑在哪 + IP | `192.168.x.y` |
| H | /observe metadata 格式 | "跟 §17.D 一致" / "我用 X 字段名" |

**最少 A + B + F 凑齐就能开工**（C1-C4 缺则 S6 用 busybox 兜底跑通链路；H 缺则你建测试 issue 时手贴 metadata 块）。

---

## 3. 配置步骤（前置 OK 后我执行）

### Step 1：clone + 索引两个业务仓

```bash
cd /Users/mac28/workspace/java/zlc_ai/GitNexus/gitnexus

# 用 PAT clone
GIT_USER=oauth2
GIT_PASS=$GITNEXUS_AUTOPR_TOKEN
git clone "http://${GIT_USER}:${GIT_PASS}@git.yundiz.com/cses/java/cses/cses.git" \
  --branch pre /tmp/cses-java
git clone "http://${GIT_USER}:${GIT_PASS}@git.yundiz.com/cses/go/mattermost.git" \
  --branch pre-k8s /tmp/cses-mattermost

# 索引
gitnexus analyze --path /tmp/cses-java
gitnexus analyze --path /tmp/cses-mattermost

# 验证两个仓都有 Route 节点 (S2 反查 handler 用)
gitnexus mcp --tool query --params '{ "cypher": "MATCH (r:Route) RETURN r.uid LIMIT 5" }'
```

### Step 2：建 group + group analyze（跨仓 contract）

```bash
gitnexus group create --name cses-pre
gitnexus group add --group cses-pre --repo /tmp/cses-java
gitnexus group add --group cses-pre --repo /tmp/cses-mattermost

# 算跨仓 contract registry + bridge.lbug
gitnexus group analyze --group cses-pre

# 验证跨仓边: cses-java HTTP route 应能在 mattermost 找到 consumer
gitnexus mcp --tool api_blast_radius --params '{
  "target_uid": "Method:<cses-java 任一 controller>",
  "direction": "downstream",
  "depth": 2,
  "cross_depth": 1
}'
```

### Step 3：启动 GitNexus server（含 webhook + MCP）

```bash
export GITNEXUS_GITLAB_SECRET='<你 B 项给的密码>'
export GITNEXUS_AUTOPR_TOKEN='<你 A 项给的 PAT>'
export GITNEXUS_PROVIDER=gitlab
export GITLAB_API_BASE=http://git.yundiz.com/api/v4
export JAEGER_QUERY_BASE=http://192.168.6.66:32281
# 默认 dryRun，true 时 issue 加 'gitnexus:auto-pr-live' 标签也不真发
# 真发请同时 export GITNEXUS_AUTOPR_LIVE=1
gitnexus serve --port 8080 --host 0.0.0.0
```

启动日志应打印：
```
GitNexus server running on http://localhost:8080
  webhook  POST http://localhost:8080/webhook/gitlab (X-Gitlab-Token plain)
```

### Step 4：在 GitLab 两个仓里各配一个 webhook

每仓重复一次：

GitLab → 仓 → Settings → Webhooks → Add new webhook：
- URL: `http://<F 项你给的 IP>:8080/webhook/gitlab`
- Secret token: 同 `GITNEXUS_GITLAB_SECRET`
- Trigger: ✅ Issues events ✅ Push events ✅ Merge request events
- SSL verification: 看 server 协议（http 取消勾选）
- Add webhook

测试：webhook 列表里点 "Test → Issues events" 看 server 端有没有收到。

### Step 5：跑一次端到端验证

**(A) 在 cses-java 仓建一个测试 issue**：

```markdown
## 巡检告警 — 测试 GitNexus 闭环

trace: <从你 Jaeger 找一个真 trace>

<!-- gitnexus:trace -->
{
  "repo": "cses/java/cses/cses",
  "baseBranch": "pre",
  "traceUrl": "http://192.168.6.66:32281/trace/<trace-id>",
  "serviceImage": "harbor.jinqidongli.com/x9-java/cses-server:<C1>",
  "testImage": "harbor.jinqidongli.com/x9-java/cses-server:<C1>",
  "testCommand": ["sh", "-c", "<C2>"]
}
<!-- /gitnexus:trace -->
```

**(B) 看 issue 自动出现 GitNexus 7 阶段评论**

约 30s-3min（看 S6 K8s 起 preview 多快）后，issue 上自动出现：

```markdown
## GitNexus 7 阶段闭环报告 — issue #N

| Stage | Status | Duration | Note |
|---|---|---|---|
| S2 resolve | ok | xms | N spans |
| S3 blast | ok | xms | |
| S4 forensics | ok | xms | |
| S5 testgen | ok | xms | |
| S6 preview | ok | xms | pass=true |
| S7 auto-pr | ok | xms | dryRun |
```

**(C) 切 live 真发**

issue 加标签 `gitnexus:auto-pr-live`：

```bash
curl -X PUT \
  -H "PRIVATE-TOKEN: $GITNEXUS_AUTOPR_TOKEN" \
  "http://git.yundiz.com/api/v4/projects/<project-id>/issues/<iid>?add_labels=gitnexus:auto-pr-live"
```

并 server 重启加 `export GITNEXUS_AUTOPR_LIVE=1`。重新 reopen 那个 issue → webhook 再触发 → 这次真发 MR + 真贴评论。

---

## 4. 跨仓 group blast radius 实战示例

接入完成后，假设 cses-java 一个 controller 改了 API：

```java
// cses-java/.../OrderController.java
- @PostMapping("/api/order/create")
+ @PostMapping("/api/order/v2/create")
  public OrderResponse create(@RequestBody OrderReq req) { ... }
```

跑 `api_blast_radius cross_depth=1`：

```json
{
  "target_uid": "Method:OrderController.create",
  "files": ["src/main/java/.../OrderController.java"],   // cses-java 自己
  "cross": [
    {
      "repo": "cses-go-mattermost",                       // 跨到 mattermost!
      "uid": "Func:postSender.callOrderApi",              // 这里调了
      "filePath": "src/order_client/sender.go",
      "via": "http::POST::/api/order/create",             // contract 边
      "risk": "HIGH"
    }
  ]
}
```

**这就是 GitNexus 的招牌**：`/api/order/v2/create` 改名后，自动告诉你 mattermost 的 sender.go 也得跟着改。`/observe` 拿到这条 trace 后，建一个 issue 同时附带跨仓影响列表，**一个 issue 触发跨仓 PR**。

---

## 5. 生产可用 checklist（v1.0 最小可上）

| # | 项 | 状态 |
|---|---|---|
| 1 | GitNexus server 跑在内网常驻 | ⚪ 你定 |
| 2 | systemd / k8s deployment 守护 | ⚪ 推荐做 |
| 3 | webhook secret 用强随机串 (>=20 字符) | ⚪ 你做 |
| 4 | PAT 至少每 90 天 rotate 一次 | ⚪ 你定流程 |
| 5 | `GITNEXUS_AUTOPR_LIVE` 默认不开 | ✅ 默认安全 |
| 6 | `gitnexus:auto-pr-live` 标签由谁能加要走 GitLab Role | ⚪ 你定 |
| 7 | preview ns 限流 (max 3 并发) | ✅ 默认 |
| 8 | preview ns 30min TTL 自动 GC | ✅ 默认 |
| 9 | namespace 前缀守门 (`gitnexus-preview-*` only) | ✅ 默认硬约束 |
| 10 | auto-pr-policy.yaml 黑名单 (.github / .env / .pem) | ✅ 默认 |
| 11 | patch-llm systemPrompt 隔离 | ✅ 默认 |
| 12 | 业务测试容器输出 JUnit XML stdout marker | ⚪ 你接 CI 出 |
| 13 | 监控 server 自身 (Prom 抓 metrics endpoint) | 待做 (后续) |
| 14 | 跨仓 group analyze 定时全量 | ⚪ 推荐做 (cron 每 1h) |

---

## 6. Troubleshooting 速查

| 现象 | 排查 |
|---|---|
| webhook 401 | 看 GitLab → Webhook → Edit → Recent Deliveries → 看请求头 X-Gitlab-Token 是否传对 + server `GITNEXUS_GITLAB_SECRET` 是否匹配 |
| issue 评论没出 | 1) issue body 含 `<!-- gitnexus:trace -->` 块？2) GitLab webhook 设置勾了 Issues events？3) server 启动日志有看到 webhook 路由挂上？4) tail server log 看 issue_opened 事件是否到 |
| MR 没真发 | 默认 dryRun。需要 issue 加 `gitnexus:auto-pr-live` 标签 + server `GITNEXUS_AUTOPR_LIVE=1` + S6 必须绿勾（require_stage6_pass）|
| S6 总是失败 | 业务测试容器要输出 JUnit XML 到 stdout，包在 `===JUNIT-XML===` 和 `===END-JUNIT-XML===` 之间。或先用 busybox 验证链路通 |
| Jaeger 拉 trace 拿不到 | jaeger-v2 pod 状态 `kubectl get pod -n jaeger-cses`，CrashLoop 一般是 ES NetworkPolicy 拦截 |
| 跨仓 cross[] 是空 | group analyze 跑过没？bridge.lbug 是否存在？两个仓 contract identifier 是否对得上（HTTP method+path / proto FQN / kafka topic）|
| auto-fix 分支冲突 | branch-manager Fix-11 自动加 ts 后缀；如还冲突删掉旧的 |

---

## 7. 后续扩展（不阻塞 v1）

- 把 `/observe` 巡检 cron 化，定时扫 Jaeger 错率高的 trace 自动建 issue
- group 加 `xpa-*` 系列仓（你 cluster 看到的 xpa-server / xpa-server-pre）
- patch-llm 真接 LLM（替换 stub），让 PR 含**真 fix patch** 不只是测试脚手架
- monitoring：暴露 `/metrics` 给 Prom 抓 GitNexus 自身 RED 指标
- migrate webhook secret 到 K8s Secret（不再 env 直配）

---

## 附录 A — 本次接入实测产物（接入完后我会回填）

| 项 | 值 |
|---|---|
| cses-java 索引 Node 数 | TBD |
| mattermost 索引 Node 数 | TBD |
| group bridge.lbug 跨仓边数 | TBD |
| 第一次端到端 e2e 真 issue | TBD |
| 第一次自动 MR | TBD |
| 端到端总耗时 | TBD |

---

**协议握手**：你按 §2 清单凑齐 A + B + F 三项告诉我，我立刻开始 Step 1-5。其他项 (C/G/H) 缺则用兜底跑通，**再迭代真业务**。
