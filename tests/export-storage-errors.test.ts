// Actual owning PostgreSQL; in-memory ObjectStore write-then-reject fixture, not filesystem/crash proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { DomainError } from '../src/contracts.ts';
import { withDisposableDatabase } from '../src/service-kit.ts';
import type { ObjectStore } from '../src/service-kit.ts';
import { ADMIN, needsPg, ctx, project, block, viewpoint, useDecisions, SEGMENT_INTERVIEW } from './fixtures.ts';
const entry = process.env.EDITORIAL_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
  : createRequire(resolve(process.env.EDITORIAL_PACKAGE_ROOT, 'package.json')).resolve('@accountability/editorial-story/engine');
const { createEngine, migrate } = await import(pathToFileURL(entry).href) as typeof import('../src/engine/index.ts');
for (const mode of ['lost-ack', 'forged-domain-error', 'put-getter'] as const) {
  test('private export sanitizes storage ' + mode + ' while retaining uncertainty', needsPg, () => withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
    await migrate(sql);
    const marker = 'SYNTHETIC_PRIVATE_EDITORIAL_STORAGE_DIAGNOSTIC';
    const retained = new Map<string, Uint8Array>(); const receivers: boolean[] = []; let getterReads = 0;
    const objects: ObjectStore = {
      async put(key, bytes) {
        receivers.push(this === objects); retained.set(key, new Uint8Array(bytes));
        if (mode === 'forged-domain-error') throw new DomainError('forbidden', marker);
        throw Error(marker);
      },
      async get(key) { const bytes = retained.get(key); if (bytes === undefined) throw Error('No retained bytes'); return new Uint8Array(bytes); },
      async head() { return null; }, async list() { return [...retained.keys()]; },
      async delete() { throw Error('Unknown stored state must be retained'); },
    };
    if (mode === 'put-getter') Object.defineProperty(objects, 'put', { get() { getterReads++; throw Error(marker); } });
    const e = createEngine({ sql, objects, ports: { useDecisions: useDecisions() } });
    const vp = await e.create(ctx(), 'viewpoint', { body: viewpoint({ label: 'Fictional private source' }) });
    const p = await e.create(ctx(), 'editorial_project', { body: project() });
    const d = await e.create(ctx(), 'document', { body: { title: 'Fictional private storage failure', editorialProjectId: p.id,
      docType: 'article', language: 'en', blocks: [block('t', { basis: 'attributed_testimony', attribution: 'Fictional source', sources: [SEGMENT_INTERVIEW], viewpointId: vp.id })] } });
    await assert.rejects(e.exportDocument(ctx(), d.id, 1, { audience: 'private-review', idempotencyKey: 'fixed-storage-' + mode }),
      (error: any) => error?.code === 'storage_unknown' && error.message === 'Private export storage outcome is unknown' && !String(error).includes(marker));
    if (mode === 'put-getter') { assert.equal(getterReads, 1); assert.equal(retained.size, 0); assert.deepEqual(receivers, []); }
    else {
      assert.deepEqual(receivers, [true]); assert.equal(retained.size, 1);
      const [key, bytes] = [...retained.entries()][0]!;
      assert.match(key, /\/exports\//); assert.ok(bytes.byteLength > 0);
      assert.deepEqual(await objects.get(key), bytes);
    }
    assert.equal((await e.listExports(ctx(), d.id)).length, 0);
    const effects = await sql.query(`select (select count(*)::integer from e09_editorial.exports) as exports,
      (select count(*)::integer from e09_editorial._audit where action='document.exported') as audits,
      (select count(*)::integer from e09_editorial._events where type='editorial.exported') as events`);
    assert.deepEqual(effects, [{ exports: 0, audits: 0, events: 0 }]);
    assert.equal((await e.history(ctx(), 'document', d.id)).length, 1);
    assert.ok(!JSON.stringify([await e.audit(ctx()), await e.events(ctx())]).includes(marker));
  }));
}
