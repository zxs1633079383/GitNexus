// 探测: bridge.lbug 真能读 + Contract 节点 + ContractLink 边 + ContractLookupIndex 三层就绪
import lbug from '@ladybugdb/core';
import * as path from 'node:path';
import { getDefaultGitnexusDir, getGroupDir } from '../src/core/group/storage.js';
import { readBridgeMeta } from '../src/core/group/bridge-db.js';

async function main() {
  const groupDir = getGroupDir(getDefaultGitnexusDir(), 'cses-mm');
  const dbPath = path.join(groupDir, 'bridge.lbug');

  console.log('=== bridge.meta.json ===');
  const meta = await readBridgeMeta(groupDir);
  console.log(`  version=${meta.version}, generatedAt=${meta.generatedAt}, missingRepos=${meta.missingRepos}`);

  console.log('\n=== open bridge.lbug readOnly ===');
  const db = new (lbug as any).Database(dbPath, 0, false, true);
  const conn = new (lbug as any).Connection(db);
  console.log('  open ok');

  console.log('\n=== Contract count by role/type ===');
  const r1 = await conn.query(
    `MATCH (c:Contract) RETURN c.role AS role, c.type AS type, count(*) AS n`,
  );
  for (const row of await r1.getAll()) {
    console.log(`  ${row.role.padEnd(10)} ${String(row.type).padEnd(8)} = ${row.n}`);
  }

  console.log('\n=== ContractLink count ===');
  const r2 = await conn.query(`MATCH ()-[l:ContractLink]->() RETURN count(*) AS n, collect(l.matchType)[0..3] AS types`);
  for (const row of await r2.getAll()) {
    console.log(`  links=${row.n}, sample matchTypes=${JSON.stringify(row.types)}`);
  }

  console.log('\n=== Contract sample (3 providers + 3 consumers) ===');
  const r3 = await conn.query(
    `MATCH (c:Contract) RETURN c.repo AS repo, c.role AS role, c.contractId AS cid, c.symbolName AS sym ORDER BY c.role LIMIT 6`,
  );
  for (const row of await r3.getAll()) {
    console.log(`  ${row.role.padEnd(10)} ${row.repo.padEnd(12)} ${row.cid}  →  ${row.sym}`);
  }

  conn.close();
  db.close();
  console.log('\n=== ✓ bridge.lbug end-to-end readable ===');
}
main().catch((e) => { console.error(e); process.exit(1); });
