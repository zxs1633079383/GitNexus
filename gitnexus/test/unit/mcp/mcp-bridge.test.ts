// mvp/v1.2.0-bridge — scripts/mcp-bridge.ts 单测
//
// 覆盖:
// 1. parseMarkdownTable — 正常 / 空表 / 列数不齐 / 分隔行不合法
// 2. parseMethodId — 1.4.1 真 id 格式 / filePath 含冒号 / 不合法格式
// 3. resolveHandler — 三层 fallback (name+file / name+class / name-only / 都未命中)
// 4. blastRadius — upstream / downstream / both / cypher 注入字符串转义
// 5. callCypher — HTTP 错误码 / JSON 解析失败 / body.error 字段
// 6. pingEvalServer — health 路径 / 错误码 / 网络错误

import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseMarkdownTable,
  parseMethodId,
  callCypher,
  resolveHandler,
  blastRadius,
  pingEvalServer,
} from '../../../scripts/mcp-bridge.js';
import { violatesSafetyPolicy } from '../../../scripts/patch-runner.js';

interface MockCall {
  url: string;
  body: unknown;
}

function mkFetch(
  responses: Array<{ status?: number; body: unknown } | ((req: MockCall) => { status?: number; body: unknown })>,
): { fetch: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  let idx = 0;
  const fn: any = async (url: string, init?: RequestInit) => {
    const req: MockCall = {
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(req);
    const spec = responses[idx++] ?? responses[responses.length - 1];
    const out = typeof spec === 'function' ? spec(req) : spec;
    return {
      ok: (out.status ?? 200) >= 200 && (out.status ?? 200) < 300,
      status: out.status ?? 200,
      text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)),
      json: async () => out.body,
    };
  };
  return { fetch: fn, calls };
}

describe('parseMarkdownTable', () => {
  it('解析标准 2 列表', () => {
    const md = '| total |\n| --- |\n| 65715 |';
    expect(parseMarkdownTable(md)).toEqual([{ total: '65715' }]);
  });

  it('解析多列多行', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |';
    expect(parseMarkdownTable(md)).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('空字符串/不足 3 行 → []', () => {
    expect(parseMarkdownTable('')).toEqual([]);
    expect(parseMarkdownTable('| a |')).toEqual([]);
    expect(parseMarkdownTable('| a |\n| --- |')).toEqual([]);
  });

  it('分隔行不合法 → []', () => {
    expect(parseMarkdownTable('| a |\n| xxx |\n| 1 |')).toEqual([]);
  });

  it('列数不齐的行被丢弃', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| only-one |';
    expect(parseMarkdownTable(md)).toEqual([{ a: '1', b: '2' }]);
  });
});

describe('parseMethodId', () => {
  it('真 1.4.1 id 格式', () => {
    const out = parseMethodId(
      'Method:server/src/main/java/org/cses/server/service/taskManage/application/task/query/reader/TaskMemberReader.java:loadSnapshot:93',
    );
    expect(out).toEqual({
      filePath: 'server/src/main/java/org/cses/server/service/taskManage/application/task/query/reader/TaskMemberReader.java',
      name: 'loadSnapshot',
      line: 93,
    });
  });

  it('filePath 含冒号也能正确切', () => {
    const out = parseMethodId('Method:weird:path:with:colons.java:foo:42');
    expect(out).toEqual({ filePath: 'weird:path:with:colons.java', name: 'foo', line: 42 });
  });

  it('不合法格式 → null', () => {
    expect(parseMethodId('Function:foo')).toBeNull();
    expect(parseMethodId('not a method')).toBeNull();
  });
});

describe('callCypher', () => {
  it('正常返回 markdown → 解析成 rows', async () => {
    const { fetch: f, calls } = mkFetch([
      { body: { markdown: '| n |\n| --- |\n| ok |', row_count: 1 } },
    ]);
    const r = await callCypher('MATCH (n) RETURN n', 'cses-java', f);
    expect(r.rows).toEqual([{ n: 'ok' }]);
    expect(calls[0].url).toContain('/tool/cypher');
    expect(calls[0].body).toEqual({ query: 'MATCH (n) RETURN n', repo: 'cses-java' });
  });

  it('HTTP 500 → 返回 error', async () => {
    const { fetch: f } = mkFetch([{ status: 500, body: 'oops' }]);
    const r = await callCypher('Q', 'r', f);
    expect(r.rows).toEqual([]);
    expect(r.error).toMatch(/HTTP 500/);
  });

  it('非 JSON body → 返回原文', async () => {
    const { fetch: f } = mkFetch([{ body: 'plain text' }]);
    const r = await callCypher('Q', 'r', f);
    expect(r.rows).toEqual([]);
    expect(r.raw).toBe('plain text');
  });

  it('body.error → 返回 error', async () => {
    const { fetch: f } = mkFetch([{ body: { error: 'bad query' } }]);
    const r = await callCypher('Q', 'r', f);
    expect(r.error).toBe('bad query');
  });
});

describe('resolveHandler', () => {
  it('优先 name+file 命中, 不再走后续两层', async () => {
    const { fetch: f, calls } = mkFetch([
      {
        body: {
          markdown:
            '| id | file | line |\n| --- | --- | --- |\n| Method:a/b.java:loadSnapshot:93 | a/b.java | 93 |',
        },
      },
    ]);
    const r = await resolveHandler(
      { name: 'loadSnapshot', fileHint: 'a/b.java', classHint: 'B', repo: 'cses-java' },
      f,
    );
    expect(r?.uid).toBe('Method:a/b.java:loadSnapshot:93');
    expect(r?.startLine).toBe(93);
    expect(r?.resolvedBy).toBe('name+file');
    expect(calls.length).toBe(1);
  });

  it('name+file 未命中, name+class 命中', async () => {
    const { fetch: f, calls } = mkFetch([
      { body: { markdown: '' } },
      {
        body: {
          markdown:
            '| id | file | line |\n| --- | --- | --- |\n| Method:x/Foo.java:fn:10 | x/Foo.java | 10 |',
        },
      },
    ]);
    const r = await resolveHandler(
      { name: 'fn', fileHint: 'no.java', classHint: 'Foo', repo: 'r' },
      f,
    );
    expect(r?.resolvedBy).toBe('name+class');
    expect(calls.length).toBe(2);
  });

  it('两层都没命中, name-only 兜底', async () => {
    const { fetch: f, calls } = mkFetch([
      { body: { markdown: '' } },
      { body: { markdown: '' } },
      {
        body: {
          markdown:
            '| id | file | line |\n| --- | --- | --- |\n| Method:y.java:bar:1 | y.java | 1 |',
        },
      },
    ]);
    const r = await resolveHandler(
      { name: 'bar', fileHint: 'a.java', classHint: 'C', repo: 'r' },
      f,
    );
    expect(r?.resolvedBy).toBe('name-only');
    expect(calls.length).toBe(3);
  });

  it('全都没命中 → null', async () => {
    const { fetch: f } = mkFetch([
      { body: { markdown: '' } },
      { body: { markdown: '' } },
    ]);
    const r = await resolveHandler({ name: 'gone', repo: 'r' }, f);
    expect(r).toBeNull();
  });

  it('cypher 字面量转义 — 防注入', async () => {
    const { fetch: f, calls } = mkFetch([{ body: { markdown: '' } }]);
    await resolveHandler({ name: 'a"b', repo: 'r' }, f);
    expect(String(calls[0].body)).not.toMatch(/m\.name = "a"b"/);
    expect(String((calls[0].body as any).query)).toContain('a\\"b');
  });
});

describe('blastRadius', () => {
  // 这些 case 测 cypher fallback 路径 — CLI 不存在时 (本机测试无 gitnexus binary 在 PATH 假设).
  // 跑 vitest 时 GITNEXUS_BIN 设为不存在的命令 → impact CLI spawn 失败 → 自动落到 cypher fallback.
  // 见 vitest.bridge.config.ts setEnv.

  it('CLI 不可用 → cypher fallback, upstream 走 <- 箭头', async () => {
    const { fetch: f, calls } = mkFetch([
      {
        body: {
          markdown:
            '| name | file |\n| --- | --- |\n| handle | x/H.java |\n| handle | x/H.java |\n| read | y/R.java |',
        },
      },
    ]);
    const r = await blastRadius(
      { name: 'loadSnapshot', repo: 'cses-java', direction: 'upstream', depth: 2 },
      f,
    );
    expect(r.strategy).toBe('cypher-fallback');
    expect((calls[0].body as any).query).toContain('<-[*1..2]-');
    expect(r.callers.length).toBe(3);
    expect(r.files.sort()).toEqual(['x/H.java', 'y/R.java']);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it('downstream → -> 箭头', async () => {
    const { fetch: f, calls } = mkFetch([{ body: { markdown: '' } }]);
    await blastRadius({ name: 'a', repo: 'r', direction: 'downstream' }, f);
    expect((calls[0].body as any).query).toContain('-[*1..2]->');
  });

  it('both → 无方向箭头', async () => {
    const { fetch: f, calls } = mkFetch([{ body: { markdown: '' } }]);
    await blastRadius({ name: 'a', repo: 'r', direction: 'both', depth: 1 }, f);
    expect((calls[0].body as any).query).toMatch(/-\[\*1\.\.1\]-\(other\)/);
  });

  it('limit 截断到 500', async () => {
    const { fetch: f, calls } = mkFetch([{ body: { markdown: '' } }]);
    await blastRadius({ name: 'a', repo: 'r', limit: 99999 }, f);
    expect((calls[0].body as any).query).toContain('LIMIT 500');
  });

  it('depth 截断到 1..4', async () => {
    const { fetch: f, calls } = mkFetch([
      { body: { markdown: '' } },
      { body: { markdown: '' } },
    ]);
    await blastRadius({ name: 'a', repo: 'r', depth: 0 }, f);
    expect((calls[0].body as any).query).toContain('*1..1]');
    await blastRadius({ name: 'a', repo: 'r', depth: 99 }, f);
    expect((calls[1].body as any).query).toContain('*1..4]');
  });

  it('cypher 也空 → strategy=none', async () => {
    const { fetch: f } = mkFetch([{ body: { markdown: '' } }]);
    const r = await blastRadius({ name: 'isolated', repo: 'r' }, f);
    expect(r.strategy).toBe('none');
    expect(r.total).toBe(0);
  });
});

describe('violatesSafetyPolicy (R-14 黑名单, single-repo/v1.0.1 H-1 修加宽)', () => {
  it('放行普通业务源码', () => {
    expect(violatesSafetyPolicy('server/src/main/java/com/foo/Bar.java')).toBeNull();
    expect(violatesSafetyPolicy('src/test/java/com/foo/BarTest.java')).toBeNull();
    expect(violatesSafetyPolicy('.gitnexus/reports/auto-pr-issue-22.md')).toBeNull();
  });

  it('R-14.1 拦 .github 整个目录 (不只 workflows)', () => {
    expect(violatesSafetyPolicy('.github/workflows/ci.yml')).toMatch(/R-14\.1/);
    expect(violatesSafetyPolicy('.github/CODEOWNERS')).toMatch(/R-14\.1/);
    expect(violatesSafetyPolicy('.github/dependabot.yml')).toMatch(/R-14\.1/);
    expect(violatesSafetyPolicy('CODEOWNERS')).toMatch(/R-14\.1/);
    expect(violatesSafetyPolicy('.gitlab-ci.yml')).toMatch(/R-14\.1/);
  });

  it('R-14.2 拦 .env / 凭证扩展 / npmrc / Spring application.properties', () => {
    expect(violatesSafetyPolicy('.env')).toMatch(/R-14\.2/);
    expect(violatesSafetyPolicy('config/.env.production')).toMatch(/R-14\.2/);
    expect(violatesSafetyPolicy('certs/server.pem')).toMatch(/R-14\.2/);
    expect(violatesSafetyPolicy('foo.p12')).toMatch(/R-14\.2/);
    expect(violatesSafetyPolicy('foo.jks')).toMatch(/R-14\.2/);
    expect(violatesSafetyPolicy('.npmrc')).toMatch(/R-14\.2/);
    expect(violatesSafetyPolicy('id_rsa')).toMatch(/R-14\.2/);
    expect(violatesSafetyPolicy('server/src/main/resources/application.properties')).toMatch(/R-14\.2/);
    expect(violatesSafetyPolicy('server/src/main/resources/application-prod.yml')).toMatch(/R-14\.2/);
    expect(violatesSafetyPolicy('secrets/api-key')).toMatch(/R-14\.2/);
  });

  it('R-14.3 拦各语言依赖清单', () => {
    expect(violatesSafetyPolicy('package.json')).toMatch(/R-14\.3/);
    expect(violatesSafetyPolicy('pnpm-lock.yaml')).toMatch(/R-14\.3/);
    expect(violatesSafetyPolicy('pom.xml')).toMatch(/R-14\.3/);
    expect(violatesSafetyPolicy('build.gradle.kts')).toMatch(/R-14\.3/);
    expect(violatesSafetyPolicy('gradle.properties')).toMatch(/R-14\.3/);
    expect(violatesSafetyPolicy('go.sum')).toMatch(/R-14\.3/);
    expect(violatesSafetyPolicy('Cargo.lock')).toMatch(/R-14\.3/);
    expect(violatesSafetyPolicy('pyproject.toml')).toMatch(/R-14\.3/);
    expect(violatesSafetyPolicy('Pipfile.lock')).toMatch(/R-14\.3/);
  });

  it('R-14.4 拦 docker-compose / Dockerfile / k8s / helm / terraform', () => {
    expect(violatesSafetyPolicy('docker-compose.yml')).toMatch(/R-14\.4/);
    expect(violatesSafetyPolicy('docker-compose.prod.yaml')).toMatch(/R-14\.4/);
    expect(violatesSafetyPolicy('Dockerfile')).toMatch(/R-14\.4/);
    expect(violatesSafetyPolicy('Dockerfile.prod')).toMatch(/R-14\.4/);
    expect(violatesSafetyPolicy('k8s/prod-deployment.yaml')).toMatch(/R-14\.4/);
    expect(violatesSafetyPolicy('helm/myapp/values.yaml')).toMatch(/R-14\.4/);
    expect(violatesSafetyPolicy('charts/myapp/templates/deployment.yaml')).toMatch(/R-14\.4/);
    expect(violatesSafetyPolicy('infra/main.tf')).toMatch(/R-14\.4/);
    expect(violatesSafetyPolicy('terraform.tfvars')).toMatch(/R-14\.4/);
    expect(violatesSafetyPolicy('Chart.yaml')).toMatch(/R-14\.4/);
    expect(violatesSafetyPolicy('values-prod.yml')).toMatch(/R-14\.4/);
  });

  it('R-14.5 拦 CI 配置 (Jenkins/Travis/CircleCI/Drone/Azure)', () => {
    expect(violatesSafetyPolicy('Jenkinsfile')).toMatch(/R-14\.5/);
    expect(violatesSafetyPolicy('.drone.yml')).toMatch(/R-14\.5/);
    expect(violatesSafetyPolicy('.travis.yml')).toMatch(/R-14\.5/);
    expect(violatesSafetyPolicy('azure-pipelines.yml')).toMatch(/R-14\.5/);
    expect(violatesSafetyPolicy('.circleci/config.yml')).toMatch(/R-14\.5/);
  });

  it('路径穿越拦 ..', () => {
    expect(violatesSafetyPolicy('../etc/passwd')).toMatch(/path 含 \.\./);
    expect(violatesSafetyPolicy('src/../../boom')).toMatch(/path 含 \.\./);
  });
});

describe('pingEvalServer', () => {
  it('health=ok → ok=true + repos[]', async () => {
    const { fetch: f } = mkFetch([{ body: { status: 'ok', repos: ['a', 'b'] } }]);
    const r = await pingEvalServer(f);
    expect(r.ok).toBe(true);
    expect(r.repos).toEqual(['a', 'b']);
  });

  it('HTTP 500 → ok=false + error', async () => {
    const { fetch: f } = mkFetch([{ status: 500, body: 'down' }]);
    const r = await pingEvalServer(f);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/HTTP 500/);
  });

  it('网络抛错 → ok=false', async () => {
    const errFetch: any = async () => {
      throw new Error('ECONNREFUSED');
    };
    const r = await pingEvalServer(errFetch);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('ECONNREFUSED');
  });
});
