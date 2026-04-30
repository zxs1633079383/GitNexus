# e2e/v0.2.0-overnight（2026-04-27）

> Tag: `e2e/v0.2.0-overnight`
> 通宵 e2e 验证骨架可跑 — 第一个真把 trace → issue → pipeline → MR 串起来的实测

## 目标

mvp/v1.0.0 / v1.1.0 实现的骨架在**真 issue + 真 webhook + mock S3-S6** 下能不能跑通?

## 验证 setup

- webhook server 跑在本机 :3034
- GitLab 真发 issue → webhook 触发
- pipeline 跑 mock S2-S7
- 不真发 MR（dryRun）

## 真验证

详见 [overnight-validation-report.md](../overnight-validation-report.md)（同目录）

骨架可跑 ✓，发现 backlog：
- mock S2 输出固定 contractId，后续要真接
- mock S3 假 blast，要接 GitNexus
- S6 没真起 K8s
- S7 没真发 MR

## 下一里程碑

- mvp/v1.1.0: 真接 S5/S6/S7 实现层
- single-repo/v1.0.x: 真闭环
