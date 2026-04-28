// Stage 6 · result-collector — 把 test pod 的产出归一成 TestResult
//
// 数据来源优先级：
//   1) stdout 里的 JUnit XML 块（推荐，测试容器把 XML 写到 stdout 中）
//   2) 退化到 exitCode + stdout tail（busybox / shell 脚本风格）
//
// 这一层让 R-15（统一 JUnit）和 busybox 脚本测试都能通过同一个返回值表达。

import type { TestResult } from './types.js';
import { extractJUnitFromStdout, parseJUnitXml, type JUnitSummary } from './junit-parser.js';

export interface CollectorInput {
  /** 测试 pod 的 stdout（kubectl logs 拉到的） */
  stdout: string;
  /** test container 退出码 (0=成功) */
  exitCode: number;
}

export interface EnrichedTestResult extends TestResult {
  /** XML 块成功解析时填入；fallback 路径下为 null */
  junit: JUnitSummary | null;
  /** 数据来源：标识 caller 知道结果可信度 */
  source: 'junit' | 'exitcode';
}

export function collectTestResult(input: CollectorInput): EnrichedTestResult {
  const stdoutTail = input.stdout.slice(-2048);

  const xmlBlock = extractJUnitFromStdout(input.stdout);
  if (xmlBlock) {
    const summary = parseJUnitXml(xmlBlock);
    if (summary) {
      return {
        passed: summary.passed,
        failed: summary.failed + summary.errored,
        skipped: summary.skipped,
        exitCode: input.exitCode,
        stdoutTail,
        junit: summary,
        source: 'junit',
      };
    }
  }

  // Fallback: 没 JUnit XML / 解析失败 → 用 exit code 当唯一信号
  return {
    passed: input.exitCode === 0 ? 1 : 0,
    failed: input.exitCode === 0 ? 0 : 1,
    skipped: 0,
    exitCode: input.exitCode,
    stdoutTail,
    junit: null,
    source: 'exitcode',
  };
}
