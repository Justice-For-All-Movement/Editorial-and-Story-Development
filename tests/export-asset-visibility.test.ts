// Real owning PostgreSQL. Post-storage compartment updates are controlled SQL fixtures, not an administrative API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { withDisposableDatabase } from '../src/service-kit.ts';
import type { ObjectStore, ServiceContext, UseDecisionPort } from '../src/service-kit.ts';
import { ADMIN, needsPg, ctx, editor, project, block, useDecisions } from './fixtures.ts';
const entry = process.env.EDITORIAL_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
  : createRequire(resolve(process.env.EDITORIAL_PACKAGE_ROOT, 'package.json')).resolve('@accountability/editorial-story/engine');
const { createEngine, migrate } = await import(pathToFileURL(entry).href) as typeof import('../src/engine/index.ts');
for (const exact of [false, true]) for (const at of ['before-new', 'before-cached', 'put', 'final-consent'] as const) {
  test('export requires direct registered asset visibility ' + at + ' exact=' + exact, needsPg, () => withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
    await migrate(sql);
    const policy = useDecisions(), retained = new Map<string, Uint8Array>();
    const rights = 'E11:permission:fictional-panel@1';
    let target = '', armed = false, exportCalls = 0, puts = 0;
    const hide = async () => { await sql.query('update e09_editorial.objects set compartment=$4 where tenant_id=$1 and project_id=$2 and id=$3', ['t1', 'p1', target, 'sealed']); };
    const ports = { useDecisions: { async decide(c: ServiceContext, request: Parameters<UseDecisionPort['decide']>[1]) {
      if (armed && request.subjects.includes(rights) && ++exportCalls === 2 && at === 'final-consent') { armed = false; await hide(); }
      return policy.decide(c, request);
    } } };
    const objects: ObjectStore = {
      async put(key, bytes) {
        puts++; retained.set(key, new Uint8Array(bytes));
        if (armed && at === 'put') { armed = false; await hide(); }
        return { key, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
      },
      async get(key) { const bytes = retained.get(key); if (bytes === undefined) throw Error('No retained bytes'); return new Uint8Array(bytes); },
      async head() { return null; }, async list() { return [...retained.keys()]; },
      async delete() { throw Error('Retain committed private export bytes'); },
    };
    const e = createEngine({ sql, objects, ports });
    const initiallyHidden = at === 'before-new' || at === 'before-cached';
    const high = ctx({ compartments: ['sealed'] });
    const asset = await e.create(high, 'asset', { body: { title: 'Fictional panel', targetRef: 'E10:asset:fictional-panel@1',
      mediaKind: 'image', provenance: 'original_production', rightsRef: rights }, ...(initiallyHidden ? { compartment: 'sealed' } : {}) });
    target = asset.id;
    await e.requestReview(high, 'asset', asset.id, { expectedRevision: 1 });
    await e.approve(editor({ compartments: ['sealed'] }), 'asset', asset.id, { revision: 1 });
    const p = await e.create(ctx(), 'editorial_project', { body: project() });
    const d = await e.create(high, 'document', { body: { title: 'Fictional private storyboard', editorialProjectId: p.id,
      docType: 'storyboard', language: 'en', blocks: [block('s', { type: 'scene', basis: 'invention', sources: [],
        disclosure: 'Fictional staged panel.', data: { purpose: 'Opening', panels: [{ id: 'p', description: 'Fictional panel',
          assetRefs: [exact ? asset.ref : 'E09:asset:' + asset.id] }] } })] } });
    const options = { audience: 'private-review', idempotencyKey: 'fixed-asset-visibility-' + at + '-' + exact };
    const cached = at === 'before-cached' || at === 'final-consent';
    const original = cached ? await e.exportDocument(high, d.id, 1, options) : undefined;
    armed = at === 'put' || at === 'final-consent'; exportCalls = 0;
    const callsBefore = policy.calls.length;
    await assert.rejects(e.exportDocument(ctx(), d.id, 1, options), (error: any) => error?.code === 'not_found');
    if (initiallyHidden) assert.equal(policy.calls.length, callsBefore, 'asset denial must precede export source/Consent callbacks');
    const expected = at === 'before-new' ? 0 : 1;
    assert.equal(puts, expected); assert.equal(retained.size, expected);
    assert.equal((await e.listExports(ctx(), d.id)).length, expected);
    assert.deepEqual(await sql.query(`select (select count(*)::integer from e09_editorial.exports) as exports,
      (select count(*)::integer from e09_editorial._audit where action='document.exported') as audits,
      (select count(*)::integer from e09_editorial._events where type='editorial.exported') as events`),
      [{ exports: expected, audits: expected, events: expected }]);
    assert.equal((await e.history(ctx(), 'document', d.id)).length, 1);
    armed = false;
    const ack = await e.exportDocument(high, d.id, 1, options);
    if (original !== undefined) assert.deepEqual(ack, original);
    assert.equal(puts, 1); assert.equal((await e.listExports(high, d.id)).length, 1);
    assert.equal((await e.history(high, 'asset', asset.id)).length, 1);
  }));
}

test('exact missing registered asset edition is never substituted with the visible latest edition', needsPg, () => withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
  await migrate(sql); const policy = useDecisions(); const e = createEngine({ sql, ports: { useDecisions: policy } });
  const asset = await e.create(ctx(), 'asset', { body: { title: 'Fictional exact panel', targetRef: 'E10:asset:fictional-exact@1',
    mediaKind: 'image', provenance: 'original_production', rightsRef: 'E11:permission:fictional-exact@1' } });
  await e.requestReview(ctx(), 'asset', asset.id, { expectedRevision: 1 }); await e.approve(editor(), 'asset', asset.id, { revision: 1 });
  const p = await e.create(ctx(), 'editorial_project', { body: project() });
  const d = await e.create(ctx(), 'document', { body: { title: 'Fictional missing edition', editorialProjectId: p.id, docType: 'storyboard',
    language: 'en', blocks: [block('s', { type: 'scene', basis: 'invention', sources: [], disclosure: 'Fictional staged panel.',
      data: { purpose: 'Opening', panels: [{ id: 'p', description: 'Fictional panel', assetRefs: ['E09:asset:' + asset.id + '@999'] }] } })] } });
  const before = policy.calls.length;
  await assert.rejects(e.exportDocument(ctx(), d.id, 1), (error: any) => error?.code === 'not_found');
  assert.equal(policy.calls.length, before);
  assert.equal((await e.get(ctx(), 'asset', asset.id)).revision, 1, 'latest is visible but is not the selected edition');
  assert.equal((await e.listExports(ctx(), d.id)).length, 0);
  assert.equal((await e.history(ctx(), 'document', d.id)).length, 1);
}));
