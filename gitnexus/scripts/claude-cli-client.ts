// claude-cli-client.ts — 把本机已登录的 `claude` CLI 当 LLM 调.
//
// 走 `claude -p --output-format=stream-json --input-format=stream-json --verbose`,
// 写每条 stream-json 事件到 logSink 让 caller 观察进度;
// 最终 result event 解析 final text + cost + sessionId.
//
// 不用 `--bare` 因为 bare 强制走 ANTHROPIC_API_KEY (本机用 OAuth 登录), 会 401.
// 代价: 每次启动都会刷一些 SessionStart hook (~$0.35 cache 创建), 可接受.
//
// query-only — must not be called from any pipeline phase

import { spawn } from 'node:child_process';

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const DEFAULT_TIMEOUT_MS = Number(process.env.CLAUDE_CLI_TIMEOUT_MS ?? 600_000);
const DEFAULT_MAX_BUDGET = process.env.CLAUDE_CLI_MAX_BUDGET_USD; // 不设默认, 由 caller 决定

export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
    usage?: Record<string, number>;
  };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
  uuid?: string;
  [k: string]: unknown;
}

export interface ClaudeRunRequest {
  /** user 消息内容 (单轮; multi-turn 需要 caller 自己拼). */
  prompt: string;
  /** 在默认 system prompt 后追加. */
  appendSystemPrompt?: string;
  /** 用纯系统 prompt 替代默认 (互斥 appendSystemPrompt). */
  systemPrompt?: string;
  /** 工作目录, 让 claude Read/Glob 看到这个仓 (e.g. /tmp/cses-pre/cses-java). */
  cwd?: string;
  /** 额外允许 claude 访问的目录. */
  addDirs?: string[];
  /** 限制可用工具 (e.g. ["Read","Glob","Grep","Bash(git diff:*)"]). 默认放开 Read/Glob/Grep. */
  allowedTools?: string[];
  /** 单次会话最大消费, 防失控. */
  maxBudgetUsd?: number;
  /** 总超时 (ms). */
  timeoutMs?: number;
  /** 实时打到 stdout/log 的回调; 每条 stream-json event 都喂一遍. */
  onEvent?: (event: ClaudeStreamEvent, raw: string) => void;
  /** JSON Schema 让 claude 出结构化输出 (放进 --json-schema). */
  jsonSchema?: object;
}

export interface ClaudeRunResult {
  /** result.result 里的最终文本; 配合 jsonSchema 时这里是合法 JSON 字符串. */
  text: string;
  /** 试着 parse 上面 text 成 JSON; 失败则 null. */
  json: unknown | null;
  costUsd: number;
  durationMs: number;
  sessionId: string;
  isError: boolean;
  /** 收到的所有事件; 调试用, 一般 caller 用 onEvent 流式即可. */
  events: ClaudeStreamEvent[];
  /** stderr 全文 (debugging). */
  stderr: string;
}

/**
 * 启 claude -p, 把 prompt 丢进 stdin (stream-json 协议), 等 result event 然后返回.
 *
 * 协议参考 (本机 claude 2.1.123 验证):
 *   - 每条 stdin/stdout 是一行 JSON
 *   - stdin 格式: {"type":"user","message":{"role":"user","content":"..."}}
 *   - stdout 事件:
 *       {type:"system",subtype:"init"|"hook_started"|"hook_response", ...}
 *       {type:"assistant",message:{content:[{type:"text",text:"..."}],usage:{...}}}
 *       {type:"rate_limit_event",...}
 *       {type:"result",subtype:"success",is_error:false,result:"...",total_cost_usd:0.x,...}
 */
export async function runClaudeCli(req: ClaudeRunRequest): Promise<ClaudeRunResult> {
  const args = [
    '-p',
    '--output-format=stream-json',
    '--input-format=stream-json',
    '--verbose',
  ];
  if (req.systemPrompt) {
    args.push('--system-prompt', req.systemPrompt);
  } else if (req.appendSystemPrompt) {
    args.push('--append-system-prompt', req.appendSystemPrompt);
  }
  if (req.allowedTools && req.allowedTools.length > 0) {
    args.push('--allowedTools', ...req.allowedTools);
  }
  for (const d of req.addDirs ?? []) args.push('--add-dir', d);
  const budget = req.maxBudgetUsd ?? (DEFAULT_MAX_BUDGET ? Number(DEFAULT_MAX_BUDGET) : undefined);
  if (budget !== undefined) args.push('--max-budget-usd', String(budget));
  if (req.jsonSchema) {
    args.push('--json-schema', JSON.stringify(req.jsonSchema));
  }

  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ClaudeRunResult>((resolveOuter, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: req.cwd,
    });
    let stdoutBuf = '';
    let stderrBuf = '';
    const events: ClaudeStreamEvent[] = [];
    let lastResult: ClaudeStreamEvent | null = null;
    let settled = false;

    const settle = (v: ClaudeRunResult | Error) => {
      if (settled) return;
      settled = true;
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      if (v instanceof Error) reject(v);
      else resolveOuter(v);
    };

    const lineHandler = (line: string) => {
      if (!line.trim()) return;
      let ev: ClaudeStreamEvent;
      try {
        ev = JSON.parse(line);
      } catch {
        return; // 非 JSON 行 (理论上不该出现, claude --verbose 可能漏 stderr 进 stdout)
      }
      events.push(ev);
      if (req.onEvent) {
        try {
          req.onEvent(ev, line);
        } catch {
          /* swallow caller errors */
        }
      }
      if (ev.type === 'result') {
        lastResult = ev;
      }
    };

    child.stdout.on('data', (b: Buffer) => {
      stdoutBuf += b.toString('utf-8');
      while (true) {
        const nl = stdoutBuf.indexOf('\n');
        if (nl < 0) break;
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        lineHandler(line);
      }
    });
    child.stderr.on('data', (b: Buffer) => {
      stderrBuf += b.toString('utf-8');
    });

    const t = setTimeout(() => {
      if (!settled) settle(new Error(`claude CLI timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    t.unref?.();

    child.on('error', (e) => settle(e));
    child.on('exit', (code) => {
      // flush remainder
      if (stdoutBuf.trim()) lineHandler(stdoutBuf);
      if (lastResult) {
        const text = typeof lastResult.result === 'string' ? lastResult.result : '';
        let parsed: unknown | null = null;
        // 用 --json-schema 时, claude 通过 StructuredOutput 工具输出, input 字段是结构化 JSON.
        // 优先扫这条 tool_use; 找不到再 fallback 到 result.result 文本 JSON.parse.
        for (const ev of events) {
          if (
            ev.type === 'assistant' &&
            ev.message?.content &&
            Array.isArray(ev.message.content)
          ) {
            for (const c of ev.message.content) {
              if (
                c.type === 'tool_use' &&
                (c.name === 'StructuredOutput' || c.name === 'structured_output')
              ) {
                if (c.input && typeof c.input === 'object') {
                  parsed = c.input;
                  break;
                }
              }
            }
          }
          if (parsed !== null) break;
        }
        if (parsed === null) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
        }
        settle({
          text,
          json: parsed,
          costUsd: typeof lastResult.total_cost_usd === 'number' ? lastResult.total_cost_usd : 0,
          durationMs: typeof lastResult.duration_ms === 'number' ? lastResult.duration_ms : 0,
          sessionId: typeof lastResult.session_id === 'string' ? lastResult.session_id : '',
          isError: !!lastResult.is_error,
          events,
          stderr: stderrBuf,
        });
      } else {
        settle(
          new Error(
            `claude CLI exited ${code} without 'result' event. stderr=${stderrBuf.slice(0, 500)}`,
          ),
        );
      }
    });

    // 喂 prompt
    const userMsg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: req.prompt },
    });
    child.stdin.write(userMsg + '\n');
    child.stdin.end();
  });
}

/** 抓 stream event 里 assistant 文本片段做轻量进度日志. */
export function summarizeEvent(ev: ClaudeStreamEvent): string | null {
  if (ev.type === 'system' && ev.subtype === 'init') {
    return `[claude] init session=${ev.session_id?.slice(0, 8) ?? '?'}`;
  }
  if (ev.type === 'assistant' && ev.message?.content) {
    const textBits: string[] = [];
    for (const c of ev.message.content) {
      if (c.type === 'text' && typeof c.text === 'string') {
        textBits.push(c.text.slice(0, 200));
      } else if (c.type === 'tool_use' && c.name) {
        textBits.push(`[tool_use ${c.name}]`);
      }
    }
    return textBits.length > 0 ? `[claude] ${textBits.join(' | ')}` : null;
  }
  if (ev.type === 'result') {
    return `[claude] done cost=$${(ev.total_cost_usd ?? 0).toFixed(4)} dur=${ev.duration_ms ?? 0}ms err=${ev.is_error ?? false}`;
  }
  return null;
}
