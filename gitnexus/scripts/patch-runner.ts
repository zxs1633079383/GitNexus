// patch-runner.ts — 把 issue 上下文喂给本机 claude CLI, 让它出"真改代码 + 真断言".
//
// 跟 src/core/auto-pr/patch-llm.ts 是一类东西, 但 patch-llm.ts 是 stub 的 offline 实现 +
// 用 wiki/llm-client. 这里走 claude -p 子进程, 是 LIVE 真接的实现, 复用同一份 R-14 system
// prompt 安全约束.
//
// 输入: handler 路径 + 错误堆栈 + S3 blast radius + (可选) S4 嫌疑 commit diff
// 输出: { fixFiles: 修 handler 的代码改动, testFiles: 真断言测试, reasoning, abort? }
//
// 安全:
//   - claude 工作目录 cwd = 业务仓本地 clone (用 add-dir 让它 Read 其他文件)
//   - 不允许写文件 (Edit/Write tool 不在 allowedTools 里); 只让它 Read/Glob/Grep
//   - JSON Schema 强制结构化输出
//   - R-14 systemPrompt: 不动 .github / .env / 凭证 / 不引新依赖
//
// query-only — must not be called from any pipeline phase

import { runClaudeCli, summarizeEvent, type ClaudeStreamEvent } from './claude-cli-client.js';

export const PATCH_SYSTEM_PROMPT = `
你是 GitNexus Agentic DevOps 闭环的 patch-and-test agent.
你拿到一份"线上 trace 报错 + 受影响文件清单 + (可选)嫌疑 commit", 任务是给出**最小化代码补丁** + **真复现 bug 的测试** (含真断言, 不是 TODO 占位).

绝对硬约束 (违反任意一条 → 必须 abort, 不要硬塞):
  R-14.1  不允许修改 .github/workflows/** 任何文件
  R-14.2  不允许写/改/删 .env / .env.* / .pem / .key / 凭证文件 / secrets/**
  R-14.3  不允许引入新依赖 (package.json / pom.xml / build.gradle / requirements.txt / go.mod 不动)
  R-14.4  fixFiles + testFiles 总条数 ≤ 5, 总改动行数 (加+删) ≤ 200
  R-14.5  fixFiles 必须只动 handler 路径或它直接依赖的少量文件 (在 blast radius 内)
  R-14.6  testFiles 必须含真断言, 复现 trace 报错的场景; 不允许 fail("TODO") / @Disabled / @Ignore

允许使用的工具 (caller 限定):
  Read / Glob / Grep — 让你浏览仓内代码
  Bash(git diff:*) / Bash(git log:*) — 让你查 handler 文件最近 commit (如果 caller 提供)

调研步骤建议:
  1. Read 一下 handlerFilePath, 看 method 真签名 + 上下文
  2. Glob/Grep 同包内 Test_*.java 看测试规约
  3. 从 stack trace 顶帧 + blast radius 推断 root cause
  4. 提出最小化修复 (优先 null check / 边界判断 / 异常包装)
  5. 写真断言测试: arrange (mock 依赖) + act (调 handler) + assert (期望值/异常类型)

输出格式 (严格 JSON 单对象, 无 markdown 围栏, 无外层文字):

成功路径 (你能给出修复):
{
  "fixFiles": [{ "path": "<repo-relative path>", "content": "<完整新文件内容, 不是 diff>" }],
  "testFiles": [{ "path": "<repo-relative path>", "content": "<完整新文件内容>" }],
  "reasoning": "<2-5 句话: bug 是什么 / 怎么改 / 测试怎么验证>"
}

中止路径 (任一硬约束违反 / 不清楚怎么修 / 改动会超 200 行):
{ "abort": true, "reason": "<为什么不能给出修复, 1 句话>" }

二选一. 不允许混合. 不允许 JSON 外有任何文字. 不允许 unified diff.
`.trim();

// Anthropic API 不支持 top-level oneOf/allOf/anyOf, 改单一 schema 全字段 optional, 由 prompt 约束语义.
const PATCH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    fixFiles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    testFiles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    reasoning: { type: 'string' },
    abort: { type: 'boolean' },
    reason: { type: 'string' },
  },
};

export interface RunPatchInput {
  /** 业务仓本地 clone 路径, 让 claude cwd 在这, 自由 Read 源码. */
  repoPath: string;
  /** S2 反查的 handler 路径 (相对仓根). */
  handlerFilePath: string;
  /** S2 反查的 handler symbol UID (Method:.../Name:line). */
  handlerSymbolUid?: string;
  /** Trace 顶帧错误信息 (类型/消息/类方法/行号), 文本拼好. */
  errorContext: string;
  /** S3 blast radius 受影响文件 (供 LLM 看依赖图). */
  blastRadiusFiles: string[];
  /** S4 forensics 嫌疑 commit + diff 字符串 (可选). */
  suspectCommit?: { hash: string; diff?: string; subject?: string };
  /** issue 编号 (用于 test 类名注释). */
  issueRef?: string;
  /** 总预算上限 (USD), 默认 1.0. */
  maxBudgetUsd?: number;
  /** L-3 修: claude CLI 总超时 (ms), 默认走 CLAUDE_CLI_TIMEOUT_MS env 或 600s. */
  timeoutMs?: number;
  /** 流事件回调 (一般传 console.log 包装). */
  onProgress?: (line: string) => void;
}

export interface RunPatchOutput {
  ok: boolean;
  fixFiles: Array<{ path: string; content: string }>;
  testFiles: Array<{ path: string; content: string }>;
  reasoning: string;
  abort?: boolean;
  reason?: string;
  costUsd: number;
  durationMs: number;
  sessionId: string;
}

/** 拼 user 消息文本. */
function buildPrompt(input: RunPatchInput): string {
  const parts: string[] = [];
  parts.push(`## 业务仓 clone 在: \`${input.repoPath}\` (你的 cwd)`);
  parts.push('');
  parts.push(`## S2 锚点`);
  parts.push(`- handler 文件: \`${input.handlerFilePath}\``);
  if (input.handlerSymbolUid) parts.push(`- symbol UID: \`${input.handlerSymbolUid}\``);
  parts.push('');
  parts.push(`## 错误上下文 (S2 normalize 出)`);
  parts.push('```');
  parts.push(input.errorContext.slice(0, 3000));
  parts.push('```');
  parts.push('');
  parts.push(`## S3 受影响文件 (blast radius, 上限 20)`);
  for (const f of input.blastRadiusFiles.slice(0, 20)) parts.push(`- \`${f}\``);
  parts.push('');
  if (input.suspectCommit) {
    parts.push(`## S4 嫌疑 commit`);
    parts.push(`- hash: \`${input.suspectCommit.hash}\``);
    if (input.suspectCommit.subject) parts.push(`- subject: ${input.suspectCommit.subject}`);
    if (input.suspectCommit.diff) {
      parts.push('- diff (前 3000 字):');
      parts.push('```diff');
      parts.push(input.suspectCommit.diff.slice(0, 3000));
      parts.push('```');
    }
    parts.push('');
  }
  parts.push(`## 任务`);
  parts.push(`先用 Read 读 ${input.handlerFilePath}, 再用 Grep/Glob 看相关 Test_*.java, 然后输出严格 JSON.`);
  parts.push(`issue 编号: #${input.issueRef ?? '?'}`);
  return parts.join('\n');
}

export async function runPatch(input: RunPatchInput): Promise<RunPatchOutput> {
  const onEvent = input.onProgress
    ? (ev: ClaudeStreamEvent) => {
        const line = summarizeEvent(ev);
        if (line) input.onProgress!(line);
      }
    : undefined;

  const r = await runClaudeCli({
    prompt: buildPrompt(input),
    systemPrompt: PATCH_SYSTEM_PROMPT,
    cwd: input.repoPath,
    addDirs: [input.repoPath],
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
    maxBudgetUsd: input.maxBudgetUsd ?? 1.0,
    // L-3 修: timeoutMs 可由 caller 覆盖, 否则走 claude-cli-client 的 DEFAULT_TIMEOUT_MS (env or 600s)
    timeoutMs: input.timeoutMs,
    jsonSchema: PATCH_JSON_SCHEMA,
    onEvent,
  });

  if (r.isError) {
    return {
      ok: false,
      fixFiles: [],
      testFiles: [],
      reasoning: '',
      abort: true,
      reason: `claude CLI is_error=true: ${r.text.slice(0, 300)}`,
      costUsd: r.costUsd,
      durationMs: r.durationMs,
      sessionId: r.sessionId,
    };
  }
  const j = r.json as
    | { fixFiles?: unknown[]; testFiles?: unknown[]; reasoning?: string; abort?: boolean; reason?: string }
    | null;
  if (!j) {
    return {
      ok: false,
      fixFiles: [],
      testFiles: [],
      reasoning: '',
      abort: true,
      reason: `claude 返回非 JSON: ${r.text.slice(0, 300)}`,
      costUsd: r.costUsd,
      durationMs: r.durationMs,
      sessionId: r.sessionId,
    };
  }
  if (j.abort) {
    return {
      ok: false,
      fixFiles: [],
      testFiles: [],
      reasoning: '',
      abort: true,
      reason: typeof j.reason === 'string' ? j.reason : 'abort without reason',
      costUsd: r.costUsd,
      durationMs: r.durationMs,
      sessionId: r.sessionId,
    };
  }
  const fixFiles = Array.isArray(j.fixFiles)
    ? (j.fixFiles as Array<{ path?: string; content?: string }>)
        .filter((x) => typeof x?.path === 'string' && typeof x?.content === 'string')
        .map((x) => ({ path: x.path!, content: x.content! }))
    : [];
  const testFiles = Array.isArray(j.testFiles)
    ? (j.testFiles as Array<{ path?: string; content?: string }>)
        .filter((x) => typeof x?.path === 'string' && typeof x?.content === 'string')
        .map((x) => ({ path: x.path!, content: x.content! }))
    : [];
  return {
    ok: fixFiles.length > 0 || testFiles.length > 0,
    fixFiles,
    testFiles,
    reasoning: typeof j.reasoning === 'string' ? j.reasoning : '',
    costUsd: r.costUsd,
    durationMs: r.durationMs,
    sessionId: r.sessionId,
  };
}

/**
 * R-14 安全 gate — caller 在 push 前必查, 任何违反 → 整体 abort.
 *
 * 多仓接入前必须把所有可能持有"运行时配置 / 凭证 / 部署 manifest / 仓库治理"的路径堵死.
 * 单仓 cses-java 没这些文件, 但路线图说"扩多仓只是配置层", 所以这里要写在前面.
 */
export function violatesSafetyPolicy(path: string): string | null {
  // 路径穿越
  if (path.includes('..')) return 'path 含 ..';

  // R-14.1 仓库治理 — 整个 .github 都不让动 (workflows + CODEOWNERS + ci-config 等)
  if (path.startsWith('.github/')) return 'R-14.1 不允许 .github/**';
  if (path.startsWith('.gitlab/') || path === '.gitlab-ci.yml') return 'R-14.1 不允许 .gitlab-ci/CODEOWNERS';
  if (path === 'CODEOWNERS' || path.endsWith('/CODEOWNERS')) return 'R-14.1 不允许 CODEOWNERS';

  // R-14.2 凭证/环境变量
  if (path.startsWith('.env') || path.includes('/.env') || /\.env(\.|$)/.test(path))
    return 'R-14.2 不允许 .env*';
  if (/\.(pem|key|p12|pfx|jks|keystore|crt|cer)$/.test(path)) return 'R-14.2 不允许凭证扩展名';
  if (path.startsWith('secrets/') || path.includes('/secrets/')) return 'R-14.2 不允许 secrets/';
  const base = path.split('/').pop() ?? '';
  if (/^\.npmrc$|^\.pypirc$|^\.netrc$|^id_rsa$|^id_ed25519$/.test(base))
    return 'R-14.2 不允许 registry/npmrc/ssh 私钥';
  // application.properties / application.yml / application-*.yml — Spring 常放 DB/Redis/凭证
  if (/^application(-[\w-]+)?\.(properties|ya?ml)$/.test(base))
    return 'R-14.2 不允许 application.properties / application*.y(a)ml';

  // R-14.3 不引入新依赖
  if (
    /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pom\.xml|build\.gradle|build\.gradle\.kts|gradle\.properties|gradle-wrapper\.properties|requirements\.txt|requirements-.*\.txt|Pipfile|Pipfile\.lock|pyproject\.toml|poetry\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile|Gemfile\.lock|composer\.json|composer\.lock|mix\.exs|deno\.json|deno\.jsonc|bun\.lockb)$/.test(
      base,
    )
  )
    return 'R-14.3 不允许引入/改动依赖清单';

  // R-14.4 部署 manifest / IaC — 单条业务 patch 不该动这些
  if (/^docker-compose(\..*)?\.ya?ml$/.test(base)) return 'R-14.4 不允许 docker-compose*.yml';
  if (base === 'Dockerfile' || /^Dockerfile\.[\w.-]+$/.test(base) || path.endsWith('/Dockerfile'))
    return 'R-14.4 不允许 Dockerfile';
  if (/\.tf(vars)?$/.test(base) || /\.hcl$/.test(base)) return 'R-14.4 不允许 terraform/hcl';
  // K8s / helm / argo / kustomize 常见根目录
  if (
    /^(k8s|kubernetes|helm|charts|argocd|kustomize|deploy|deployment|manifests)\//.test(path) ||
    path.startsWith('infra/') ||
    path.startsWith('infrastructure/')
  )
    return 'R-14.4 不允许 k8s/helm/terraform/部署 manifest 目录';
  if (/^Chart\.ya?ml$|^values(-[\w-]+)?\.ya?ml$/.test(base)) return 'R-14.4 不允许 Helm Chart/values';

  // R-14.5 CI 系统 (GitHub Actions / GitLab CI / Jenkins / CircleCI / Drone)
  if (
    base === 'Jenkinsfile' ||
    /^Jenkinsfile\.[\w.-]+$/.test(base) ||
    base === '.drone.yml' ||
    base === '.travis.yml' ||
    base === 'azure-pipelines.yml' ||
    base === '.circleci' ||
    path.startsWith('.circleci/')
  )
    return 'R-14.5 不允许 CI 配置 (Jenkins/Travis/CircleCI/Drone/Azure)';

  return null;
}
