// Stage 6 · PreviewJobManager — worker pool + queue + reaper
//
// 设计要点：
//  · MAX_CONCURRENT_PREVIEW (默认 3, R-3): 同时跑的 preview env 数上限
//  · 队列溢出: 排队，每条 job 自带 queuePosition
//  · TTL: 每个 ns 注解 expires-at；reaper 后台扫管理标签下的过期 ns
//  · 异常隔离: 单 job spin/test 失败不影响其他 job，driver 错误吞到 job.error

import { randomUUID } from 'node:crypto';
import { K8sPreviewDriver } from './preview-driver.js';
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TTL_SECONDS,
  NS_PREFIX,
  REAPER_INTERVAL_MS,
  type PreviewDriver,
  type PreviewJob,
  type PreviewJobManagerOptions,
  type PreviewSpec,
} from './types.js';

export class PreviewJobManager {
  private readonly maxConcurrent: number;
  private readonly driver: PreviewDriver;
  private readonly jobs = new Map<string, PreviewJob>();
  private readonly queue: string[] = [];
  private readonly active = new Set<string>();
  private reaperTimer?: ReturnType<typeof setInterval>;

  constructor(opts: PreviewJobManagerOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.driver = opts.driver ?? new K8sPreviewDriver();
    if (opts.autoReaper !== false) this.startReaper();
  }

  /** 新建 job → 入队（queuePosition 从 1 开始）→ tryDrain 启动空闲槽位 */
  enqueue(spec: PreviewSpec): PreviewJob {
    const id = randomUUID();
    const shortId = id.slice(0, 6);
    const ttl = spec.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const now = Date.now();
    const job: PreviewJob = {
      id,
      shortId,
      ns: `${NS_PREFIX}${shortId}`,
      status: 'queued',
      spec,
      createdAt: now,
      expiresAt: now + ttl * 1000,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.refreshQueuePositions();
    this.tryDrain();
    return job;
  }

  getJob(id: string): PreviewJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): PreviewJob[] {
    return [...this.jobs.values()];
  }

  /** 当前活跃 job 数（spinning_up + running_tests + collecting） */
  activeCount(): number {
    return this.active.size;
  }

  queueLength(): number {
    return this.queue.length;
  }

  /** 关闭：停 reaper（不主动 teardown 已 active 的 ns；交给 K8s TTL annotation）。 */
  dispose(): void {
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.reaperTimer = undefined;
  }

  /** 测试入口：跑一次 reaper 而非等 60s 间隔。返回被清的 ns 列表。 */
  async reapOnce(): Promise<string[]> {
    return this.driver.reapExpired();
  }

  // ── 内部：填充 queuePosition ───────────────────────────────────────
  private refreshQueuePositions(): void {
    this.queue.forEach((qid, idx) => {
      const j = this.jobs.get(qid);
      if (j && j.status === 'queued') j.queuePosition = idx + 1;
    });
  }

  // ── 内部：从 queue 抽 job 进 active 槽 ────────────────────────────
  private tryDrain(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) break;
      const job = this.jobs.get(id);
      if (!job) continue;
      this.active.add(id);
      job.queuePosition = undefined;
      // 不 await，让多个 job 真正并发
      this.runJob(job).finally(() => {
        this.active.delete(id);
        this.refreshQueuePositions();
        this.tryDrain();
      });
    }
    this.refreshQueuePositions();
  }

  // ── 内部：单 job 状态机 ─────────────────────────────────────────────
  private async runJob(job: PreviewJob): Promise<void> {
    job.startedAt = Date.now();
    try {
      job.status = 'spinning_up';
      await this.driver.spinUp(job);
      job.status = 'running_tests';
      const result = await this.driver.runTests(job);
      job.status = 'collecting';
      job.testResult = result;
      job.status = 'done';
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.finishedAt = Date.now();
      // 不阻塞：teardown 失败由 reaper 兜底
      try {
        await this.driver.teardown(job.ns);
      } catch {
        // ignore — reaper 会重试
      }
    }
  }

  // ── 内部：reaper 定时器 ────────────────────────────────────────────
  private startReaper(): void {
    this.reaperTimer = setInterval(() => {
      this.driver.reapExpired().catch(() => {
        // reaper 静默吞错；下一轮再试
      });
    }, REAPER_INTERVAL_MS);
    // 不阻塞 process exit
    if (typeof this.reaperTimer.unref === 'function') {
      this.reaperTimer.unref();
    }
  }
}
