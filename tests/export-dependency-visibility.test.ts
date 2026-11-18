// Current own-engine dependency visibility; synthetic use decisions, not human proofing or complete rights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { withDisposableDatabase } from '../src/service-kit.ts';
import { ADMIN, needsPg, ctx, project, block, viewpoint, useDecisions, SEGMENT_INTERVIEW } from './fixtures.ts';
const entry = process.env.EDITORIAL_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
  : createRequire(resolve(process.env.EDITORIAL_PACKAGE_ROOT, 'package.json')).resolve('@accountability/editorial-story/engine');
const { createEngine, migrate } = await import(pathToFileURL(entry).href) as typeof import('../src/engine/index.ts');
const missing = (error: unknown): boolean => {
  assert.ok(error && typeof error === 'object' && 'code' in error); assert.equal(error.code, 'not_found'); return true;
};
for (const target of ['editorial_project', 'collaborator', 'viewpoint'] as const) {
  test(`export requires current visibility of its ${target}, including identical cached disclosure`, needsPg, () => withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
    await migrate(sql);
    const e = createEngine({ sql, ports: { useDecisions: useDecisions() } });
    const high = ctx({ compartments: ['restricted'] }), low = ctx();
    const collaborator = await e.create(high, 'collaborator', { body: { name: 'Fictional private contributor', roles: ['writer'], creditLine: 'Private fictional credit' },
      ...(target === 'collaborator' ? { compartment: 'restricted' } : {}) });
    const vp = await e.create(high, 'viewpoint', { body: viewpoint({ label: 'Private fictional viewpoint', attribution: 'Private fictional attribution' }),
      ...(target === 'viewpoint' ? { compartment: 'restricted' } : {}) });
    const p = await e.create(high, 'editorial_project', { body: project({ title: 'Private fictional project label', credits: [{ collaboratorId: collaborator.id, role: 'writer' }] }),
      ...(target === 'editorial_project' ? { compartment: 'restricted' } : {}) });
    const d = await e.create(high, 'document', { body: { title: 'Fictional private draft', editorialProjectId: p.id, docType: 'article', language: 'en',
      blocks: [block('t', { basis: 'attributed_testimony', sources: [SEGMENT_INTERVIEW], attribution: 'Fictional source', viewpointId: vp.id })] } });
    const selected = target === 'editorial_project' ? p.id : target === 'collaborator' ? collaborator.id : vp.id;
    await assert.rejects(e.get(low, target, selected), missing);
    assert.equal((await e.get(low, 'document', d.id)).id, d.id, 'the document itself is visible');
    const options = { idempotencyKey: 'fixed-export-with-internal-dependencies' };
    const original = await e.exportDocument(high, d.id, 1, options);
    assert.equal(original.document.labels.projectTitle, 'Private fictional project label');
    assert.equal(original.document.credits[0]!.name, 'Fictional private contributor');
    assert.equal(original.document.blocks[0]!.viewpoint!.label, 'Private fictional viewpoint');
    for (const input of [options, { idempotencyKey: 'new-denied-export' }]) await assert.rejects(e.exportDocument(low, d.id, 1, input), missing);
    assert.equal((await e.listExports(high, d.id)).length, 1, 'denied disclosure retains the original export');
    const restored = await e.exportDocument(high, d.id, 1, options);
    assert.deepEqual(restored, original, 'authorized identical replay retains original metadata');
    assert.equal((await e.listExports(high, d.id)).length, 1, 'no second export effect');
  }));
}
