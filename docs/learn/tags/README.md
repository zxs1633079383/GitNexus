# 跨 tag 演进档案

记录从单仓 MVP 到跨仓 v1.0.0 再到 multi-trace LIVE 验证的每个阶段产物 + 决策 + 真 evidence。

## 时间线（最新 → 最早）

| Tag / 阶段 | 日期 | 核心产出 | 文档 |
|---|---|---|---|
| **observe-pipeline-integration** (无 tag) | 2026-04-30 | /Observe → pipeline 无缝集成；4 真跨仓 trace × 双向批量验证；4 commit 修 Function/Unknown/S5 lang/S2 渲染 | [observe-pipeline-integration.md](./observe-pipeline-integration.md) |
| **cross-repo/v1.0.0** | 2026-04-29 | 跨仓 ContractLink 首发；6 demo (#26~#31)；P2.3 partner suspects 真显示 | [cross-repo-v1.0.0.md](./cross-repo-v1.0.0.md) |
| **single-repo/v1.0.4** | 2026-04-28 | 单仓 LLM patch 真改业务代码 (#22→!27)；R-14.6 防幻觉护栏 | [single-repo-v1.0.4.md](./single-repo-v1.0.4.md) |
| **single-repo/v1.0.0~v1.0.3** | 2026-04-25~28 | 单仓 7 阶段闭环 (#18→!24)；K8s preview 真起；S7 真发 MR | [single-repo-v1.0.x.md](./single-repo-v1.0.x.md) |
| **e2e/v0.5.0-llm-patch** | 2026-04-29 | LLM patch runner 接 `claude -p` 真出补丁 | [e2e-v0.5.0-llm-patch.md](./e2e-v0.5.0-llm-patch.md) |
| **e2e/v0.4.0-live-bridge** | 2026-04-28 | LIVE 三因子闸 + 真 K8s preview pass + 真发 MR | [e2e-v0.4.0-live-bridge.md](./e2e-v0.4.0-live-bridge.md) |
| **mvp/v1.3.0-llm-patch** | 2026-04-28 | 接 patch-runner 雏形 | [mvp-v1.3.0-llm-patch.md](./mvp-v1.3.0-llm-patch.md) |
| **mvp/v1.2.0-bridge** | 2026-04-29 | mcp-bridge.ts 接 eval-server cypher，S2/S3 走真索引 | [mvp-v1.2.0-bridge.md](./mvp-v1.2.0-bridge.md) |
| **e2e/v0.3.0-real-jaeger** | 2026-04-29 | 真 Jaeger 拉 trace + Phase 0 normalizer 真接 | [e2e-v0.3.0-real-jaeger.md](./e2e-v0.3.0-real-jaeger.md) |
| **mvp/v1.1.0** | 2026-04-28 | Stage 5/6/7 MVP 实现 | [mvp-v1.1.0.md](./mvp-v1.1.0.md) |
| **mvp/v1.0.0** | 2026-04-28 | Phase 0 + S2-S7 mock 走通骨架 | [mvp-v1.0.0.md](./mvp-v1.0.0.md) |
| **e2e/v0.2.0-overnight** | 2026-04-27 | 通宵 e2e 验证骨架可跑 | [e2e-v0.2.0-overnight.md](./e2e-v0.2.0-overnight.md) |

## 阅读顺序建议

新人接力：从 [single-repo-v1.0.0~v1.0.4](./single-repo-v1.0.x.md) 看 MVP 闭环 → [cross-repo-v1.0.0](./cross-repo-v1.0.0.md) 看跨仓首发 → [observe-pipeline-integration](./observe-pipeline-integration.md) 看最新状态。

每篇文档结构固定：**目标 / 改动 / 真 evidence / 已知 backlog**。
