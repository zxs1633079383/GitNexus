// query-only — must not be called from any pipeline phase
//
// Phase 0 / Stage 4 — Auto Regression Forensics (P5)
// caller 喂一组 NormalizedSpan + repoPath + lookback, 输出嫌疑提交清单
// (commit + symbol + 距 trace 时间 + 置信度), 给 Stage 5 / 7 用。
//
// 关键修正 (review v1→v2):
//   Fix-1: suspects 必须经文件路径过滤 —— 只交叉 handler 所在文件或 blast
//          radius 命中文件直接改动, 防 unrelated 同期变更全归属。
//   Fix-2: forensics 层自跑 `git log --format="%H %at <files>"`,
//          不改 detect_changes 接口 (RULES §3.4 的 schema 稳定性)。
//   Fix-9: 输入 NormalizedSpan[] 由 caller POST, **不**主动拉 Jaeger。
//
// Roadmap §3.3, RULES §1.1 行 4 (Stage 4 = git log + 文件路径过滤, 必须确定性)

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import type { NormalizedSpan } from './jaeger-span-types.js';

export interface ForensicsInput {
  /** Phase 0 输出的 NormalizedSpan 数组。errorEvent 必须存在的项才参与 forensics。 */
  spans: NormalizedSpan[];
  /** repo 工作树根 (call site 应该已经把 RepoHandle 解出来). */
  repoPath: string;
  /** 回看多少个 commit (默认 50). */
  lookback?: number;
  /** 把 symbolUid 解为 (filePath) 的查询函数 (caller 注入, 通常包 local-backend.cypher). */
  resolveHandlerFile: (symbolUid: string) => Promise<string | null>;
  /**
   * 对一个 handler 求 blast radius 文件集合。返回 Set<filePath>, depth 信息编码在
   * 第二项: { depth1: Set, depth2: Set, cross: Set }, 给 forensics 算 confidence。
   */
  resolveBlastFiles: (symbolUid: string) => Promise<{
    handlerFile: string | null;
    depth1: Set<string>;
    depth2: Set<string>;
    cross: Set<string>;
  }>;
}

export interface Suspect {
  commitHash: string;
  shortHash: string;
  authorTimeSec: number;
  timeAgoSec: number;
  subject: string;
  changedFiles: string[];
  /** 哪条 span 的哪个 handler 把它捞出来的 (诊断用). */
  matchedHandlers: string[];
  /** 0 - 1, 越大越可疑. 综合"文件 hit 半径" + "时间近度". */
  confidence: number;
  /**
   * 命中哪类文件:
   *   - 'handler-file'  直接改了 handler 所在文件 (强信号)
   *   - 'blast-d1'      blast radius depth=1 (直接 caller / callee)
   *   - 'blast-d2'      depth=2 (间接)
   *   - 'cross-repo'    跨仓 contract bridge
   */
  hitKind: 'handler-file' | 'blast-d1' | 'blast-d2' | 'cross-repo';
}

interface RawCommit {
  hash: string;
  authorTimeSec: number;
  subject: string;
  files: string[];
}

/**
 * 拉近 N 个 commit 的 hash + author time + 文件清单。
 * 单次 `git log` 拿全, 防 N×git show 带来的 IPC 开销。
 *
 * 输出格式: `--format=COMMIT|<hash>|<unix>|<subject>` 带分隔头, name-only 紧随其后, commit 间空行分割。
 */
function loadRecentCommits(repoPath: string, lookback: number): RawCommit[] {
  const out = execFileSync(
    'git',
    [
      '-C',
      repoPath,
      'log',
      `-n`,
      String(lookback),
      `--format=COMMIT|%H|%at|%s`,
      `--name-only`,
    ],
    { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 },
  );

  const lines = out.split('\n');
  const commits: RawCommit[] = [];
  let cur: RawCommit | null = null;
  for (const line of lines) {
    if (line.startsWith('COMMIT|')) {
      if (cur) commits.push(cur);
      const [, hash, ts, ...subjectParts] = line.split('|');
      cur = {
        hash,
        authorTimeSec: Number(ts),
        subject: subjectParts.join('|'),
        files: [],
      };
      continue;
    }
    if (!cur) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    cur.files.push(trimmed);
  }
  if (cur) commits.push(cur);
  return commits;
}

/** 把绝对/相对路径都规范成 repo-relative POSIX 形态, 用于跨平台 set 比较。 */
function normalizeRel(repoPath: string, filePath: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(repoPath, filePath);
  const rel = path.relative(repoPath, abs);
  return rel.replace(/\\/g, '/');
}

const HIT_KIND_CONFIDENCE: Record<Suspect['hitKind'], number> = {
  'handler-file': 1.0,
  'blast-d1': 0.7,
  'blast-d2': 0.4,
  'cross-repo': 0.5,
};

export async function regressionForensics(input: ForensicsInput): Promise<Suspect[]> {
  const { spans, repoPath } = input;
  const lookback = input.lookback ?? 50;

  // 只对 errorEvent 不为空的 span 启动 forensics (Phase 0 自然过滤)。
  const failedHandlers: string[] = [];
  for (const s of spans) {
    if (!s.errorEvent) continue;
    if (s.symbolUid) failedHandlers.push(s.symbolUid);
  }
  if (failedHandlers.length === 0) return [];

  const commits = loadRecentCommits(repoPath, lookback);
  if (commits.length === 0) return [];

  // 预把 commits 的 file 列表做成 set, 减少嵌套循环成本
  const commitFileSets = commits.map((c) => ({
    ...c,
    fileSet: new Set(c.files.map((f) => normalizeRel(repoPath, f))),
  }));

  const nowSec = Math.floor(Date.now() / 1000);
  const suspectMap = new Map<string, Suspect>(); // key = `${commitHash}|${hitKind}`

  for (const handlerUid of failedHandlers) {
    const blast = await input.resolveBlastFiles(handlerUid);
    const handlerFile = blast.handlerFile
      ? normalizeRel(repoPath, blast.handlerFile)
      : null;
    const depth1 = new Set([...blast.depth1].map((f) => normalizeRel(repoPath, f)));
    const depth2 = new Set([...blast.depth2].map((f) => normalizeRel(repoPath, f)));
    const cross = new Set([...blast.cross].map((f) => normalizeRel(repoPath, f)));

    for (const c of commitFileSets) {
      // 优先级: handler-file > blast-d1 > cross > blast-d2 (置信度高的先选)
      let hitKind: Suspect['hitKind'] | null = null;
      if (handlerFile && c.fileSet.has(handlerFile)) hitKind = 'handler-file';
      if (!hitKind) {
        for (const f of c.fileSet) {
          if (depth1.has(f)) {
            hitKind = 'blast-d1';
            break;
          }
        }
      }
      if (!hitKind) {
        for (const f of c.fileSet) {
          if (cross.has(f)) {
            hitKind = 'cross-repo';
            break;
          }
        }
      }
      if (!hitKind) {
        for (const f of c.fileSet) {
          if (depth2.has(f)) {
            hitKind = 'blast-d2';
            break;
          }
        }
      }
      if (!hitKind) continue; // Fix-1: 文件路径过滤通不过 → 直接丢

      const key = `${c.hash}|${hitKind}`;
      const existing = suspectMap.get(key);
      const timeAgoSec = Math.max(1, nowSec - c.authorTimeSec);
      const baseConfidence = HIT_KIND_CONFIDENCE[hitKind];
      // 复合排序: 同 hash+kind 多个 handler 命中 → 取最大 (= 信号最强)
      if (!existing) {
        suspectMap.set(key, {
          commitHash: c.hash,
          shortHash: c.hash.slice(0, 8),
          authorTimeSec: c.authorTimeSec,
          timeAgoSec,
          subject: c.subject,
          changedFiles: [...c.fileSet],
          matchedHandlers: [handlerUid],
          confidence: baseConfidence,
          hitKind,
        });
      } else {
        if (!existing.matchedHandlers.includes(handlerUid)) {
          existing.matchedHandlers.push(handlerUid);
          // 多 handler 命中 → 信心微涨, 但不超 1.0
          existing.confidence = Math.min(1, existing.confidence + 0.05);
        }
      }
    }
  }

  // ranker: confidence / log(timeAgoSec + 2)  —— 时间越近权重越大
  const suspects = [...suspectMap.values()];
  suspects.sort(
    (a, b) =>
      b.confidence / Math.log(b.timeAgoSec + 2) -
      a.confidence / Math.log(a.timeAgoSec + 2),
  );
  return suspects;
}
