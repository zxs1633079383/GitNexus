# e2e/v0.4.0-live-bridge（2026-04-28）

> Tag: `e2e/v0.4.0-live-bridge`
> LIVE 三因子闸 + 真 K8s preview pass + 真发 MR

## 目标

之前所有 e2e 都是 dryRun（不真发）。本里程碑首次三因子全开 + 真 K8s preview 真起 + 真发 MR。

## 三因子开关

```bash
# ① server env
export GITNEXUS_AUTOPR_LIVE=1

# ② issue label
'gitnexus:auto-pr-live'

# ③ S6 真 pass (require_stage6_pass)
caller 必须传 serviceImage + testImage + testCommand
```

三个**同时满足**才真发，少一个都安全兜底。

## 真验证

issue#18 → MR !24（同 single-repo/v1.0.4 evidence）：
- ns `gitnexus-preview-fe54c1` 真起 30min TTL 自动 GC
- preview pod 跑 testCommand 真出 JUnit XML
- testResult source: junit, pass=1 fail=0
- S7 推 2 file (`.gitnexus/reports/auto-pr-issue-18.md` + `Test_loadSnapshot.java`)
- GitLab MR 真创建，含 `auto-fix` label

**关键**：`cses-server-pre` 等生产 pods AGE 不变，preview ns 自动 teardown，**没碰生产**。

## 安全闸默认值

| 闸 | 默认 | 行为 |
|---|---|---|
| dryRun | true | 没 live label → 永远不真发 |
| require_stage6_pass | true | S6 fail/skip → 拒发 |
| auto-pr-policy block | enabled | 自动 block `.github/workflows/**` 等 |
| ns 前缀守门 | enabled | 写操作必 `gitnexus-preview-*` |

## 下一里程碑

- mvp/v1.3.0-llm-patch: 接真 LLM
- cross-repo/v1.0.0: 跨仓闭环
