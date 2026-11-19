// Owning PostgreSQL export boundary with synthetic exact-edition E07/E08 ports, not live truth/rights proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { withDisposableDatabase } from '../src/service-kit.ts';
import type { ObjectStore } from '../src/service-kit.ts';
import type { EditorialDeps } from '../src/engine/index.ts';
import { ADMIN, needsPg, ctx, project, block, useDecisions, CLAIM_CONTRACT, FINDING_CONTRACT } from './fixtures.ts';
const entry = process.env.EDITORIAL_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
  : createRequire(resolve(process.env.EDITORIAL_PACKAGE_ROOT, 'package.json')).resolve('@accountability/editorial-story/engine');
const { createEngine, migrate } = await import(pathToFileURL(entry).href) as typeof import('../src/engine/index.ts');
const code = (value: string) => (e: any) => e?.code === value;
for (const engine of ['E07', 'E08'] as const) for (const at of ['put', 'final-host'] as const) {
  test(`export rechecks exact ${engine} metadata after ${at} before disclosure and retains original effects`, needsPg, () => withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
    await migrate(sql); let bad = false, calls = 0, puts = 0, armed = false;
    const ref = engine === 'E07' ? CLAIM_CONTRACT : FINDING_CONTRACT;
    const ports: { -readonly [K in keyof NonNullable<EditorialDeps['ports']>]: NonNullable<EditorialDeps['ports']>[K] } = { useDecisions: useDecisions(),
      knowledge: { async getClaimStatus(_c, selected) { assert.equal(selected, ref); return { factual: bad ? 'refuted' : 'supported', editorial: 'approved', stale: false, blocked: bad }; } },
      findings: { async getFindingStatus(_c, selected) { assert.equal(selected, ref); return { ref: selected, state: bad ? 'withdrawn' : 'approved', label: 'verified_fact', classification: 'established', stale: false, blocked: bad }; } },
    };
    const objects: ObjectStore = { async put(key, bytes) { puts++; if (armed && at === 'put') bad = true; return { key, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }; },
      async get() { throw Error('no reads'); }, async head() { return null; }, async list() { return []; }, async delete() { throw Error('retained output must not be deleted'); } };
    const e = createEngine({ sql, ports, objects }); const p = await e.create(ctx(), 'editorial_project', { body: project() });
    const d = await e.create(ctx(), 'document', { body: { title: 'Fictional private factual export', editorialProjectId: p.id, docType: 'article', language: 'en', blocks: [block('fact', { sources: [ref] })] } });
    const options = { idempotencyKey: `fixed-final-facts-${engine}-${at}` };
    if (at === 'final-host') {
      await e.exportDocument(ctx(), d.id, 1, options);
      ports.authorization = { async authorize() { if (++calls === 2) bad = true; return { allowed: true, reason: 'synthetic', policyVersion: 'fixture' }; } };
    }
    armed = true; await assert.rejects(e.exportDocument(ctx(), d.id, 1, options), code('invalid_basis'));
    assert.equal(puts, 1); const original = (await e.listExports(ctx(), d.id))[0]!;
    const effects = () => sql.query(`select (select count(*)::integer from e09_editorial.exports) as exports, (select count(*)::integer from e09_editorial._audit where action='document.exported') as audits, (select count(*)::integer from e09_editorial._events where type='editorial.exported') as events`);
    assert.deepEqual(await effects(), [{ exports: 1, audits: 1, events: 1 }]);
    armed = false; bad = false; delete ports.authorization;
    assert.deepEqual((await e.exportDocument(ctx(), d.id, 1, options)).manifest, original);
    assert.equal(puts, 1); assert.deepEqual(await effects(), [{ exports: 1, audits: 1, events: 1 }]);
  }));
}

for (const mode of ['remove', 'error'] as const) test(`final fact check retains captured method and sanitizes ${mode}`, needsPg, () => withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
  await migrate(sql); let bad = false, calls = 0;
  const knowledge = { async getClaimStatus() { assert.equal(this, knowledge); calls++; if (bad && mode === 'error') throw Error('SYNTHETIC_PRIVATE_METADATA'); return { factual: bad ? 'refuted' as const : 'supported' as const, editorial: 'approved' as const, stale: false, blocked: bad }; } };
  const ports: { knowledge?: typeof knowledge; useDecisions: ReturnType<typeof useDecisions> } = { knowledge, useDecisions: useDecisions() };
  const objects: ObjectStore = { async put(key, bytes) { bad = true; if (mode === 'remove') delete ports.knowledge; return { key, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }; }, async get() { throw Error('no reads'); }, async head() { return null; }, async list() { return []; }, async delete() { throw Error('no deletion'); } };
  const e = createEngine({ sql, ports, objects, config: { standalone: { knowledge: true } } });
  const p = await e.create(ctx(), 'editorial_project', { body: project() });
  const d = await e.create(ctx(), 'document', { body: { title: 'Fictional captured metadata', editorialProjectId: p.id, docType: 'article', language: 'en', blocks: [block('f')] } }); calls = 0;
  await assert.rejects(e.exportDocument(ctx(), d.id, 1, { idempotencyKey: `captured-final-${mode}` }), (error: any) => {
    assert.equal(error.code, mode === 'remove' ? 'invalid_basis' : 'unavailable'); assert.ok(!String(error).includes('SYNTHETIC_PRIVATE_METADATA')); return true;
  });
  assert.equal(calls, 2); assert.equal((await e.listExports(ctx(), d.id)).length, 1);
}));

test('metadata port getters fail closed with sanitized errors before SQL', async () => {
  let reads = 0;
  const sql: import('../src/service-kit.ts').Sql = { async query() { reads++; throw Error('unexpected SQL'); }, async tx() { reads++; throw Error('unexpected SQL'); } };
  for (const key of ['knowledge', 'findings']) {
    const ports = Object.defineProperty({}, key, { get() { throw Error('SYNTHETIC_PRIVATE_METADATA'); } });
    await assert.rejects(createEngine({ sql, ports }).exportDocument(ctx(), '00000000-0000-4000-8000-000000000001', 1), (error: any) => {
      assert.equal(error.code, 'unavailable'); assert.ok(!String(error).includes('SYNTHETIC_PRIVATE_METADATA')); return true;
    });
  }
  assert.equal(reads, 0);
});
