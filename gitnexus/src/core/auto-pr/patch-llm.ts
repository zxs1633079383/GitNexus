// Stage 7 · R-14 patch LLM 隔离
//
// 复用 core/wiki/llm-client（已带 retry / R-18），但 systemPrompt 强制隔离：
//  · 严禁 patch LLM 写 .github/workflows/** + .env + 任何凭证文件
//  · 强制注明"输出必须是完整文件内容（base64 编码），不输出 unified diff"
//  · 强制要求最小化改动 + 不引入新依赖

const PATCH_SYSTEM_PROMPT = `
你是一个 patch generator agent，只允许做最小化代码修改。
硬约束（违反任意一条直接拒绝输出）：
  1. 不允许修改 .github/workflows/** 任何文件
  2. 不允许写 / 改 / 删 .env / .env.* / .pem / .key / 凭证文件
  3. 不允许引入新依赖（package.json / requirements.txt / go.mod 等不动）
  4. 输出格式必须是 JSON：{ files: [{path, content_base64}] }
     content_base64 是完整文件 base64 编码，不是 unified diff
  5. 必须只动 1-3 个文件，且总改动行数 ≤ 200
  6. 必须给出推理（reasoning 字段）说明：嫌疑 commit X 引入了什么 bug，本次修改如何反向纠正

如果你判断需求不清晰 / 嫌疑不明确 / 改动会超 200 行，
返回 { abort: true, reason: "..." }，不要硬塞补丁。
`.trim();

export interface PatchLLMRequest {
  /** Stage 4 forensics 给出的最高分嫌疑 commit。 */
  suspectCommit: string;
  /** Trace 报错描述（来自 trace.errorEvent）。 */
  errorContext: string;
  /** 嫌疑 commit 的 diff（caller 喂入）。 */
  suspectDiff?: string;
  /** S5 生成的测试 scaffold 路径（可选，给 LLM 参考断言点）。 */
  scaffoldPaths?: string[];
}

export interface PatchLLMResponse {
  files: Array<{ path: string; content: string }>;
  reasoning: string;
  abort?: boolean;
  reason?: string;
}

/**
 * 调 patch LLM。
 *
 * 当前阶段（offline 环境无可用 LLM）：返回一个 stub patch 示例，并把完整 prompt 输出
 * 到 reasoning 字段，让 caller 看到 prompt 被正确隔离。
 *
 * 上线时：把 stub 段换成 `await callLLM({ system: PATCH_SYSTEM_PROMPT, user: ... })`，
 * 注意 system prompt 不要被外部 user input 覆盖（R-14 关键）。
 */
export async function callPatchLLM(req: PatchLLMRequest): Promise<PatchLLMResponse> {
  // R-14 对外承诺：systemPrompt 硬编码不接受外部覆盖
  // 当前 offline 实现：只返 stub + 把 system prompt 透出便于 caller 验证
  return {
    abort: true,
    reason:
      'patch-llm offline stub — 真实环境需把 callLLM 接入；当前 systemPrompt 已隔离',
    files: [],
    reasoning: `[STUB] system prompt:\n${PATCH_SYSTEM_PROMPT}\n\n[STUB] user request:\nsuspect=${req.suspectCommit}\nerror=${req.errorContext}\ndiff_len=${req.suspectDiff?.length ?? 0}`,
  };
}

/** 测试用：暴露 prompt 文本以便测试 systemPrompt 隔离。 */
export function getPatchSystemPromptForTest(): string {
  return PATCH_SYSTEM_PROMPT;
}
