// mvp/v1.2.0-bridge — smoke test
//
// 不依赖 webhook server / GitLab / S6 K8s, 只验证:
//   1. eval-server health 通
//   2. bridge.resolveHandler 反查到真 Method.id (含真业务 filePath)
//   3. bridge.blastRadius 返回真 caller 文件列表 (不是 'Handler.java' mock)
//
// 这是 §15.5 DOD "真业务文件路径" 的可验证证据 — 不需要重启 LIVE 模式 webhook.
//
// 跑法:
//   gitnexus eval-server --port 4848 &
//   GITNEXUS_BRIDGE_REPO=cses-java npx tsx scripts/smoke-bridge.ts

import {
  pingEvalServer,
  resolveHandler,
  blastRadius,
  parseMethodId,
} from './mcp-bridge.js';

const REPO = process.env.GITNEXUS_BRIDGE_REPO ?? 'cses-java';

async function main() {
  console.log(`▶ smoke target repo = ${REPO}`);

  // ─── Step 1: ping ─────────────────────────────────────
  const ping = await pingEvalServer(fetch);
  if (!ping.ok) {
    console.error(`✗ eval-server 不可达: ${ping.error}`);
    process.exit(1);
  }
  console.log(`✓ eval-server 通; 已索引 ${ping.repos.length} 仓; 含 ${REPO}: ${ping.repos.includes(REPO)}`);

  // ─── Step 2: resolveHandler — 模拟 Stage 2 反查 ───────
  // 真 trace 顶帧 (来自 session.md fixture #1):
  //   classMethod = "TaskMemberReader.loadSnapshot"
  //   file        = "TaskMemberReader.java"
  const r = await resolveHandler(
    {
      name: 'loadSnapshot',
      classHint: 'TaskMemberReader',
      fileHint: 'TaskMemberReader.java',
      repo: REPO,
    },
    fetch,
  );
  if (!r) {
    console.error('✗ resolveHandler 未命中 — bridge 反查失败');
    process.exit(2);
  }
  console.log(`\n[Stage 2 真反查]`);
  console.log(`  uid       = ${r.uid}`);
  console.log(`  filePath  = ${r.filePath}`);
  console.log(`  startLine = ${r.startLine}`);
  console.log(`  resolved  = ${r.resolvedBy}`);

  const parsed = parseMethodId(r.uid);
  if (!parsed) {
    console.error('✗ Method.id 无法解析 — bridge.parseMethodId bug');
    process.exit(3);
  }

  // ─── Step 3: blastRadius — 模拟 Stage 3 跨调用链算影响 ─
  const b = await blastRadius(
    {
      name: parsed.name,
      repo: REPO,
      direction: 'upstream',
      depth: 2,
      limit: 30,
    },
    fetch,
  );
  console.log(`\n[Stage 3 真 blast radius]`);
  console.log(`  target    = ${b.target}`);
  console.log(`  total     = ${b.total} callers (depth=${b.depth}${b.truncated ? ', truncated' : ''})`);
  console.log(`  files     = ${b.files.length} 个真业务文件:`);
  for (const f of b.files.slice(0, 10)) console.log(`    · ${f}`);
  if (b.files.length > 10) console.log(`    · … 还有 ${b.files.length - 10}`);

  // ─── DOD 校验 ─────────────────────────────────────────
  const isMock =
    b.files.length === 0 ||
    b.files.every((f) => f === 'Handler.java' || f === 'Service.java');
  if (isMock) {
    console.error('\n✗ files 看起来仍是 mock — bridge 未生效');
    process.exit(4);
  }
  if (!r.filePath.includes('TaskMemberReader')) {
    console.error('\n✗ resolveHandler 的 filePath 与 fixture #1 期望不一致');
    process.exit(5);
  }
  console.log('\n✅ smoke pass — bridge 反查到真 filePath, S3 拿到真 caller 文件列表');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(99);
});
