// Stage 6 · MCP 工具实现 (R-3 异步)
//
// 把 validate_in_preview / check_preview_status 抽出成纯模块函数，
// 让 LocalBackend 只做 dispatch + DI，测试不必拉起整个 lbug 后端。

import type { PreviewJobManager } from './preview-job-manager.js';

export interface ValidateInPreviewParams {
  service_image?: unknown;
  service_name?: unknown;
  service_port?: unknown;
  test_image?: unknown;
  test_command?: unknown;
  ttl_seconds?: unknown;
  junit_output_path?: unknown;
}

export interface ValidateInPreviewResult {
  jobId?: string;
  status?: string;
  queuePosition?: number;
  ns?: string;
  expiresAt?: number;
  hint?: string;
  error?: string;
}

export function validateInPreview(
  mgr: PreviewJobManager,
  params: ValidateInPreviewParams,
): ValidateInPreviewResult {
  const required = ['service_image', 'service_name', 'test_image', 'test_command'] as const;
  for (const k of required) {
    if (!params[k]) return { error: `${k} is required` };
  }
  const cmd = params.test_command;
  if (!Array.isArray(cmd) || cmd.some((x) => typeof x !== 'string')) {
    return { error: 'test_command must be string[]' };
  }
  const job = mgr.enqueue({
    serviceImage: params.service_image as string,
    serviceName: params.service_name as string,
    servicePort: params.service_port as number | undefined,
    testImage: params.test_image as string,
    testCommand: cmd as string[],
    junitOutputPath: params.junit_output_path as string | undefined,
    ttlSeconds: params.ttl_seconds as number | undefined,
  });
  return {
    jobId: job.id,
    status: job.status,
    queuePosition: job.queuePosition,
    ns: job.ns,
    expiresAt: job.expiresAt,
    hint: 'Poll check_preview_status({job_id}) until status in [done, failed].',
  };
}

export interface CheckPreviewStatusParams {
  job_id?: unknown;
}

export interface CheckPreviewStatusResult {
  jobId?: string;
  status?: string;
  queuePosition?: number;
  ns?: string;
  error?: string | null;
  testResult?: unknown;
  timing?: {
    createdAt: number;
    startedAt: number | null;
    finishedAt: number | null;
    elapsedMs: number;
  };
}

export function checkPreviewStatus(
  mgr: PreviewJobManager,
  params: CheckPreviewStatusParams,
): CheckPreviewStatusResult {
  const jobId = params.job_id;
  if (typeof jobId !== 'string' || jobId.length === 0) {
    return { error: 'job_id is required' };
  }
  const job = mgr.getJob(jobId);
  if (!job) return { error: `job ${jobId} not found (may be GC'd or wrong id)` };
  const elapsedMs =
    (job.finishedAt ?? Date.now()) - (job.startedAt ?? job.createdAt);
  return {
    jobId: job.id,
    status: job.status,
    queuePosition: job.queuePosition,
    ns: job.ns,
    error: job.error ?? null,
    testResult: job.testResult ?? null,
    timing: {
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
      elapsedMs,
    },
  };
}
