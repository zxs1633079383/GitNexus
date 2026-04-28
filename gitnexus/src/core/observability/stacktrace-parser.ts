// query-only — must not be called from any pipeline phase
//
// Phase 0 / Stage 2 — Trace2Code Resolver
// 解析 OTel `exception.stacktrace` 顶帧 → (file, class.method, line)。
// 这是 Phase 0 fallback 第 5 层；当 HTTP / gRPC / topic / code 直查全 miss
// 时, 仅靠 stacktrace 也能反查到 handler symbol。
//
// 业务零侵入: stacktrace 是 OTel auto-instrument 自动写的, 团队不必改代码。
//
// Roadmap §3.1, RULES §0.3 / §0.4

export interface ParsedFrame {
  /** 顶帧文件名 (含扩展名, 不含目录路径; 例: TaskMemberReader.java) */
  file: string;
  /** 顶帧符号名, 已规范化为 ClassName.methodName 形态 */
  classMethod: string;
  /** 顶帧行号 */
  line: number;
  /** 原始一行文本, 留给 caller 诊断 */
  raw: string;
}

/**
 * 从 stacktrace 文本里取顶帧。
 *
 * 支持的语言形态:
 *  - Java/Kotlin/Scala: `at pkg.Cls.method(File.java:96)` (主战场, 含 Micronaut)
 *  - Python:            `  File "x/y.py", line 12, in fn`
 *  - JS/TS V8:          `    at Cls.method (file.ts:34:5)`  /  `at fn (file.js:1:2)`
 *  - Go:                `pkg/foo.bar(...)\n\t/abs/path/foo.go:42 +0x12`
 *
 * 策略: 去掉首行的异常类型/消息, 取第一条 frame 行解析。解析失败返回 null
 * (caller 走 'unknown' 分支)。
 */
export function parseStacktraceTopFrame(stack: string | undefined | null): ParsedFrame | null {
  if (!stack || typeof stack !== 'string') return null;

  const lines = stack
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  for (const line of lines) {
    const parsed = parseOneFrame(line);
    if (parsed) return parsed;
  }
  return null;
}

function parseOneFrame(line: string): ParsedFrame | null {
  // Java/Kotlin/Scala: `at pkg.sub.Cls.method(File.java:96)`
  // 也兼容 `at pkg.Cls$Inner.method(File.kt:12)` / `... (Native Method)` 跳过
  const java = /^at\s+([\w$.<>]+)\.([\w$<>]+)\(([^:)]+):(\d+)\)/.exec(line);
  if (java) {
    const cls = java[1].split('.').pop() ?? java[1];
    return { file: java[3], classMethod: `${cls}.${java[2]}`, line: Number(java[4]), raw: line };
  }

  // V8 (JS/TS): `at Cls.method (path/to/file.ts:34:5)` 或 `at fn (file.js:1:2)`
  const v8WithFn = /^at\s+([\w$.<>]+)\s+\(([^):]+):(\d+):\d+\)/.exec(line);
  if (v8WithFn) {
    const fn = v8WithFn[1];
    const filePath = v8WithFn[2];
    const file = filePath.split(/[/\\]/).pop() ?? filePath;
    return { file, classMethod: fn, line: Number(v8WithFn[3]), raw: line };
  }
  // V8 anonymous: `at /path/file.ts:12:3`
  const v8Anon = /^at\s+([^\s(]+):(\d+):\d+/.exec(line);
  if (v8Anon) {
    const file = v8Anon[1].split(/[/\\]/).pop() ?? v8Anon[1];
    return { file, classMethod: '<anonymous>', line: Number(v8Anon[2]), raw: line };
  }

  // Python: `File "x/y.py", line 12, in fn`
  const py = /File\s+"([^"]+)",\s+line\s+(\d+),\s+in\s+([\w$.<>]+)/.exec(line);
  if (py) {
    const file = py[1].split(/[/\\]/).pop() ?? py[1];
    return { file, classMethod: py[3], line: Number(py[2]), raw: line };
  }

  // Go: 配对 frame 一般是两行, 这里取 `pkg/foo.bar(args)` 紧跟 `\tfile.go:42`。
  // 容错: 也尝试单行 `path/foo.go:42`
  const go = /([\w$./<>-]+\.go):(\d+)/.exec(line);
  if (go) {
    const file = go[1].split(/[/\\]/).pop() ?? go[1];
    return { file, classMethod: '<go-frame>', line: Number(go[2]), raw: line };
  }

  return null;
}
