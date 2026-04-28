// 横切 · Pipeline Orchestrator 单测（无 LadybugDB 依赖，纯 deps mock）
//
// 覆盖：
//  1) 4 阶段全 ok → overall=success
//  2) S2 全失败 → S3/S5 skipped；S4 仍跑；overall=no-handler
//  3) 单条 span S2 失败 → 该 span 不进 handler set，其他 spans 不受影响
//  4) S3 中某 handler 失败 → overall=partial（其他 handler 继续）
//  5) S6 / S7 永远 skipped 直到解锁

import { describe, expect, it } from 'vitest';
import { runPipeline } from '../../src/core/pipeline/orchestrator.js';
import type { OrchestratorDeps } from '../../src/core/pipeline/types.js';

const SPAN1 = { spanID: 'a', operationName: 'POST /a' } as any;
const SPAN2 = { spanID: 'b', operationName: 'POST /b' } as any;

const okResolve = (uid: string) =>
  Promise.resolve({ resolved: true, handler: { uid, name: uid }, kind: 'http' } as any);

const happyDeps: OrchestratorDeps = {
  resolveSpan: async (s) => {
    const id = (s as any).spanID;
    return okResolve(id === 'a' ? 'Method:handlerA' : 'Method:handlerB');
  },
  apiBlastRadius: async (p) => ({ target_uid: p.target_uid, files: ['x.java'] }),
  regressionForensics: async (p) => ({ suspects: [], spanCount: p.spans.length }),
  genE2ETests: async (p) => ({ target_uid: p.target_uid, files: ['t.java'] }),
};

describe('runPipeline', () => {
  it('4 阶段全 ok → overall=success', async () => {
    const r = await runPipeline({ spans: [SPAN1, SPAN2] }, happyDeps);
    expect(r.overall).toBe('success');
    expect(r.s2_resolve.length).toBe(2);
    expect(r.resolvedHandlerUids.sort()).toEqual(['Method:handlerA', 'Method:handlerB']);
    expect(r.s3_blast.length).toBe(2);
    expect(r.s4_forensics.status).toBe('ok');
    expect(r.s5_testgen.length).toBe(2);
    expect(r.s6_preview.status).toBe('skipped');
    expect(r.s7_autopr.status).toBe('skipped');
  });

  it('S2 全失败 → no-handler；S3/S5 skipped；S4 仍跑', async () => {
    const r = await runPipeline(
      { spans: [SPAN1] },
      { ...happyDeps, resolveSpan: async () => Promise.reject(new Error('boom')) },
    );
    expect(r.overall).toBe('no-handler');
    expect(r.s2_resolve[0].status).toBe('error');
    expect(r.resolvedHandlerUids).toEqual([]);
    expect(r.s3_blast[0].status).toBe('skipped');
    expect(r.s5_testgen[0].status).toBe('skipped');
    expect(r.s4_forensics.status).toBe('ok'); // forensics 仍跑
  });

  it('单条 span resolve 失败不阻断其他 span', async () => {
    const deps: OrchestratorDeps = {
      ...happyDeps,
      resolveSpan: async (s) =>
        (s as any).spanID === 'a'
          ? okResolve('Method:handlerA')
          : Promise.reject(new Error('span b dies')),
    };
    const r = await runPipeline({ spans: [SPAN1, SPAN2] }, deps);
    expect(r.s2_resolve[0].status).toBe('ok');
    expect(r.s2_resolve[1].status).toBe('error');
    expect(r.resolvedHandlerUids).toEqual(['Method:handlerA']);
    expect(r.s3_blast.length).toBe(1);
    expect(r.overall).toBe('partial');
  });

  it('S3 某 handler 抛错 → overall=partial（其他 stage 不阻断）', async () => {
    const deps: OrchestratorDeps = {
      ...happyDeps,
      apiBlastRadius: async (p) =>
        p.target_uid === 'Method:handlerA'
          ? Promise.reject(new Error('blast crash'))
          : { ok: 1 },
    };
    const r = await runPipeline({ spans: [SPAN1, SPAN2] }, deps);
    expect(r.overall).toBe('partial');
    const errCount = r.s3_blast.filter((x) => x.status === 'error').length;
    expect(errCount).toBe(1);
    expect(r.s5_testgen.length).toBe(2); // S5 完全独立
  });

  it('blast depth/crossDepth 透传给 apiBlastRadius', async () => {
    const calls: any[] = [];
    const deps: OrchestratorDeps = {
      ...happyDeps,
      apiBlastRadius: async (p) => {
        calls.push(p);
        return { ok: 1 };
      },
    };
    await runPipeline(
      { spans: [SPAN1], blast: { depth: 5, crossDepth: 2 } },
      deps,
    );
    expect(calls[0]).toMatchObject({ depth: 5, cross_depth: 2, direction: 'both' });
  });
});
