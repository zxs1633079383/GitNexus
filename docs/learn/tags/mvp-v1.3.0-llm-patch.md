# mvp/v1.3.0-llm-patch（2026-04-28）

> Tag: `mvp/v1.3.0-llm-patch`
> 接入 `gitnexus/scripts/patch-runner.ts` 让 S5 真出 LLM patch

## 目标

之前 S5 是 R-1 scaffold（占位文件），不真生成业务可用的修复。
本里程碑接入 `claude -p` 命令行，给 LLM 上下文（trace 异常 + handler 源码 + blast files + suspect commits）让它真出 patch。

## 关键改动

| 文件 | 内容 |
|---|---|
| `gitnexus/scripts/patch-runner.ts` | 🆕 包装 `claude -p` CLI，传 systemPrompt + 业务 context |
| `gitnexus/scripts/patch-llm.ts` (草案) | 接口 + R-14 安全约束 |
| `core/auto-pr/auto-pr.ts` | 接 patch 输出转 PRFilePatch |

## R-14 安全约束（systemPrompt 硬编码）

LLM 不允许：
- 改 `.github/workflows/**`
- 引入新依赖（package.json / go.mod / pom.xml）
- 改 `.env*` / `.pem` / `.key` / `secrets/**`
- 改 K8s manifest / CI 配置

LLM 必须：
- 看真源码后再判断（不靠 trace 揣测）
- trace 没 stacktrace / 没 code.function 时主动 abort
- 加测试覆盖 root cause 而不是改 happy path

## R-14.6 防幻觉护栏

LLM `StructuredOutput` 报告 `ok=false` 的合法原因：
- handler 不存在（filePath 路径找不到）
- blast radius 0 文件
- 已是修复后状态，没真 bug
- trace 数据不足以定位 root cause

之后跑 issue#10 / issue#36 都看到 LLM 主动 abort，是预期行为。

## 真验证

issue#22 → MR!27：LLM 真改 cses-java 业务代码（`MattermostClient.createPosts` 返回值类型从 `JsonObject` 改 `void`），跟 mattermost handler 不返回 postId 的契约对齐。

## 下一里程碑

- e2e/v0.5.0-llm-patch: 接到生产 webhook 流程
- cross-repo/v1.0.0: 跨仓 LLM context + 多 PR
