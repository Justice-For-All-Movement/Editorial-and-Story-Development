// Post-storage disclosure regressions. SQL changes below are test fixtures, not an admin API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withDisposableDatabase } from '../src/service-kit.ts';
import type { ObjectStore } from '../src/service-kit.ts';
const entry = process.env.EDITORIAL_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
  : createRequire(resolve(process.env.EDITORIAL_PACKAGE_ROOT, 'package.json')).resolve('@accountability/editorial-story/engine');
const { createEngine, migrate } = await import(pathToFileURL(entry).href) as typeof import('../src/engine/index.ts');
import { ADMIN, needsPg, ctx, project, block, viewpoint, useDecisions, SEGMENT_INTERVIEW } from './fixtures.ts';
const missing = (error: unknown): boolean => {
  assert.ok(error && typeof error === 'object' && 'code' in error); assert.equal(error.code, 'not_found'); return true;
};
for (const kind of ['document', 'editorial_project', 'collaborator', 'viewpoint'] as const) {
  test(`export withholds after ${kind} visibility changes during object put, retaining committed history`, needsPg, () => withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
    await migrate(sql); let target = '', puts = 0;
    const bytesByKey = new Map<string, Uint8Array>();
    const objects: ObjectStore = {
      async put(key, bytes) {
        puts++; bytesByKey.set(key, new Uint8Array(bytes));
        await sql.query('update e09_editorial.objects set compartment=$4 where tenant_id=$1 and project_id=$2 and id=$3', ['t1', 'p1', target, 'restricted']);
        return { key, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      }, async get() { throw Error('no retrieval needed'); }, async head() { return null; },
      async list() { return [...bytesByKey.keys()]; }, async delete() { throw Error('retained history must not be deleted'); },
    };
    const e = createEngine({ sql, objects, ports: { useDecisions: useDecisions() } });
    const col = await e.create(ctx(), 'collaborator', { body: { name: 'Fictional contributor', roles: ['writer'], creditLine: 'Fictional credit' } });
    const vp = await e.create(ctx(), 'viewpoint', { body: viewpoint({ label: 'Fictional viewpoint' }) });
    const p = await e.create(ctx(), 'editorial_project', { body: project({ credits: [{ collaboratorId: col.id, role: 'writer' }] }) });
    const d = await e.create(ctx(), 'document', { body: { title: 'Fictional private draft', editorialProjectId: p.id, docType: 'article', language: 'en',
      blocks: [block('t', { basis: 'attributed_testimony', attribution: 'Fictional source', sources: [SEGMENT_INTERVIEW], viewpointId: vp.id })] } });
    target = kind === 'document' ? d.id : kind === 'editorial_project' ? p.id : kind === 'collaborator' ? col.id : vp.id;
    const options = { idempotencyKey: 'fixed-final-visibility' };
    await assert.rejects(e.exportDocument(ctx(), d.id, 1, options), missing);
    await assert.rejects(e.get(ctx(), kind, target), missing);
    assert.equal(puts, 1); assert.equal(bytesByKey.size, 1);
    const high = ctx({ compartments: ['restricted'] });
    const history = await e.listExports(high, d.id); assert.equal(history.length, 1);
    const original = await e.exportDocument(high, d.id, 1, options);
    assert.equal(original.manifest.exportId, history[0]!.exportId);
    assert.equal(puts, 1); assert.equal((await e.listExports(high, d.id)).length, 1);
  }));
}

test('cached export retains removed historical contributor visibility obligations', needsPg, () => withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
  await migrate(sql); const e = createEngine({ sql });
  const col = await e.create(ctx(), 'collaborator', { body: { name: 'Original fictional contributor', roles: ['writer'] } });
  const p = await e.create(ctx(), 'editorial_project', { body: project({ credits: [{ collaboratorId: col.id, role: 'writer' }] }) });
  const d = await e.create(ctx(), 'document', { body: { title: 'Private draft', editorialProjectId: p.id, docType: 'article', language: 'en',
    blocks: [block('u', { basis: 'unknown_acknowledged', sources: [] })] } });
  const options = { idempotencyKey: 'original-historical-credit' };
  const original = await e.exportDocument(ctx(), d.id, 1, options);
  await e.revise(ctx(), 'editorial_project', p.id, { expectedRevision: 1, body: { ...p.body, credits: [] } });
  await sql.query('update e09_editorial.objects set compartment=$4 where tenant_id=$1 and project_id=$2 and id=$3', ['t1', 'p1', col.id, 'restricted']);
  await assert.rejects(e.exportDocument(ctx(), d.id, 1, options), missing);
  const high = ctx({ compartments: ['restricted'] });
  assert.deepEqual(await e.exportDocument(high, d.id, 1, options), original);
  assert.equal((await e.listExports(high, d.id)).length, 1);
}));

test('cached response final snapshot follows the final host callback', needsPg, () => withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
  await migrate(sql);
  const ports: { authorization?: import('../src/service-kit.ts').AuthorizationPort } = {};
  const e = createEngine({ sql, ports });
  const p = await e.create(ctx(), 'editorial_project', { body: project() });
  const d = await e.create(ctx(), 'document', { body: { title: 'Private draft', editorialProjectId: p.id, docType: 'article', language: 'en',
    blocks: [block('u', { basis: 'unknown_acknowledged', sources: [] })] } });
  const options = { idempotencyKey: 'after-host-callback' };
  const original = await e.exportDocument(ctx(), d.id, 1, options); let calls = 0;
  ports.authorization = { async authorize() {
    if (++calls === 2) await sql.query('update e09_editorial.objects set compartment=$4 where tenant_id=$1 and project_id=$2 and id=$3', ['t1', 'p1', p.id, 'restricted']);
    return { allowed: true, reason: 'fixture', policyVersion: '1' };
  } };
  await assert.rejects(e.exportDocument(ctx(), d.id, 1, options), missing);
  assert.equal(calls, 2); delete ports.authorization;
  const high = ctx({ compartments: ['restricted'] });
  assert.deepEqual(await e.exportDocument(high, d.id, 1, options), original);
  assert.equal((await e.listExports(high, d.id)).length, 1);
}));

test('lost final read COMMIT acknowledgement withholds without undoing original export', needsPg, () => withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
  await migrate(sql); let armed = false, commits = 0;
  const wrapped: import('../src/service-kit.ts').Sql = { query: sql.query.bind(sql), async tx(fn) {
    const result = await sql.tx(fn);
    if (armed && ++commits === 2) throw Error('fixture lost final read COMMIT acknowledgement');
    return result;
  } };
  const e = createEngine({ sql: wrapped });
  const p = await e.create(ctx(), 'editorial_project', { body: project() });
  const d = await e.create(ctx(), 'document', { body: { title: 'Private draft', editorialProjectId: p.id, docType: 'article', language: 'en',
    blocks: [block('u', { basis: 'unknown_acknowledged', sources: [] })] } });
  armed = true; const options = { idempotencyKey: 'lost-read-ack' };
  await assert.rejects(e.exportDocument(ctx(), d.id, 1, options), /fixture lost final read COMMIT acknowledgement/);
  const history = await e.listExports(ctx(), d.id); assert.equal(history.length, 1);
  const ack = await e.exportDocument(ctx(), d.id, 1, options);
  assert.equal(ack.manifest.exportId, history[0]!.exportId);
  assert.equal((await e.listExports(ctx(), d.id)).length, 1);
}));
