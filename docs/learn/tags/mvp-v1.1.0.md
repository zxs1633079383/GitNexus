# mvp/v1.1.0（2026-04-28）

> Tag: `mvp/v1.1.0`
> Stage 5/6/7 MVP 实现完整骨架 + R-1 scaffold 模板

## 目标

把 v1.0.0 的全 mock S5/S6/S7 替换成可执行版（仍偏脚手架，但能跑出文件 / 跑容器 / 调 API）。

## Stage 5 · E2E Test Generator (R-1 scaffold)

- Java 模板硬编码：`Test_<methodName>.java` (JUnit) — 这条到本轮 da530cfd 才加 lang-aware skip
- unit + contract + integration 三层占位
- 输出文件名带 `auto-generated/` 前缀

## Stage 6 · K8s Preview Env Spinner

- `core/preview/preview-job-manager.ts` 入口
- `core/preview/k8s-client.ts` `assertNsAllowed` 强制 `gitnexus-preview-*` ns
- TTL 30min 自动 GC
- testCommand 输出 `===JUNIT-XML===...===END-JUNIT-XML===` 包夹 XML 解析

## Stage 7 · Auto-PR/MR Creator

- `core/auto-pr/auto-pr.ts` 入口
- 三平台 provider：GitHub / GitLab / Gitee
- R-12 auto-pr-policy block 列表（`.github/workflows/**` `.env*` `.pem` `.key` `secrets/**`）
- dryRun 默认 true，三因子全满足才真发
- 生成 `.gitnexus/reports/auto-pr-issue-N.md` 带完整 7 阶段报告

## 真 Jaeger 端到端验证

`pre` 环境上跑通：
- traceId `a9a3a507a29c7706cfc6f3ad1f454d40`（真 fixture，stacktrace 顶帧 `loadSnapshot#1`）
- 端到端：trace JSON → S2 normalizer → mock S3 → S5 scaffold → mock S6 pass → S7 dryRun

## 与下一里程碑

- mvp/v1.2.0-bridge: S2/S3 走真 KuzuDB cypher 反查（不再 mock）
- mvp/v1.3.0-llm-patch: 接 `claude -p` 真 LLM patch
