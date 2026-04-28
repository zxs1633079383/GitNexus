// Stage 6 · 默认 PreviewDriver — 真实 K8s 操作
//
// PreviewJobManager 通过这个 driver 调 k8s-client；测试可注入自定义 driver
// 让纯逻辑用例不依赖集群（但 e2e 集成测试用真实 driver 跑 busybox sanity）。

import {
  applyDeploymentAndService,
  createPreviewNamespace,
  deletePreviewNamespace,
  listExpiredManagedNamespaces,
  runTestJob,
} from './k8s-client.js';
import type { EnrichedTestResult } from './result-collector.js';
import type { PreviewDriver, PreviewJob } from './types.js';

export class K8sPreviewDriver implements PreviewDriver {
  async spinUp(job: PreviewJob): Promise<void> {
    const ttlSec = Math.max(60, Math.floor((job.expiresAt - Date.now()) / 1000));
    await createPreviewNamespace(job.ns, { ttlSeconds: ttlSec });
    await applyDeploymentAndService({
      ns: job.ns,
      serviceName: job.spec.serviceName,
      serviceImage: job.spec.serviceImage,
      servicePort: job.spec.servicePort,
      readyTimeoutSec: 120,
    });
  }

  async runTests(job: PreviewJob): Promise<EnrichedTestResult> {
    return runTestJob({
      ns: job.ns,
      jobName: `${job.spec.serviceName}-tests`,
      testImage: job.spec.testImage,
      testCommand: job.spec.testCommand,
      timeoutSec: 300,
    });
  }

  async teardown(ns: string): Promise<void> {
    await deletePreviewNamespace(ns);
  }

  async reapExpired(): Promise<string[]> {
    const expired = await listExpiredManagedNamespaces();
    for (const ns of expired) {
      try {
        await deletePreviewNamespace(ns);
      } catch {
        // reaper 静默吞错；下一轮再试
      }
    }
    return expired;
  }
}
