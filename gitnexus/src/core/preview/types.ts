// Stage 6 · K8s Preview Env types
//
// 整个 S6 的硬约束是"namespace 前缀守门" — 任何写操作只能命中以
// gitnexus-preview- 开头的 namespace，否则 k8s-client 直接抛错拒绝。

/** S6 状态机。 */
export type PreviewJobStatus =
  | 'queued' // 已提交但 worker pool 满，排队中
  | 'spinning_up' // 正在创建 ns + apply deployment
  | 'running_tests' // 测试 Job 已启动，pod 跑测试中
  | 'collecting' // 测试跑完，正在收 JUnit / 日志
  | 'done' // 全程 ok
  | 'failed' // 任何阶段失败
  | 'cancelled'; // 外部主动取消（TTL 过期 / 用户调 cancel）

/** S6 输入 — 由 Pipeline Orchestrator 上游构造。 */
export interface PreviewSpec {
  /** 候选 fix 的服务镜像（R-2 chain 已选好可拉的 tag） */
  serviceImage: string;
  /** Deployment + Service 的 metadata.name，建议小写、k8s 合规 */
  serviceName: string;
  /** Service 暴露端口；省略默认 80 */
  servicePort?: number;
  /** 测试容器镜像（如 busybox:1.36 dev 自测 / curl pod / 自定义 e2e runner） */
  testImage: string;
  /** 测试容器启动命令 */
  testCommand: string[];
  /** 测试容器内 JUnit XML 输出路径（之后 result-collector 取） */
  junitOutputPath?: string;
  /** 整个 preview env 的 TTL（秒）；省略默认 1800（30 min） */
  ttlSeconds?: number;
}

/** 单条测试结果摘要（result-collector 的 R-15 统一 JUnit 格式） */
export interface TestResult {
  /** 通过用例数 */
  passed: number;
  /** 失败用例数 */
  failed: number;
  /** 跳过用例数 */
  skipped: number;
  /** 测试 pod 退出码 */
  exitCode: number;
  /** 测试容器尾部 stdout（最多 2KB） */
  stdoutTail: string;
}

export interface PreviewJob {
  id: string;
  /** id 的前 6 位，用作 ns 后缀 */
  shortId: string;
  /** 完整 namespace 名 = `gitnexus-preview-${shortId}` */
  ns: string;
  status: PreviewJobStatus;
  spec: PreviewSpec;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Unix ms — 用于 reaper 判断过期 */
  expiresAt: number;
  error?: string;
  testResult?: TestResult;
  /** 仅 status === 'queued' 时有意义；从 1 开始 */
  queuePosition?: number;
}

// ─── 常量（dev 自测可调） ─────────────────────────────────────────────

export const NS_PREFIX = 'gitnexus-preview-';
export const DEFAULT_TTL_SECONDS = 1800; // 30 min
export const DEFAULT_MAX_CONCURRENT = 3; // R-3 worker pool 上限
export const REAPER_INTERVAL_MS = 60_000; // 每分钟扫一次过期 ns
export const MANAGED_LABEL = 'gitnexus.dev/managed';
export const EXPIRES_ANNOTATION = 'gitnexus.dev/expires-at';

// ─── PreviewJobManager 选项 ───────────────────────────────────────────

export interface PreviewJobManagerOptions {
  /** 默认 3，并发 preview 数上限 */
  maxConcurrent?: number;
  /** 默认 enabled；true=自动启 reaper，false=测试场景手动调 reapOnce */
  autoReaper?: boolean;
  /** spin/teardown/test 实现注入；省略走 k8s-client 真实操作 */
  driver?: PreviewDriver;
}

/** Driver 抽象 — 让单元测试可以用真实 K8s（busybox sanity）也可以用纯逻辑 stub。 */
export interface PreviewDriver {
  spinUp(job: PreviewJob): Promise<void>;
  runTests(job: PreviewJob): Promise<TestResult>;
  teardown(ns: string): Promise<void>;
  reapExpired(): Promise<string[]>;
}

// R-16 占位：docker-compose adapter（无 K8s 团队 fallback）。当前仅声明接口，
// 不实现 — 让 import 路径在未来"补一份 docker-compose driver"时不需要破坏现有 API。
export interface DockerComposeAdapterPlaceholder {
  // 保留 hook 位；S6 当前阶段 K8s 路径已覆盖用户场景。
  readonly _placeholder: true;
}
