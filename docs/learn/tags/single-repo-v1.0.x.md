# single-repo/v1.0.0 ~ v1.0.4（2026-04-25 ~ 2026-04-28）

> Tags: `single-repo/v1.0.0` `v1.0.1` `v1.0.2` `v1.0.3` `v1.0.4`
> 4 个递进 tag 覆盖单仓 7 阶段闭环从 mock → 真接 → 真发 MR → LLM patch 真改业务代码

## 演进轨迹

### single-repo/v1.0.0（骨架闭环）
- Pipeline Orchestrator S2~S7 串通，全 mock deps
- mock S2: 假 contractId、假 handler UID
- mock S3: 假 blast radius
- mock S5: scaffold 文件路径（不真生成）
- mock S6: 直接返 pass
- mock S7: dryRun，不真发 MR
- 验证：骨架可跑，但产出全是假数据

### single-repo/v1.0.1 ~ v1.0.3（真接逐项）
- v1.0.1: S6 接真 K8s preview-job-manager（`gitnexus-preview-*` ns 守门）
- v1.0.2: S7 接真 GitLab MR API + R-12 policy 闸（block `.github/workflows/**` `.env*` `.pem` `.key` `secrets/**`）
- v1.0.3: S2 normalizer 真接（接 jaeger-span-normalizer 5 层 fallback）

### single-repo/v1.0.4（**MVP 真闭环**, 2026-04-28）
- issue #18 → MR !24 全 7 阶段 LIVE 闭环
- ns `gitnexus-preview-fe54c1` 真起 30min TTL 自动 GC
- MR diff 真有 `.gitnexus/reports/auto-pr-issue-18.md`，全部真 cses-java 业务文件路径
- 生产 pods (`cses-server-pre` 等) AGE 不变，preview ns 自动 teardown

| Stage | Status | Duration | 真产物 |
|---|---|---|---|
| S2 resolve | ✅ ok | 663ms | `Method:server/.../TaskMemberReader.java:loadSnapshot:93` |
| S3 blast | ✅ ok | 791ms | 40 真业务文件 (ViewReader/WorkItemReader/TaskCreateCmdHandler …) |
| S4 forensics | ✅ ok (空) | 0ms | bridge 已通, 仓盘 git log 接入留 backlog |
| S5 testgen | ✅ ok | 0ms | scaffold `Test_loadSnapshot.java` |
| S6 preview | ✅ pass=1 fail=0 | 9004ms | ns `gitnexus-preview-fe54c1` |
| S7 auto-pr | ✅ MR opened | 2483ms | [!24](http://git.yundiz.com/cses/java/cses/cses/-/merge_requests/24) |

## LIVE 三因子开关（首次落地）

```bash
export GITNEXUS_AUTOPR_LIVE=1
# issue label 加 'gitnexus:auto-pr-live'
# S6 必须真 pass (require_stage6_pass)
```

三个条件**同时满足**才会真发。

## 默认安全闸

| 闸 | 行为 |
|---|---|
| dryRun 默认 true | 没 live label → 永远不真发 |
| `require_stage6_pass` | S6 没绿勾 → 自动拒发 + 评论解释 |
| auto-pr-policy 默认 | 自动 block `.github/workflows/**` 等敏感路径 |
| patch-llm systemPrompt | R-14 不允许动 workflow / 凭证 / 引入新依赖 |
| ns 前缀守门 | K8s 写操作必须 `gitnexus-preview-*` ns |

## 与下一里程碑 cross-repo/v1.0.0 衔接

single-repo/v1.0.4 跑通**单仓**全链路；cross-repo/v1.0.0 在此基础上加跨仓 ContractLink + 多仓 LLM context + S7 多 PR。

## 单仓 SOP

详细操作清单见 [单仓-Agentic-DevOps-闭环-真跑通-SOP.md](../单仓-Agentic-DevOps-闭环-真跑通-SOP.md)
