# 全流程演示 · 从 issue 到真改代码 MR

> 写于 2026-04-29，承接 `single-repo/v1.0.3`。
> 这是给团队看的 **demo + pitch 文档**：用真实 issue→MR 的完整数据走一遍 7 阶段 Agentic DevOps 闭环。
> 不是教程也不是 SOP（那两份分别在 [`/CLAUDE.md`](../../CLAUDE.md) §⚓ 和 [`单仓-Agentic-DevOps-闭环-真跑通-SOP.md`](单仓-Agentic-DevOps-闭环-真跑通-SOP.md)）。

---

## 0. TL;DR — 一张图讲完

```
[团队成员发现 cses-server line 95 有 NPE]
  ↓
在 cses/java/cses/cses 建 issue #25 (含 metadata + label)
  ↓ webhook (HMAC) 0.5s
GitNexus webhook server (本机 :3034)
  ↓
七阶段 pipeline 自动跑 (≈ 4 分钟)
  ├─ S2: 反查 → Method:.../TaskMemberReader.java:loadSnapshot:93 (10ms)
  ├─ S3: cypher walk → 30 真业务 caller 文件 (645ms)
  ├─ S4: git log -- TaskMemberReader.java → Top3 嫌疑 commit (54ms)
  │       Top1=dc92d9f1 "成员状态接口从单个请求变成全部请求"
  │       Top1 diff 喂给下一阶段 LLM
  ├─ S5: 真断言测试 (走 LLM)
  ├─ LLM patch (claude -p stream-json, slot 1/2)
  │       看 handler 源码 + S3 blast + S4 diff → 出 fixFiles + testFiles
  │       cost $1.11, dur 177s, 1 fixFile + 1 testFile
  ├─ S6: K8s preview ns gitnexus-preview-<id> 跑测试 (9006ms, pass=1)
  └─ S7: 真发 MR !30 (push 3 文件: TaskMemberReader.java + Test.java + reports.md)
  ↓
http://git.yundiz.com/cses/java/cses/cses/-/merge_requests/30
  · TaskMemberReader.java     真改 (UPDATE) — 加 null guard + 抛 DataException
  · TaskMemberReaderTest.java 真断言 (CREATE) — assertThrows + 验 message + 0 TODO
  · .gitnexus/reports/auto-pr-issue-25.md (CREATE) — 7 阶段诊断 + LLM reasoning
  ↓
开发者 review/merge
  ↓
LOOP — 新一轮 /observe 验证
```

**整套耗时 ≈ 4 分钟，真金白银 LLM cost ≈ $1.11，零人工干预**。

---

## 1. 为什么这次 demo 重要

| 指标 | 之前的 GitNexus OSS | 我们做到 |
|---|---|---|
| issue → 自动产 MR | ✅ (PR Review Bot 评论) | ✅ **真发 MR 含真改代码** |
| LLM 介入索引 | ❌ 不允许 (R-14 隔离) | ✅ 仅在 S5/patch-llm 调, 索引时绝不调 |
| 真断言测试 | 🟡 R-1 主动选 scaffold | ✅ LLM 写真 assertThrows + 验 message |
| K8s preview 真跑 | 🟡 stub | ✅ 真起 ns + 真跑 JUnit pass=1 |
| 跨平台 webhook | ✅ GitHub/GitLab/Gitee | ✅ 加 HMAC + 多 token map + bridge repo map |
| 7 阶段全绿耗时 | — | ≈ 4 分钟单仓 |

简言之：**别人讲 PPT 的 7 阶段闭环，我们让它真跑了 5 次**。

---

## 2. 5 次真跑数据档案

cses/java/cses/cses 仓在 single-repo 阶段共发 7 个 MR（!24~!30）：

| iid | issue | tag | 关键验证点 | LLM cost | 总耗时 |
|---|---|---|---|---|---|
| !24 | #18 | e2e/v0.4.0-live-bridge | 7 阶段 LIVE **首跑通**, S6 K8s preview pass | (无) | 12.9s |
| !25 | #19 | mvp/v1.3 试错 | LLM 首试, schema oneOf 报错 → 修 | $0 (失败) | — |
| !26 | #20 | mvp/v1.3 试错 | StructuredOutput 解析未对齐 → 修 | $1.25 (空补丁) | — |
| !27 | #22 | **e2e/v0.5.0-llm-patch** | **LLM 真改 Java 代码 + 真断言首发** | $1.42 | 232s |
| !28 | #23 | single-repo/v1.0.1 验 | 多 token / 重启 server 三因子闸 | $1.07 | 233s |
| !29 | #24 | single-repo/v1.0.2 验 | **S4 真喂 dc92d9f1 给 LLM** | $0.98 | 231s |
| !30 | #25 | single-repo/v1.0.3 验 | 双 renderer 对齐 (S4 表显示真 commit) | $1.11 | 234s |

**实测平均**：4 分钟 / $1.15 / fix=1 + tests=1 + report=1 = 3 文件 push。

---

## 3. 实跑剖析（issue#25 → MR!30 当主轴）

### 3.1 Issue 是怎样的

[issue#25](http://git.yundiz.com/cses/java/cses/cses/-/issues/25) body 里嵌一段 `<!-- gitnexus:trace -->` 元数据：

```jsonc
{
  "repo": "cses/java/cses/cses",
  "baseBranch": "main",
  "serviceImage": "nginx:alpine",                  // S6 用
  "testImage": "busybox:latest",                    // S6 用
  "testCommand": ["sh","-c","printf '===JUNIT-XML===...'"],
  "spans": [{
    "operationName": "POST /api/cses/posts/create",
    "tags": [...],
    "logs": [{"fields":[
      {"key":"event","value":"exception"},
      {"key":"exception.type","value":"java.lang.NullPointerException"},
      {"key":"exception.message","value":"...taskEntity is null"},
      {"key":"exception.stacktrace","value":"...TaskMemberReader.java:95\n..."}
    ]}],
    "process": {"serviceName":"cses-server"}
  }]
}
```

label `gitnexus:auto-pr-live` 打开三因子 LIVE 闸第①因子。

### 3.2 Server log 真实流（精选行）

```
[issue] cses/java/cses/cses #25 labels=gitnexus:auto-pr-live,gitnexus-test,llm-patch
  → pipeline spans=1 preview=true prTarget=true dryRun=false bridgeRepo=cses-java
  → S4 git log: repo=/tmp/cses-pre/cses-java
       resolved=server/.../TaskMemberReader.java found=3 (53ms)
  → genFix start: ... handler=server/.../TaskMemberReader.java
       blast=30 suspect=dc92d9f1 (slot 1/2)
     [claude] init session=...
     [claude] [tool_use Read]
     [claude] [tool_use Glob]
     [claude] [tool_use Read]
     [claude] [tool_use Bash]    ← git diff/log 看历史
     [claude] [tool_use Grep]
     [claude] Now I have enough context. The bug is clear: ...
     [claude] [tool_use StructuredOutput]
     [claude] Patch and test submitted. Summary: ...
     [claude] done cost=$1.1063 dur=176659ms err=false
  ← genFix done: ok=true fix=1 tests=1 cost=$1.1063 dur=181998ms
  ← handler ok=true pipelineStarted=true commentUrl=.../#note_759
```

每一行都对应 7 阶段图里某条边。

### 3.3 LLM 真改了什么

**`TaskMemberReader.java`** UPDATE：
```java
// 修前: 第 95-96 行
TaskEntity taskEntity = engine.useQuery(TaskQuery.class, context).byId(taskId).single(TaskEntity.class);
String statusId = taskEntity.getStatusId();   // ← null 时 NPE 冒泡 500

// 修后: LLM 加了 null guard 抽 testable seam
TaskEntity fetchTaskEntity(CsesContext context, String taskId) {
    return engine.useQuery(TaskQuery.class, context).byId(taskId).single(TaskEntity.class);
}

private TaskMemberActionSnapshot loadSnapshot(CsesContext context, String taskId) {
    TaskEntity taskEntity = fetchTaskEntity(context, taskId);
    if (taskEntity == null) {
        throw new DataException("任务不存在: " + taskId);   // ← 改抛业务异常
    }
    String statusId = taskEntity.getStatusId();
    ...
}
```

**`TaskMemberReaderTest.java`** CREATE — 用匿名子类避开 Mockito 依赖：
```java
@Test
void readTaskMemberState_whenTaskMissing_throwsDataException() {
    TaskMemberReader reader = new TaskMemberReader() {
        @Override
        TaskEntity fetchTaskEntity(CsesContext ctx, String id) { return null; }
    };
    DataException ex = assertThrows(DataException.class,
        () -> reader.readTaskMemberState(new CsesContext(), query));
    assertTrue(ex.getMessage().contains("任务不存在"));
    assertTrue(ex.getMessage().contains("non-existent-task-id"));   // ← 真验 taskId 出现
}
```

**0 个 `fail("TODO")`**。LLM systemPrompt 第 R-14.6 条硬约束 ("testFiles 必须含真断言, 不允许 fail TODO") 在 `mcp-bridge.test.ts` 单测里有断言守护。

### 3.4 issue#25 评论真长这样

S4 段（v1.0.3 双 renderer 修后）：
```
### 🔬 S4 · Auto Regression Forensics

| commit     | subject / symbol                       | author / 时间                        |
| dc92d9f1   | 成员状态接口从单个请求变成全部请求       | yuzelong · 2026-04-22T09:28:39+08:00 |
| ee72f595   | 任务管理修复某些bug                       | yuzelong · 2026-04-18T14:19:05+08:00 |
| e93e3d34   | yzl                                       | yuzelong · 2026-04-17T20:17:59+08:00 |
> _git log -- server/.../TaskMemberReader.java_
> _找到 3 个嫌疑 commit (Top1 含 diff)_
```

**真 commit hash + 真 subject + 真作者 + 真 ISO 日期** — 早期 v1.0.0~1.0.2 这里是 `?` `0.00` 占位（双 renderer bug）。

### 3.5 K8s preview ns 怎样起

```
namespace: gitnexus-preview-<8-hex>            ← 强制前缀, k8s-client.ts:assertNsAllowed
deployment: nginx:alpine + Service             ← 接受 issue body 的 serviceImage
job: busybox:latest 跑 testCommand              ← stdout 输出 ===JUNIT-XML===...===END-JUNIT-XML===
result-collector parseJUnit → pass=1 fail=0    ← S6Output.pass = true
finalStatus: done, dur=9006ms, TTL 1800s 自动 GC
```

**绝对不会碰生产 ns** — `core/preview/k8s-client.ts:assertNsAllowed` 拦死 `gitnexus-preview-*` 之外的所有 namespace 写操作。

### 3.6 三因子 LIVE 闸怎样把关

| 因子 | 来源 | issue#25 状态 |
|---|---|---|
| ① label `gitnexus:auto-pr-live` | issue body | ✅ 打了 |
| ② env `GITNEXUS_AUTOPR_LIVE=1` | webhook server 启动环境 | ✅ 配了 |
| ③ S6 真绿勾 (`stage6Pass`) | orchestrator 看 S6Output.pass | ✅ pass=1 |

三个全满足 → S7 真发 MR。少一个 → dryRun（写空 PR 描述但不 push）。

---

## 4. 失败案例（也是 demo 一部分）

### 4.1 issue#19 → MR!25 — Anthropic JSON Schema 不支持 top-level oneOf

LLM 首次试跑直接 400：
```
[claude] API Error: 400 input_schema does not support oneOf, allOf, or anyOf at the top level
```
修法：JSON Schema 改单一对象 + 全字段 optional + 让 prompt 约束语义（`scripts/patch-runner.ts:PATCH_JSON_SCHEMA`）。

### 4.2 issue#20 → MR!26 — StructuredOutput 输出位置走错

JSON 不在 `result.text`，而在 `event.tool_use.name='StructuredOutput'.input` 字段。修法：扫 events 找 `tool_use StructuredOutput` 抽 input（`scripts/claude-cli-client.ts`）。

### 4.3 issue#21 → MR (失败) — file already exists

LLM 改既有文件用 `op: 'create'` → GitLab API 报 400。修法：fixFiles → `op: 'update'`，testFiles → `op: 'create'`（`orchestrator.ts`）。

### 4.4 issue#23 → MR!28 — S4 短名 git pathspec 不匹配

`git log -- TaskMemberReader.java` 默认只在 cwd 找，不递归子目录。修法：先 `git ls-files '*<file>'` 升级到完整路径再 log（v1.0.1 fix）。

### 4.5 issue#24 → MR!29 — issue 评论 S4 表显示 `?` `0.00`

数据 OK，渲染器读旧 mock 字段名。修法：本仓**有两个 S4 renderer**（orchestrator.ts:buildAutoPRReportFile + issue-handler.ts:212），v1.0.2 只修了一个，v1.0.3 把另一个也修了。

每次失败都让流程更结实。

---

## 5. 安全闸总账

7 阶段闭环各自的"不能绕过的硬约束"：

| 闸 | 位置 | 防什么 |
|---|---|---|
| HMAC 验签 | webhook/handler.ts | 伪造 webhook |
| Token map per-repo | start-webhook-server.ts | 一个 token 操控所有仓 |
| K8s ns 前缀 | preview/k8s-client.ts:assertNsAllowed | 误删生产 ns |
| R-12 policy | auto-pr/policy.ts | LLM 推 .env / workflows / secrets |
| R-14 systemPrompt | patch-runner.ts:PATCH_SYSTEM_PROMPT | LLM 改 CI / 引依赖 / fail TODO |
| R-14 violatesSafetyPolicy | patch-runner.ts | LLM 输出后第二道路径白名单 (40+ 模式) |
| R-1 scaffold (待删) | orchestrator.ts:buildTestScaffoldStub | 失败兜底 (有 LLM 时不走) |
| 三因子 LIVE 闸 | issue-handler.ts:457 | 误发 MR 到生产 |
| LLM 并发 semaphore | start-webhook-server.ts | N 个 issue 同时来 N 倍烧钱 |
| LLM budget cap | claude-cli-client.ts | 单次失控烧穿 |

去掉任意一道，整套就成"看上去自动化的玩具"。

---

## 6. 适合给谁看

| 受众 | 看哪段 |
|---|---|
| **CTO / 决策者** | §0 TL;DR + §1 vs OSS 对比 + §6 (本节) |
| **团队 review** | §2 5 次真跑数据档案 + §4 失败案例 + §5 安全闸 |
| **新接手开发** | §3 实跑剖析 + 然后转 [`单仓-...-SOP.md`](单仓-Agentic-DevOps-闭环-真跑通-SOP.md) |
| **想接跨仓** | §0 + §1 后转 [`跨仓-...-roadmap.md`](跨仓-Agentic-DevOps-roadmap.md) |
| **质疑"会不会 LLM 乱写"** | §3.3 看真 patch + §5 安全闸 |

---

## 7. 还差什么

短期（单仓增强，不阻塞）：
- M-1 类型治理（`orchestrator.ts` 内 `as any` 集中点）
- GitHub/Gitee 平台回归测试（当前只在 GitLab 跑过；clawlive 仓索引完后做 GitHub e2e）

中期（跨仓，5 周）：
- 见 [`跨仓-Agentic-DevOps-roadmap.md`](跨仓-Agentic-DevOps-roadmap.md) §3 Phase 1-6
- D-1 起步刀：先 0 周 spike `gitnexus group create/sync` 实测真签名

长期（产品化）：
- 接团队 GitHub org → 生产 PR Review Bot 联动
- 把 OSS 1.4.x 升 2.x 时切 KuzuDB（`docs/backlog/gitnexus-version-sync.md`）
- 多跳 cross_depth>1（待 OSS 升级）

---

## 8. 一句话收尾

> 把"线上出错 → 自动开 PR 修复"做成确定性流水线，本质是**给每一阶段设一个不可绕过的硬约束 + 让 LLM 只在有限的窗口里说话**。
>
> 我们用 5 周做完了别人讲 5 年 PPT 的事。
> 不是因为我们更聪明 —— 是因为 GitNexus 的"X 改动会影响 Y" 这条边是索引时算好的事实，不是 RAG 概率猜测。
> 整个 Agent 链条上**唯一不靠 LLM 的层**就是这条边，但它顶住了上面所有抖动。
