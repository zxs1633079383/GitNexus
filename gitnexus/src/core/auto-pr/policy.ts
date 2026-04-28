// Stage 7 · auto-pr-policy.yaml 校验 (R-12)
//
// 三道闸：
//  1) 路径白/黑名单（黑名单优先级高 — .github/workflows/** 永远走黑名单）
//  2) 文件扩展名黑名单（.env / .pem / .key / .p12 ...）
//  3) diff 行数上限（max_revert_diff_lines / max_patch_diff_lines）

import yaml from 'js-yaml';
import {
  DEFAULT_AUTO_PR_POLICY,
  type AutoPRPolicy,
  type PRFilePatch,
} from './types.js';

/** 解析 yaml 文本到 AutoPRPolicy；失败抛错。 */
export function parsePolicyYaml(text: string): AutoPRPolicy {
  const parsed = yaml.load(text) as Partial<AutoPRPolicy> | null;
  return mergeWithDefault(parsed);
}

/** Partial 与默认合并；未提供字段走 DEFAULT。 */
export function mergeWithDefault(partial: Partial<AutoPRPolicy> | null | undefined): AutoPRPolicy {
  return {
    ...DEFAULT_AUTO_PR_POLICY,
    ...(partial ?? {}),
    blocked_paths: [
      ...DEFAULT_AUTO_PR_POLICY.blocked_paths,
      ...((partial?.blocked_paths as string[] | undefined) ?? []),
    ],
    blocked_file_extensions: [
      ...DEFAULT_AUTO_PR_POLICY.blocked_file_extensions,
      ...((partial?.blocked_file_extensions as string[] | undefined) ?? []),
    ],
  };
}

export interface PolicyCheckResult {
  ok: boolean;
  /** 仅 ok=false 时有意义。 */
  reason?: string;
  /** 触发拦截的具体路径（便于日志/PR body 展示）。 */
  offendingPath?: string;
}

/** 把简单 glob 转 RegExp（支持 ** / * / ?；不支持 [...]）。 */
function globToRegex(g: string): RegExp {
  const re = g
    .replace(/[.+^${}()|\\]/g, (s) => '\\' + s)
    .replace(/\*\*/g, '.LITDOUBLESTAR')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\.LITDOUBLESTAR/g, '.*');
  return new RegExp('^' + re + '$');
}

function pathMatches(path: string, patterns: string[]): { matched: boolean; pattern?: string } {
  for (const p of patterns) {
    if (globToRegex(p).test(path)) return { matched: true, pattern: p };
  }
  return { matched: false };
}

/** 校验一组 patch；任一拦截即 ok=false（返回第一个 offending）。 */
export function checkPolicy(
  files: PRFilePatch[],
  policy: AutoPRPolicy,
  options: { isRevert?: boolean } = {},
): PolicyCheckResult {
  const maxDiff = options.isRevert
    ? policy.max_revert_diff_lines
    : policy.max_patch_diff_lines;

  // 计 total 行（用文件行数近似 — 真 diff 行数需要 base 比对，offline 简化）
  let totalLines = 0;
  for (const f of files) {
    totalLines += (f.content ?? '').split('\n').length;

    // 1) 黑名单优先
    const blocked = pathMatches(f.path, policy.blocked_paths);
    if (blocked.matched) {
      return {
        ok: false,
        reason: `path "${f.path}" matched blocked pattern "${blocked.pattern}"`,
        offendingPath: f.path,
      };
    }

    // 2) 扩展名黑名单
    for (const ext of policy.blocked_file_extensions) {
      if (f.path.endsWith(ext)) {
        return {
          ok: false,
          reason: `path "${f.path}" has blocked extension "${ext}"`,
          offendingPath: f.path,
        };
      }
    }

    // 3) 白名单（黑名单未拦截才检）
    const allowed = pathMatches(f.path, policy.allowed_paths);
    if (!allowed.matched) {
      return {
        ok: false,
        reason: `path "${f.path}" not in allowed_paths`,
        offendingPath: f.path,
      };
    }
  }

  if (totalLines > maxDiff) {
    return {
      ok: false,
      reason: `total file lines ${totalLines} exceeds ${
        options.isRevert ? 'max_revert_diff_lines' : 'max_patch_diff_lines'
      }=${maxDiff}`,
    };
  }

  return { ok: true };
}
