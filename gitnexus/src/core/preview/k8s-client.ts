// Stage 6 · K8s 操作 — 通过 kubectl shellout（避开新增 npm 依赖）
//
// 安全核心：assertNsAllowed() 守门 — 任何写命令的 namespace 都必须以
// gitnexus-preview- 开头。这一行代码是用户生产 namespace 的最后防线。

import { spawn } from 'node:child_process';
import { collectTestResult, type EnrichedTestResult } from './result-collector.js';
import {
  EXPIRES_ANNOTATION,
  MANAGED_LABEL,
  NS_PREFIX,
} from './types.js';

// ─── kubectl 调用 wrapper ──────────────────────────────────────────────

export interface KubectlResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 跑 kubectl，返回 stdout/stderr/exitCode；不直接 throw（错误由调用方判定）。 */
export function runKubectl(
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<KubectlResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`kubectl ${args.join(' ')} timeout after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs ?? 60_000);

    child.on('error', (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });

    if (opts.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/** 跑 kubectl，非 0 退出抛错。 */
export async function runKubectlOrThrow(
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<KubectlResult> {
  const r = await runKubectl(args, opts);
  if (r.exitCode !== 0) {
    throw new Error(
      `kubectl ${args.join(' ')} exited ${r.exitCode}: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return r;
}

// ─── 安全守门 ───────────────────────────────────────────────────────────

/**
 * 任何 ns 写操作进来都先过这道门。
 * 不允许操作 default / kube-system / 任何不带 gitnexus-preview- 前缀的 namespace。
 */
export function assertNsAllowed(ns: string): void {
  if (typeof ns !== 'string' || ns.length === 0) {
    throw new Error('namespace must be non-empty string');
  }
  if (!ns.startsWith(NS_PREFIX)) {
    throw new Error(
      `Refusing to operate on namespace "${ns}" — must start with "${NS_PREFIX}" (S6 prefix guard)`,
    );
  }
  // 防 path traversal / shell injection
  if (!/^[a-z0-9-]+$/.test(ns)) {
    throw new Error(
      `Invalid namespace "${ns}" — only [a-z0-9-] allowed (k8s naming + injection guard)`,
    );
  }
}

// ─── Namespace 生命周期 ───────────────────────────────────────────────

export interface CreateNamespaceOpts {
  ttlSeconds: number;
}

export async function createPreviewNamespace(
  ns: string,
  opts: CreateNamespaceOpts,
): Promise<void> {
  assertNsAllowed(ns);
  const expiresAt = Math.floor(Date.now() / 1000) + opts.ttlSeconds;
  await runKubectlOrThrow(['create', 'namespace', ns]);
  await runKubectlOrThrow([
    'label',
    'namespace',
    ns,
    `${MANAGED_LABEL}=true`,
    '--overwrite',
  ]);
  await runKubectlOrThrow([
    'annotate',
    'namespace',
    ns,
    `${EXPIRES_ANNOTATION}=${expiresAt}`,
    '--overwrite',
  ]);
}

export async function deletePreviewNamespace(ns: string): Promise<void> {
  assertNsAllowed(ns);
  // --wait=false: 不阻塞主流程；后续 reaper 会兜底
  // --ignore-not-found: 幂等
  await runKubectlOrThrow([
    'delete',
    'namespace',
    ns,
    '--wait=false',
    '--ignore-not-found=true',
  ]);
}

/** 列出所有由 GitNexus 管理且已过期的 ns 名（reaper 用）。 */
export async function listExpiredManagedNamespaces(): Promise<string[]> {
  const r = await runKubectlOrThrow([
    'get',
    'namespaces',
    '-l',
    `${MANAGED_LABEL}=true`,
    '-o',
    'json',
  ]);
  const json = JSON.parse(r.stdout);
  const items = (json.items ?? []) as Array<{
    metadata?: { name?: string; annotations?: Record<string, string>; labels?: Record<string, string> };
  }>;
  const nowSec = Math.floor(Date.now() / 1000);
  const expired: string[] = [];
  for (const it of items) {
    const name = it.metadata?.name;
    if (!name || !name.startsWith(NS_PREFIX)) continue;
    // test-root ns 不被 reaper 杀
    if (it.metadata?.labels?.['gitnexus.dev/role'] === 'test-root') continue;
    const exp = it.metadata?.annotations?.[EXPIRES_ANNOTATION];
    if (!exp) continue;
    if (Number(exp) <= nowSec) {
      expired.push(name);
    }
  }
  return expired;
}

// ─── Deployment / Service / Job apply（最小集） ─────────────────────────

export interface SpinUpServiceOpts {
  ns: string;
  serviceName: string;
  serviceImage: string;
  servicePort?: number;
  /** Pod readiness 等待最长时间（秒） */
  readyTimeoutSec?: number;
}

export async function applyDeploymentAndService(opts: SpinUpServiceOpts): Promise<void> {
  assertNsAllowed(opts.ns);
  const port = opts.servicePort ?? 80;
  const readyTimeout = opts.readyTimeoutSec ?? 120;

  const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${opts.serviceName}
  namespace: ${opts.ns}
  labels: { app: ${opts.serviceName} }
spec:
  replicas: 1
  selector: { matchLabels: { app: ${opts.serviceName} } }
  template:
    metadata: { labels: { app: ${opts.serviceName} } }
    spec:
      containers:
        - name: app
          image: ${opts.serviceImage}
          imagePullPolicy: IfNotPresent
---
apiVersion: v1
kind: Service
metadata:
  name: ${opts.serviceName}
  namespace: ${opts.ns}
spec:
  selector: { app: ${opts.serviceName} }
  ports:
    - port: ${port}
      targetPort: ${port}
`;
  await runKubectlOrThrow(['apply', '-f', '-'], { stdin: yaml });
  // 等 deployment ready；超时不致命（job 会读 pod status 自己判断）
  await runKubectlOrThrow(
    [
      'rollout',
      'status',
      `deployment/${opts.serviceName}`,
      '-n',
      opts.ns,
      `--timeout=${readyTimeout}s`,
    ],
    { timeoutMs: (readyTimeout + 10) * 1000 },
  );
}

export interface RunTestJobOpts {
  ns: string;
  jobName: string;
  testImage: string;
  testCommand: string[];
  /** 整个 Job 最多等多久（秒） */
  timeoutSec?: number;
}

/** Apply Job + 等完成 + 收 logs；走 result-collector 归一为 EnrichedTestResult。 */
export async function runTestJob(opts: RunTestJobOpts): Promise<EnrichedTestResult> {
  assertNsAllowed(opts.ns);
  const timeout = opts.timeoutSec ?? 300;

  const cmdJson = JSON.stringify(opts.testCommand);
  const yaml = `
apiVersion: batch/v1
kind: Job
metadata:
  name: ${opts.jobName}
  namespace: ${opts.ns}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: test
          image: ${opts.testImage}
          imagePullPolicy: IfNotPresent
          command: ${cmdJson}
`;
  await runKubectlOrThrow(['apply', '-f', '-'], { stdin: yaml });

  // 等 Job 完成（成功 or 失败）
  const waitRes = await runKubectl(
    [
      'wait',
      `--for=condition=complete`,
      `--timeout=${timeout}s`,
      `job/${opts.jobName}`,
      '-n',
      opts.ns,
    ],
    { timeoutMs: (timeout + 10) * 1000 },
  );

  // condition=complete 不命中时也可能是 failed；不论如何抓 logs
  const logsRes = await runKubectl([
    'logs',
    `job/${opts.jobName}`,
    '-n',
    opts.ns,
    '--tail=200',
  ]);

  // 拿 pod 退出码
  const podsRes = await runKubectlOrThrow([
    'get',
    'pods',
    '-n',
    opts.ns,
    '-l',
    `job-name=${opts.jobName}`,
    '-o',
    'jsonpath={.items[0].status.containerStatuses[0].state.terminated.exitCode}',
  ]);
  const exitCode = Number(podsRes.stdout.trim() || -1);
  // 标记 wait 结果用于诊断
  void waitRes;

  // R-15: 优先 JUnit XML，没有则退到 exitCode
  return collectTestResult({ stdout: logsRes.stdout, exitCode });
}
