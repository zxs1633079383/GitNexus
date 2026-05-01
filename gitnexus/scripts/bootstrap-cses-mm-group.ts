// 一次性脚本: 建 cses + mattermost group + 跑 group sync (写 bridge.lbug + ContractLink)
//
// 用途: 段 C 切回主流标准链路的预备动作 (取代缺失的 `gitnexus group sync` CLI).
// 跑法:   cd gitnexus && npx tsx scripts/bootstrap-cses-mm-group.ts
//
// 前置:   段 A (npm install @ladybugdb/core 通过) + 段 B (lbug native 烟测过)
//        registry 里 cses + mattermost 都已索引 (由 readRegistry() 读出验证)
//
// 输出:
//   ~/.gitnexus/groups/cses-mm/{group.yaml, contracts.json, bridge.lbug, bridge.meta.json}
//
// 关联文档: docs/learn/lbug-切换-回归测试-环境清单-v1.md 段 C

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGroupDir, getDefaultGitnexusDir, getGroupDir } from '../src/core/group/storage.js';
import { loadGroupConfig } from '../src/core/group/config-parser.js';
import { syncGroup } from '../src/core/group/sync.js';
import { writeBridge, writeBridgeMeta } from '../src/core/group/bridge-db.js';
import { BRIDGE_SCHEMA_VERSION } from '../src/core/group/bridge-schema.js';
import { readRegistry } from '../src/storage/repo-manager.js';

const GROUP_NAME = 'cses-mm';
const REPOS = {
  // group path → registry name (defaultResolveHandle 会按 registry name 找 entry)
  cses: 'cses',
  mattermost: 'mattermost',
};

async function main() {
  console.log(`[bootstrap] start group=${GROUP_NAME}`);

  // 1) 验 registry 里两仓都已索引
  const registry = await readRegistry();
  const missing: string[] = [];
  for (const regName of Object.values(REPOS)) {
    const entry = registry.find((e) => e.name === regName);
    if (!entry) {
      missing.push(regName);
    } else {
      console.log(
        `[bootstrap] ✓ registry: ${entry.name} → ${entry.path} (lastCommit=${entry.lastCommit?.slice(0, 8)})`,
      );
    }
  }
  if (missing.length > 0) {
    console.error(`[bootstrap] ✗ registry 缺失: ${missing.join(', ')}; 先 gitnexus analyze`);
    process.exit(1);
  }

  // 2) 建 group dir + 改 group.yaml repos 段
  const gitnexusDir = getDefaultGitnexusDir();
  const groupDir = getGroupDir(gitnexusDir, GROUP_NAME);

  // group.yaml 处理:
  //   - 若存在 → reuse (保留 manifest links 等手工配置, 不覆盖)
  //   - 若不存在 → 用 createGroupDir 模板, 然后手工填 repos 段
  if (!fs.existsSync(path.join(groupDir, 'group.yaml'))) {
    await createGroupDir(gitnexusDir, GROUP_NAME, false);
    const yamlContent = `version: 1
name: ${GROUP_NAME}
description: "cses-java + mattermost cross-repo bridge for Agentic DevOps S3 standard chain"

repos:
  cses: ${REPOS.cses}
  mattermost: ${REPOS.mattermost}

links: []

packages: {}

detect:
  http: true
  grpc: true
  topics: true
  shared_libs: true
  embedding_fallback: true

matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`;
    await fsp.writeFile(path.join(groupDir, 'group.yaml'), yamlContent, 'utf-8');
    console.log(`[bootstrap] created + wrote ${groupDir}/group.yaml`);
  } else {
    console.log(`[bootstrap] reuse existing ${groupDir}/group.yaml (manifest links preserved)`);
  }

  // 3) 加载 + sync
  const config = await loadGroupConfig(groupDir);
  console.log(
    `[bootstrap] config loaded: version=${config.version} repos=${Object.keys(config.repos).join(',')}`,
  );

  const dryRun = process.env.BOOTSTRAP_DRY_RUN === '1';
  console.log(`[bootstrap] running syncGroup (dryRun=${dryRun}) ...`);
  const t0 = Date.now();
  const result = await syncGroup(config, {
    groupDir,
    verbose: true,
    skipEmbeddings: true, // 第一遍跑通就行, embedding 走默认
    skipWrite: dryRun,    // BOOTSTRAP_DRY_RUN=1 时只 extract+match, 不写 bridge.lbug
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // 4) 输出统计
  console.log(`\n[bootstrap] ────────── sync done in ${elapsed}s ──────────`);
  console.log(`  contracts:    ${result.contracts.length}`);
  console.log(`  crossLinks:   ${result.crossLinks.length}`);
  console.log(`  unmatched:    ${result.unmatched.length}`);
  console.log(`  missingRepos: ${result.missingRepos.length === 0 ? 'none' : result.missingRepos.join(',')}`);

  const providers = result.contracts.filter((c) => c.role === 'provider').length;
  const consumers = result.contracts.filter((c) => c.role === 'consumer').length;
  console.log(`  providers:    ${providers}`);
  console.log(`  consumers:    ${consumers}`);

  if (dryRun) {
    console.log(`\n[bootstrap] BOOTSTRAP_DRY_RUN=1 — skipping bridge.lbug write`);
    return;
  }

  // 5) 写 bridge.lbug + meta.json (真签名: WriteBridgeInput + BridgeMeta)
  console.log(`\n[bootstrap] writing bridge.lbug...`);
  const bridgeReport = await writeBridge(groupDir, {
    contracts: result.contracts,
    crossLinks: result.crossLinks,
    repoSnapshots: result.repoSnapshots,
    missingRepos: result.missingRepos,
  });
  console.log(
    `  bridge: contractsInserted=${bridgeReport.contractsInserted}/${bridgeReport.contractsFailed} failed, ` +
      `linksInserted=${bridgeReport.linksInserted}/${bridgeReport.linksFailed} failed, ` +
      `linksDroppedMissingNode=${bridgeReport.linksDroppedMissingNode}, ` +
      `snapshotsInserted=${bridgeReport.snapshotsInserted}`,
  );

  await writeBridgeMeta(groupDir, {
    version: BRIDGE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    missingRepos: result.missingRepos,
  });
  console.log(`  meta.json: version=${BRIDGE_SCHEMA_VERSION}`);

  // 6) 验收提示
  console.log(`\n[bootstrap] ✓ done — verify next:`);
  console.log(`  ls -lh ${groupDir}/{group.yaml,contracts.json,bridge.lbug,meta.json}`);
  console.log(`  npx tsx scripts/probe-cses-mm-impact.ts <a-real-uid>   # 段 C4 验 runGroupImpact`);
}

main().catch((err) => {
  console.error(`[bootstrap] FATAL:`, err);
  process.exit(1);
});
