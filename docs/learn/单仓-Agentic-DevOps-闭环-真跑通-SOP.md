# 单仓 Agentic DevOps 闭环 · 真跑通 SOP

> 沉淀自 2026-04-29 真闭环落地（cses/java/cses/cses 仓 issue#18-#22 系列）。
> 配套 tag：`mvp/v1.0.0` → `mvp/v1.3.0-llm-patch` + `e2e/v0.5.0-llm-patch` + `single-repo/v1.0.0`。
> 配套图：[`diagrams/16-agentic-devops-7-stage-loop.mmd`](diagrams/16-agentic-devops-7-stage-loop.mmd)
> 守轨规则：[`/CLAUDE.md`](../../CLAUDE.md) §⚓ 主航道。

本文回答：**给一个新仓 / 新成员，怎么从 0 跑通"线上 issue → 自动开真改代码 PR"**。

---

## 0. 一句话本质

```
线上出错 → /observe 建 issue → webhook → 7 阶段 pipeline → claude -p 出真补丁 → 真发 MR
```

7 阶段不是空架子，每段都已端到端真跑过：

| Stage | 真产物 | 不靠 LLM 的硬约束 |
|---|---|---|
| pre · P1 reindex | webhook 收 push 事件 → 校验索引 stale → reindex | HMAC sha256 |
| **S1 观测** | Jaeger trace + Prom 指标 → 自动建 issue | 外部驱动 |
| **S2 锚点** | trace span → handler symbol UID | normalizer 5 层 fallback + stacktrace |
| **S3 爆炸** | impact() → blast radius (40+ 真业务文件) | KuzuDB 索引时算好的边 |
| **S4 溯源** | git log ∩ blast radius → 嫌疑 commit | （当前 mock，待接真 git log）|
| **S5 生成** | 真断言测试（claude 写） | R-1 安全：禁止 fail("TODO") |
| **S6 执行** | K8s preview ns 跑 test → JUnit XML | ns 必须 `gitnexus-preview-*` |
| **S7 回写** | 真发 PR/MR 含真改代码 + 真测试 | R-12 policy + 三因子 LIVE 闸 |
| 横切 ORCH | Pipeline Orchestrator 串 S2-S7 + 失败兜底 + 评论 | mock/真两路对称 |

**唯一的"硬真相层"是 S3** —— 索引时算好的图，Agent 可以信任。其他层都可能漂。

---

## 1. 前置依赖（一次性）

| 依赖 | 命令 / 路径 | 验证 |
|---|---|---|
| 全局 GitNexus 1.4.1 | `npm i -g gitnexus` | `gitnexus --version` = 1.4.1 |
| 业务仓索引 | `gitnexus analyze --path /path/to/repo` | `gitnexus list` 看到 |
| 业务仓本地 clone | `git clone <url> /tmp/cses-pre/<name>` | LLM cwd 用 |
| GitLab PAT | 仓 Settings → Access Tokens | `curl -H "PRIVATE-TOKEN: <pat>" .../api/v4/user` 200 |
| K8s kubeconfig | admin 权限 (能创 ns / Deploy / Job) | `kubectl auth can-i create namespace` = yes |
| claude CLI | `which claude` 已登录 | `echo "ok" \| claude -p` 返回 |
| node 22 + tsx | 本仓 npm i | `npx tsx --version` |

---

## 2. 起 eval-server（GitNexus HTTP 桥）

```bash
nohup gitnexus eval-server --port 4848 > /tmp/gnx-eval.log 2>&1 &
disown
sleep 3
curl -s http://localhost:4848/health
# {"status":"ok","repos":[..."cses-java",..."mattermost"]}
```

**eval-server 是什么**：GitNexus 1.4.1 binary 自带的轻量 HTTP server，把 4 个 MCP 工具暴露成 POST 端点：
- `POST /tool/cypher` — 稳定，bridge 主用
- `POST /tool/impact` — **1.4.1 对部分输入会 crash server，回避**
- `POST /tool/context` / `POST /tool/query` — 360 视图 / 搜索
- `GET /health`

**响应坑**：body 是 `<JSON>\n---\nNext: <hint>` 拼接体不是纯 JSON，`mcp-bridge.callCypher` 切 `\n---\n` 之后 trailer 才能 parse。

---

## 3. 起 webhook server（cses-pre 接入）

### 3.1 推荐启动命令（多仓 + LLM patch 全开）

```bash
cd /Users/mac28/workspace/java/zlc_ai/GitNexus/gitnexus

GITNEXUS_GITLAB_SECRET='<32+ 字符随机 hex>' \
GITNEXUS_AUTOPR_TOKEN_MAP='{"owner1/repo1":"glpat-...","owner2/repo2":"glpat-..."}' \
GITNEXUS_BRIDGE_REPO_MAP='{"owner1/repo1":"<eval-server alias 1>","owner2/repo2":"<alias 2>"}' \
GITNEXUS_REPO_PATH_MAP='{"owner1/repo1":"/tmp/repo1","owner2/repo2":"/tmp/repo2"}' \
GITNEXUS_LLM_BUDGET_USD=1.5 \
GITNEXUS_AUTOPR_LIVE=1 \
GITNEXUS_PROVIDER=gitlab \
GITLAB_API_BASE=http://<gitlab-host>/api/v4 \
JAEGER_QUERY_BASE=http://<jaeger-host>:32281 \
PORT=3034 \
nohup npx tsx scripts/start-webhook-server.ts > /tmp/gnx-server.log 2>&1 &
disown
echo "$!" > /tmp/gnx-server.pid
```

### 3.2 启动日志期望

```
🚀 GitNexus webhook server (cses-pre) listening on 0.0.0.0:3034
  bridge       ✅ eval-server 通 (default repo=..., 17 indexed)
  tokens       2 per-repo (TOKEN_MAP)
  repoMap      {"owner1/repo1":"alias1",...}
  llmPatch     ✅ 2 repo (claude -p budget=$1.5)
```

每条 ✅ 都必须看到。

### 3.3 env 速查表

| env | 用途 | 缺失行为 |
|---|---|---|
| `GITNEXUS_GITLAB_SECRET` | webhook 验签 | FATAL exit |
| `GITNEXUS_AUTOPR_TOKEN_MAP` | 多仓 PAT 路由 | 单仓回退用 `GITNEXUS_AUTOPR_TOKEN` |
| `GITNEXUS_BRIDGE_REPO_MAP` | GitLab fullName → eval-server alias | 用 `GITNEXUS_BRIDGE_REPO` 默认 |
| `GITNEXUS_REPO_PATH_MAP` | 启用 LLM 必需，本地 clone 路径 | 不配 → 该仓 genFix=undefined → fallback scaffold |
| `GITNEXUS_LLM_BUDGET_USD` | 单次 claude 调用上限 | 默认 1.0 |
| `GITNEXUS_AUTOPR_LIVE` | =1 真发 MR；否则 dryRun | 默认 dryRun (安全) |

---

## 4. 配 GitLab webhook（API 全自动，无 UI 点击）

```bash
SECRET='<同上面 GITNEXUS_GITLAB_SECRET>'
HOOK_URL='http://<server-host>:3034/webhook'
TOKEN='<glpat-...>'
PROJECT='owner%2Frepo'   # URL 编码

# 1. 列现有 hook
curl -s -H "PRIVATE-TOKEN: $TOKEN" \
  "http://<gitlab-host>/api/v4/projects/$PROJECT/hooks"

# 2. 新建（或 PUT 更新已有）
curl -s -X POST \
  -H "PRIVATE-TOKEN: $TOKEN" -H "Content-Type: application/json" \
  -d "{\"url\":\"$HOOK_URL\",\"token\":\"$SECRET\",\"issues_events\":true,\"merge_requests_events\":true,\"push_events\":false,\"enable_ssl_verification\":false}" \
  "http://<gitlab-host>/api/v4/projects/$PROJECT/hooks"
```

**关键**：
- `issues_events=true` → issue.opened 触发主链路
- `enable_ssl_verification=false` → server 走 HTTP 时必须关
- `token` 字段 = GITNEXUS_GITLAB_SECRET（webhook 共享密码）

---

## 5. 触发巡检：构造 issue body

issue body 必须含 `<!-- gitnexus:trace -->` 块。最完整版：

```markdown
<!-- gitnexus:trace -->
{
  "repo": "owner/repo",
  "baseBranch": "main",
  "serviceImage": "nginx:alpine",         <- S6 真启 K8s
  "testImage": "busybox:latest",
  "testCommand": ["sh","-c","printf '===JUNIT-XML===\n<?xml version=\"1.0\"?><testsuites><testsuite tests=\"1\" failures=\"0\"><testcase name=\"smoke\"/></testsuite></testsuites>\n===END-JUNIT-XML===\n'"],
  "spans": [{
    "traceID": "x", "spanID": "y",
    "operationName": "POST /api/foo",
    "tags": [{"key":"http.method","value":"POST"},{"key":"http.route","value":"/api/foo"}],
    "logs": [{"fields":[
      {"key":"event","value":"exception"},
      {"key":"exception.type","value":"java.lang.NullPointerException"},
      {"key":"exception.message","value":"Cannot invoke ... because xx is null"},
      {"key":"exception.stacktrace","value":"java.lang.NullPointerException: ...\n\tat com.x.y.Foo.bar(Foo.java:42)\n"}
    ]}],
    "process": {"serviceName": "my-service"}
  }]
}
<!-- /gitnexus:trace -->
```

`spans` vs `traceUrl` 二选一。`traceUrl` 让 server 自动从 Jaeger 拉真 trace（需 `JAEGER_QUERY_BASE` 配置）。

### 三因子 LIVE 安全闸

真发 MR/PR 必须**三个全满足**，少一个都安全 dryRun：

1. issue label 含 `gitnexus:auto-pr-live`
2. server env `GITNEXUS_AUTOPR_LIVE=1`
3. S6 真绿勾（preview env JUnit pass）

通过 GitLab API 建 issue 时同时打 label：

```bash
curl -s -X POST -H "PRIVATE-TOKEN: $TOKEN" -H "Content-Type: application/json" \
  -d "{\"title\":\"...\",\"labels\":\"gitnexus:auto-pr-live,gitnexus-test\",\"description\":$(jq -Rs . < body.md)}" \
  "http://<gitlab-host>/api/v4/projects/$PROJECT/issues"
```

---

## 6. 链路逐 stage 真执行（issue#22 实跑参考）

输入 → 触发 → 各 stage 实际做什么 → 落地产物。**每段都注明文件位置**。

### Stage 0: webhook 收单（毫秒级）

`gitnexus/src/server/webhook/handler.ts:mountWebhookRoutes`
- 验 `X-Gitlab-Token` HMAC = SECRET
- 解析 body → `event-parser-gitlab.ts` 拆出 `{fullName, issueNumber, issueBody, issueLabels}`
- 路由到 `issueTrigger` 回调

server log：
```
[issue] cses/java/cses/cses #22 labels=gitnexus:auto-pr-live,gitnexus-test,llm-patch
```

### Stage 0.5: deps factory 选 token + 选 bridge repo

`scripts/start-webhook-server.ts:buildDeps(fullName)`
- `pickToken(fullName)` 从 TOKEN_MAP 找
- `pickBridgeRepo(fullName)` 从 BRIDGE_REPO_MAP 找
- `getProvider(fullName)` 缓存 GitLabPRProvider 实例
- 返回带 9 个 dep 的 OrchestratorDeps（含可选 genFix）

### Stage 2 · S2 Trace2Code Resolver

`scripts/start-webhook-server.ts:deps.resolveSpan` → `mcp-bridge.resolveHandler`

1. `normalizeJaegerSpan(span)` → 5 层 fallback 拿 contractId + topFrame
2. 候选 method 名: `[stack 顶帧 method, code.function, contractId 末段]`
3. 三层 fallback cypher 反查 `Method` 节点：name+file → name+class → name-only
4. 命中 → 返 `Method:<filePath>:<name>:<startLine>` UID

server log：
```
→ pipeline spans=1 preview=true prTarget=true dryRun=false bridgeRepo=cses-java
```

issue#22 实跑产物：
```
Method:server/.../TaskMemberReader.java:loadSnapshot:93
```

### Stage 3 · S3 Blast Radius

`scripts/start-webhook-server.ts:deps.apiBlastRadius` → `mcp-bridge.blastRadius`

双路径：
1. **主路径**: shell out `gitnexus impact <name> -r <repo>` → 真算法 JSON（risk + processes + modules + byDepth）
2. **兜底**: `/tool/cypher` 的 `MATCH (m:Method {name})<-[*1..N]-(other)` → 走遍 caller 链

cses-java 这个 index 没接 typed call-resolution，CLI 全返 `impactedCount=0`，自动落到 cypher fallback，找到 30+ 真业务 caller 文件。

### Stage 4 · S4 Forensics（待接真 git log）

当前 mock 返 `suspects: []`。要真接：
1. 拿 `handler.filePath`
2. 在 REPO_PATH_MAP[fullName] 路径执行 `git log -p HEAD~50..HEAD -- <handler.filePath>`
3. 与 blast radius 文件交叉
4. rank by 时间近度

### Stage 5 · S5 Test Generator

orchestrator 先调 `deps.genE2ETests` 拿 scaffold 路径名，再走 LLM 阶段（见下）。

### Stage 5.5 · LLM Patch（mvp/v1.3.0-llm-patch）

`src/core/pipeline/orchestrator.ts:225-265` 调 `deps.genFix?.(...)`：

`scripts/start-webhook-server.ts:deps.genFix` → `scripts/patch-runner.runPatch`：

1. 拼 prompt 含 handler.filePath + errorContext + blast radius 30 文件
2. spawn `claude -p --output-format=stream-json --input-format=stream-json --verbose --json-schema='{...}' --system-prompt='<R-14 隔离>' --add-dir <repo path> --allowedTools "Read Glob Grep Bash(git diff:*) ..." --max-budget-usd 1.5`
3. 流式接收 events → onEvent 把每条 tool_use / text 打到 server log
4. 等 `result` event → 扫 events 找 `tool_use StructuredOutput` 拿 `input` 字段（这才是真 JSON，不是 result.text）
5. parse JSON → fixFiles + testFiles + reasoning
6. caller 走 `violatesSafetyPolicy(path)` 二次过路径白名单

LLM 实际行为（issue#22 trace）：
- Read TaskMemberReader.java
- Glob 同包 Test_*.java
- Grep `AssertUtil` 看仓内已有的 assertion 风格
- 多次 Read / Glob 确认上下文
- StructuredOutput 出 patch
- 总耗时 ~3.5min, cost ~$1.4

server log（节选）：
```
→ genFix start: repoPath=/tmp/cses-pre/cses-java handler=...
   [claude] init session=886e3332
   [claude] [tool_use Read]
   [claude] [tool_use Glob]
   ...
   [claude] [tool_use StructuredOutput]
   [claude] done cost=$1.42 dur=215332ms err=false
← genFix done: ok=true fix=1 tests=1 cost=$1.42 dur=221747ms
```

### Stage 6 · S6 K8s Preview Env

`scripts/start-webhook-server.ts:deps.validateInPreview` → `core/preview/preview-job-manager.ts`

1. 生成 ns: `gitnexus-preview-<8 位 shortId>`（`assertNsAllowed` 强制前缀）
2. `kubectl create ns ...` + `kubectl apply` Deployment(serviceImage) + Service
3. 等 Deployment Ready
4. `kubectl create job` 跑 testImage + testCommand
5. 等 Job 完成
6. `kubectl logs` → `result-collector.parseJUnit` 抓 `===JUNIT-XML===...===END-JUNIT-XML===` 包夹的 XML
7. 解析 pass/fail/skip → `S6Output { jobId, ns, finalStatus, testResult, pass }`
8. `pass = passed > 0 && failed == 0`
9. TTL 1800s 自动 GC（reaper 后台跑）

issue#22 实跑：
```
namespace: gitnexus-preview-520c91 (TTL 30min, 自动 GC)
finalStatus: done | pass: ✅ true
pass=1 fail=0 skip=0 exit=0
```

**生产 ns 永远不会被碰** — `core/preview/k8s-client.ts:assertNsAllowed` 是最后一道线。

### Stage 7 · S7 Auto-PR/MR

`src/core/pipeline/orchestrator.ts:265-330` → `core/auto-pr/auto-pr.runAutoPR`

stages 详情（每条都有 stageResult）：

1. **policy** — `core/auto-pr/policy.checkPolicy(files)` 过 R-12 黑名单（`.github/workflows/**` / `.env*` / `.pem` / `.key` / `secrets/**`）
2. **branch** — `provider.ensureBranch({owner, repo, baseBranch, branch=auto-fix/issue-N})`
3. **put-files** — 对每个 candidateFile 调 `provider.putFile({op})`
   - **op=update** for fixFiles（改既有文件，PUT）
   - **op=create** for testFiles + 报告（新建，POST）
4. **create-pr** — `provider.createPR(...)` 拿 MR iid
5. **labels** — `provider.addLabels(['auto-fix','gitnexus-pipeline'])`

issue#22 实跑：
```
finalBranch: auto-fix/issue-22
✅ policy (0ms)
✅ branch (282ms)
✅ put-files (3380ms) — pushed 3 file(s)
✅ create-pr (347ms) — !27 http://.../merge_requests/27
✅ labels (383ms)
```

3 文件分别是：
- `.gitnexus/reports/auto-pr-issue-22.md` (CREATE)
- `server/.../TaskMemberReader.java` (UPDATE)
- `server/.../TaskMemberReaderTest.java` (CREATE)

---

## 7. 验真 DOD

每次跑完检查这 4 个证据：

```bash
ISSUE=22
PROJECT='cses%2Fjava%2Fcses%2Fcses'
TOKEN='glpat-...'

# 1. issue 评论里 7 阶段全绿
curl -s -H "PRIVATE-TOKEN: $TOKEN" \
  "http://<host>/api/v4/projects/$PROJECT/issues/$ISSUE/notes" | \
  python3 -c "import sys,json; print([n for n in json.load(sys.stdin) if 'Pipeline' in n.get('body','')][0]['body'])"

# 2. MR 真创建
curl -s -H "PRIVATE-TOKEN: $TOKEN" \
  "http://<host>/api/v4/projects/$PROJECT/merge_requests?state=opened&order_by=created_at&per_page=3"

# 3. MR diff 含真改代码 (不只是 .gitnexus/reports/)
curl -s -H "PRIVATE-TOKEN: $TOKEN" \
  "http://<host>/api/v4/projects/$PROJECT/merge_requests/<iid>/changes" | \
  python3 -c "import sys,json; [print(c['new_path'],'op=update' if not c['new_file'] else 'op=create') for c in json.load(sys.stdin)['changes']]"

# 4. 测试文件含真断言 (没有 fail("TODO"))
curl -s -H "PRIVATE-TOKEN: $TOKEN" \
  "http://<host>/api/v4/projects/$PROJECT/repository/files/<test-path-encoded>/raw?ref=auto-fix%2Fissue-$ISSUE" | \
  grep -E 'assertThrows|assertEquals|assertTrue|assertNotNull'
```

---

## 8. 已踩过的坑 + 解法

| 坑 | 症状 | 修法 |
|---|---|---|
| eval-server `/tool/impact` 部分输入直接 crash server | curl 后 server 退出，无 error log | bridge 不要 carry HTTP impact，shell out CLI 或走 cypher fallback |
| eval-server 响应不是纯 JSON | `JSON.parse` fail，rows 永远 = [] | `mcp-bridge.callCypher` 切 `\n---\n` 之后 trailer |
| KuzuDB 1.4.1 schema 没 Route 节点 | `MATCH (rt:Route)-...` 报 "Table Route does not exist" | 走 Method.name + filePath/class 反查（ID 格式 `Method:<path>:<name>:<line>`）|
| Anthropic API top-level oneOf 不支持 | claude -p 报 `tools.8.custom.input_schema: input_schema does not support oneOf` | 单一 schema 全 optional，由 prompt 约束语义 |
| `--json-schema` 模式 result.result 不是 JSON | parse 永远失败 | 扫 events 找 `tool_use StructuredOutput`，拿 `input` 字段 |
| put-files 报 "A file with this name already exists" | LLM 改既有文件用 op=create | fixFiles 用 op=update，testFiles 用 op=create |
| `--bare` 模式 401 Not logged in | bare 强制 ANTHROPIC_API_KEY，本机用 OAuth | 不用 bare，接受每次 ~$0.35 cache 创建 |
| 老 webhook server PID 没 env 没法重启 | macOS 不让非 root 看进程 env | 起前先把 env 写到 .env.local 或 systemd unit |
| 生产 cluster admin 误操作风险 | 一次 kubectl 误删生产 ns | `core/preview/k8s-client.ts:assertNsAllowed` 强制 `gitnexus-preview-*` 前缀 |

---

## 9. milestone tag 时间线

```
mvp/v1.0.0              7 阶段闭环代码完成
mvp/v1.1.0              Jaeger 真接入 + e2e v0.3
mvp/v1.2.0-bridge       eval-server HTTP 桥, S2/S3 真索引
mvp/v1.2.0-bridge.1     CLI 主路径 + cypher fallback + 多仓 token
mvp/v1.3.0-llm-patch    claude-cli LLM 真改代码 + 真断言

e2e/v0.1.0-yundiz       真 GitLab 单次验证
e2e/v0.2.0-overnight    隔夜 13 维度
e2e/v0.3.0-real-jaeger  真 Jaeger 端到端
e2e/v0.4.0-live-bridge  完整 7 阶段 LIVE 闭环 (issue#18 → MR!24)
e2e/v0.5.0-llm-patch    LLM 真改 Java 代码 (issue#22 → MR!27)

single-repo/v1.0.0      ⭐ 单仓 Agentic DevOps 闭环达成
```

---

## 10. 单仓 → 多仓的下一步

单仓闭环完成后，扩多仓只是**配置层**变化（代码已支持）：

1. `gitnexus group create --name <group>` + `group add --repo <each>`
2. `gitnexus group analyze --group <group>` 建 contract registry + bridge.lbug
3. start-webhook-server env 加更多 entry：
   - TOKEN_MAP / BRIDGE_REPO_MAP / REPO_PATH_MAP 都加新仓
4. 三个 webhook 配同一 `http://<server>:3034/webhook`
5. 触发后 S3 cross_depth=1 自动算跨仓影响（`core/group/cross-impact.ts`）

跨仓 issue 触发 → A 仓 contract 改 → S3 找出 B/C 仓的 handler 也受影响 → S5/S6/S7 在 A 仓发 MR 但 PR body 含跨仓 caller。

详细见 `session.md` §17.B "跨仓 group 接入"。

---

## 11. 给下一个会话（接力指南）

读完顺序（10 分钟）：
1. `/CLAUDE.md` §⚓ 主航道（守轨规则）
2. 本文（怎么跑通）
3. `session.md` §0-§3（项目意图 + 现状）
4. `session.md` §15.5 + §18.5（mvp/v1.2 + 1.3 落地经验）

启动顺序（5 分钟）：
1. `gitnexus eval-server --port 4848 &`
2. `nohup npx tsx scripts/start-webhook-server.ts ...` (env 见 §3.1)
3. 验启动日志全 ✅
4. `curl /health` 200

第一个动作建议：在测试仓建一个 issue 含 metadata + label live → 观察 server log → 看 MR 是否真发。

---

## 12. 心法

> 真的把流程跑通的代价就是要在每个 stage 设一个**不可绕过的硬约束**：
> - S3 必须靠索引（不是 LLM 猜的）
> - S6 必须有 ns 前缀守门
> - S7 必须有 R-12 policy 黑名单
> - LLM 必须有 R-14 system prompt 隔离
> - 真发 MR 必须三因子全满足
>
> 任何一个绕过，整套就成了"看上去自动化的玩具"。守住这些线，才能让 Agent 的输出**值得信任**。
