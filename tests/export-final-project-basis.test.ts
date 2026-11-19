// Actual owning PostgreSQL; synthetic Consent, no live human/rights or distributed-fence claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { withDisposableDatabase } from '../src/service-kit.ts';
import type { ObjectStore, ServiceContext, UseDecisionPort } from '../src/service-kit.ts';
import { ADMIN, needsPg, ctx, project, block, viewpoint, useDecisions, SEGMENT_INTERVIEW } from './fixtures.ts';
const entry = process.env.EDITORIAL_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
  : createRequire(resolve(process.env.EDITORIAL_PACKAGE_ROOT, 'package.json')).resolve('@accountability/editorial-story/engine');
const { createEngine, migrate } = await import(pathToFileURL(entry).href) as typeof import('../src/engine/index.ts');
for (const at of ['put', 'final-consent'] as const) for (const change of ['project', 'collaborator'] as const) {
  test(`export withholds changed project/credit basis ${change} at ${at}, retaining committed effects`, needsPg, () => withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
    await migrate(sql); const policy = useDecisions(); let armed = false, puts = 0, exportCalls = 0;
    let revise: () => Promise<void> = async () => {};
    const ports = { useDecisions: { async decide(c: ServiceContext, request: Parameters<UseDecisionPort['decide']>[1]) {
      if (armed && request.subjects.includes('E11:permission:perm-1@1') && ++exportCalls === 2 && at === 'final-consent') { armed = false; await revise(); }
      return policy.decide(c, request);
    } } };
    const retained = new Map<string, Uint8Array>();
    const objects: ObjectStore = { async put(key, bytes) {
      puts++; retained.set(key, new Uint8Array(bytes));
      if (armed && at === 'put') { armed = false; await revise(); }
      return { key, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    }, async get() { throw Error('no read'); }, async head() { return null; }, async list() { return [...retained.keys()]; }, async delete() { throw Error('retain uncertain output'); } };
    const e = createEngine({ sql, ports, objects });
    const col = await e.create(ctx(), 'collaborator', { body: { name: 'Fictional contributor', roles: ['writer'], creditLine: 'Fictional private credit' } });
    const vp = await e.create(ctx(), 'viewpoint', { body: viewpoint({ label: 'Fictional private viewpoint' }) });
    const p = await e.create(ctx(), 'editorial_project', { body: project({ credits: [{ collaboratorId: col.id, role: 'writer' }] }) });
    const d = await e.create(ctx(), 'document', { body: { title: 'Fictional selected viewpoint', editorialProjectId: p.id, docType: 'article', language: 'en', blocks: [block('t', { basis: 'attributed_testimony', attribution: 'Fictional source', sources: [SEGMENT_INTERVIEW], viewpointId: vp.id })] } });
    revise = async () => {
      if (change === 'project') await e.revise(ctx(), 'editorial_project', p.id, { expectedRevision: 1, body: { ...p.body, description: 'Fictional changed private brief' } });
      else await e.revise(ctx(), 'collaborator', col.id, { expectedRevision: 1, body: { ...col.body, creditLine: 'Fictional changed credit' } });
    };
    const options = { audience: 'private-review', idempotencyKey: `fixed-viewpoint-${at}-${change}` };
    if (at === 'final-consent') await e.exportDocument(ctx(), d.id, 1, options);
    armed = true; exportCalls = 0;
    await assert.rejects(e.exportDocument(ctx(), d.id, 1, options), (error: any) => error?.code === 'consent_denied');
    const kind = change === 'project' ? 'editorial_project' as const : 'collaborator' as const;
    const changedId = change === 'project' ? p.id : col.id;
    assert.equal((await e.get(ctx(), kind, changedId)).revision, 2);
    assert.equal((await e.history(ctx(), kind, changedId)).length, 2);
    assert.equal(puts, 1); assert.equal(retained.size, 1);
    const history = await e.listExports(ctx(), d.id); assert.equal(history.length, 1);
    const effects = () => sql.query(`select (select count(*)::integer from e09_editorial.exports) as exports, (select count(*)::integer from e09_editorial._audit where action='document.exported') as audits, (select count(*)::integer from e09_editorial._events where type='editorial.exported') as events`);
    assert.deepEqual(await effects(), [{ exports: 1, audits: 1, events: 1 }]);
    // A separate explicit request can authorize the now-current viewpoint plus all saved historical refs.
    armed = false;
    assert.deepEqual((await e.exportDocument(ctx(), d.id, 1, options)).manifest, history[0]);
    assert.equal(puts, 1); assert.deepEqual(await effects(), [{ exports: 1, audits: 1, events: 1 }]);
  }));
}
