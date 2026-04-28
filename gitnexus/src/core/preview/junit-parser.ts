// Stage 6 · R-15 统一 JUnit XML 解析
//
// JUnit XML 是 Java/Go/Node 三家测试框架的事实标准：
//  · JUnit5 原生输出
//  · Go 用 go-junit-report 转换 `go test -v` 输出
//  · Jest 用 jest-junit reporter
//
// 我们用正则解析（避免引入 XML 解析依赖）。JUnit schema 简单到正则可处理：
//  <testsuites tests=".." failures=".." errors=".." skipped="..">
//    <testsuite ...>
//      <testcase classname=".." name=".." time="..">
//        <failure message="..">...</failure>
//        <error message="..">...</error>
//        <skipped message=".."/>
//      </testcase>
//    </testsuite>
//  </testsuites>

export interface JUnitFailure {
  classname: string;
  name: string;
  message: string;
  /** 'failure' = 测试断言失败; 'error' = 抛异常 */
  kind: 'failure' | 'error';
}

export interface JUnitSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  /** Failures + errors 的并集（最多保留前 20 条，避免占爆 PR body） */
  failures: JUnitFailure[];
}

/** 解析 stdout 流里的 JUnit XML 块。失败/未找到返回 null。 */
export function parseJUnitXml(xml: string): JUnitSummary | null {
  if (!xml || typeof xml !== 'string') return null;
  if (!xml.includes('<testcase') && !xml.includes('<testsuite')) return null;

  // 数量统计：直接计数标签
  const total = countMatches(xml, /<testcase\b/g);
  if (total === 0) return null;

  const failureBlocks = matchAll(xml, /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g);
  const selfClosing = matchAll(xml, /<testcase\b([^>]*)\/>/g);
  // 自闭合 testcase = passed
  const passedFromSelfClose = selfClosing.length;

  const failures: JUnitFailure[] = [];
  let failed = 0;
  let errored = 0;
  let skipped = 0;

  for (const m of failureBlocks) {
    const attrs = m[1];
    const inner = m[2];
    if (/<skipped\b/.test(inner)) {
      skipped++;
      continue;
    }
    const failureMatch = /<failure\b([^>]*)(?:\/>|>([\s\S]*?)<\/failure>)/.exec(inner);
    const errorMatch = /<error\b([^>]*)(?:\/>|>([\s\S]*?)<\/error>)/.exec(inner);
    if (failureMatch || errorMatch) {
      const classname = attrAttr(attrs, 'classname') ?? '';
      const name = attrAttr(attrs, 'name') ?? '';
      const kind: JUnitFailure['kind'] = failureMatch ? 'failure' : 'error';
      const fm = failureMatch ?? errorMatch!;
      const msg = (attrAttr(fm[1], 'message') ?? (fm[2] ?? '').trim()).slice(0, 500);
      if (failureMatch) failed++;
      else errored++;
      if (failures.length < 20) failures.push({ classname, name, message: msg, kind });
    }
  }

  const passed = passedFromSelfClose + (failureBlocks.length - failed - errored - skipped);
  return { total, passed, failed, errored, skipped, failures };
}

// ─── 内部 helper ──────────────────────────────────────────────────

function countMatches(s: string, re: RegExp): number {
  let n = 0;
  // 重置 g flag lastIndex
  re.lastIndex = 0;
  while (re.exec(s) !== null) n++;
  return n;
}

function matchAll(s: string, re: RegExp): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) results.push(m);
  return results;
}

function attrAttr(attrs: string, key: string): string | null {
  const re = new RegExp(`${key}="([^"]*)"`);
  const m = re.exec(attrs);
  return m ? m[1] : null;
}

// ─── 从 stdout 流里抽 JUnit XML 块 ──────────────────────────────────

const XML_BEGIN = '===JUNIT-XML===';
const XML_END = '===END-JUNIT-XML===';

/**
 * 测试容器约定：把 JUnit XML 用 ===JUNIT-XML=== / ===END-JUNIT-XML===
 * 包起来打到 stdout。这样 result-collector 不需要 kubectl cp/exec，
 * 只用 kubectl logs 就能拿到结构化测试报告。
 */
export function extractJUnitFromStdout(stdout: string): string | null {
  const i = stdout.indexOf(XML_BEGIN);
  const j = stdout.indexOf(XML_END);
  if (i < 0 || j < 0 || j < i) return null;
  return stdout.slice(i + XML_BEGIN.length, j).trim();
}
