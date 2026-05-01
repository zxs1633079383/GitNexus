// 探测: 主流标准链路 lookupStandardCrossLink 真返 conf=1.0 的 ContractLink
import { lookupStandardCrossLink } from '../src/core/group/standard-cross-link.js';

async function main() {
  const testCases = [
    { groupName: 'cses-mm', primaryRepo: 'cses', contractId: 'POST /api/cses/posts/create' },
    { groupName: 'cses-mm', primaryRepo: 'cses', contractId: 'POST /api/cses/posts/createPosts' },
    { groupName: 'cses-mm', primaryRepo: 'cses', contractId: 'POST /api/cses/teams/upsert' },
    // 不存在的 contract — 应该返 []
    { groupName: 'cses-mm', primaryRepo: 'cses', contractId: 'POST /not/in/manifest' },
    // 反向 — mattermost 是 consumer? 应该返 [] (manifest 里 cses 是 consumer 端)
    { groupName: 'cses-mm', primaryRepo: 'mattermost', contractId: 'POST /api/cses/posts/create' },
  ];

  for (const tc of testCases) {
    const links = await lookupStandardCrossLink(tc);
    console.log(`\n[${tc.primaryRepo}] ${tc.contractId}`);
    if (links.length === 0) {
      console.log(`  → 0 links`);
    } else {
      for (const l of links) {
        console.log(`  → partner=${l.partnerRepo} matchType=${l.matchType} conf=${l.confidence}`);
        console.log(`      uid=${l.partnerHandler.uid}`);
        console.log(`      file=${l.partnerHandler.filePath}, name=${l.partnerHandler.name}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
