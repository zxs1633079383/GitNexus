# e2e/v0.5.0-llm-patch（2026-04-29）

> Tag: `e2e/v0.5.0-llm-patch`
> LLM patch runner 接 `claude -p` 真出补丁 + 真断言

## 目标

mvp/v1.3.0-llm-patch 实现了 `patch-runner.ts` 雏形，本里程碑把它**真接到生产 webhook**，让 issue 触发 → LLM 真读 + 真改 + 真断言。

## 真验证

issue#22 → MR!27：
- LLM 输入：trace 异常 + handler 源码 + 30 个 blast files + 嫌疑 commit
- LLM 输出：单仓修复 — 把 `MattermostClient.createPosts` 返回类型 `JsonObject` 改 `void`，跟 mattermost Go handler 不返回 postId 的契约对齐
- 加测试桩：`server/src/test/java/.../IMEditorCreatePostsTest.java`
- LLM cost: $1.71 / 9 min
- LLM 主动 abort（issue#27/#10/#36）也是预期行为 — R-14.6 防幻觉护栏

## R-14 安全约束实测

systemPrompt 硬编码后实测有效：
- LLM 不动 `.github/workflows/`
- 不引新依赖
- 不动凭证文件
- handler 找不到时主动 abort（不强塞）
- blast=0 时主动 abort

## 与 cross-repo/v1.0.0 衔接

e2e/v0.5.0-llm-patch 跑通**单仓 LLM**；cross-repo/v1.0.0 在此基础上加跨仓 context（让 LLM 同时看两仓代码，判断 root cause 在哪端）。

## 下一里程碑

- cross-repo/v1.0.0: 跨仓 LLM 上下文
- observe-pipeline-integration: /Observe → 全链路无缝集成
