// Actual owning-PG event handling and export storage; synthetic policy is not original-human or live E11 proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { withDisposableDatabase } from '../src/service-kit.ts';
import type { ObjectStore, Sql, AuthorizationPort } from '../src/service-kit.ts';
import type { EditorialEngine } from '../src/engine/index.ts';
import { ADMIN, needsPg, ctx, editor, project, block, useDecisions, SEGMENT_INTERVIEW } from './fixtures.ts';
const entry = process.env.EDITORIAL_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
  : createRequire(resolve(process.env.EDITORIAL_PACKAGE_ROOT, 'package.json')).resolve('@accountability/editorial-story/engine');
const { createEngine, migrate } = await import(pathToFileURL(entry).href) as typeof import('../src/engine/index.ts');
const db = (fn: (sql: Sql) => Promise<void>) => withDisposableDatabase(pg, ADMIN, async (_u, sql) => { await migrate(sql); await fn(sql); });
const code = (expected: string) => (e: unknown) => { assert.ok(e && typeof e === 'object' && 'code' in e); assert.equal(e.code, expected); return true; };
async function draft(e: EditorialEngine) {
  const p = await e.create(ctx(), 'editorial_project', { body: project() });
  return e.create(ctx(), 'document', { body: { title: 'Fictional private final admission', editorialProjectId: p.id, docType: 'article', language: 'en',
    blocks: [block('t', { basis: 'attributed_testimony', attribution: 'Fictional participant', sources: [SEGMENT_INTERVIEW] })] } });
}
function storage(afterPut: () => Promise<void>) {
  const retained = new Map<string, Uint8Array>(); let puts = 0;
  const objects: ObjectStore = { async put(key, bytes) { puts++; retained.set(key, new Uint8Array(bytes)); await afterPut();
    return { key, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  }, async get() { throw Error('no reads'); }, async head() { return null; }, async list() { return [...retained.keys()]; }, async delete() { throw Error('retained history must not be deleted'); } };
  return { objects, retained, puts: () => puts };
}
const effects = async (sql: Sql) => (await sql.query(`select
  (select count(*)::integer from e09_editorial.exports) as exports,
  (select count(*)::integer from e09_editorial._audit where action='document.exported') as audits,
  (select count(*)::integer from e09_editorial._events where type='editorial.exported') as events`))[0];

test('withdrawal recorded during object put withholds committed export and cached disclosure', needsPg, () => db(async sql => {
  let e: EditorialEngine;
  const s = storage(async () => { await e.applyUpstreamChange(ctx(), { eventId: 'fictional-withdraw-during-put', kind: 'permission_withdrawn', refs: [SEGMENT_INTERVIEW], reason: 'Fictional withdrawal' }); });
  e = createEngine({ sql, objects: s.objects, ports: { useDecisions: useDecisions() } }); const d = await draft(e);
  const options = { idempotencyKey: 'fixed-withdraw-during-put' };
  await assert.rejects(e.exportDocument(ctx(), d.id, 1, options), code('consent_denied'));
  assert.equal(s.puts(), 1); assert.equal(s.retained.size, 1); assert.equal((await e.listExports(ctx(), d.id)).length, 1);
  assert.deepEqual(await effects(sql), { exports: 1, audits: 1, events: 1 });
  await assert.rejects(e.exportDocument(ctx(), d.id, 1, options), code('consent_denied'));
  assert.deepEqual(await effects(sql), { exports: 1, audits: 1, events: 1 }); assert.equal(s.puts(), 1);
}));
test('required approval invalidated during storage withholds but renewal permits original historical ACK', needsPg, () => db(async sql => {
  let e: EditorialEngine;
  const s = storage(async () => { await e.applyUpstreamChange(ctx(), { eventId: 'fictional-correction-during-put', kind: 'source_corrected', refs: [SEGMENT_INTERVIEW], reason: 'Fictional correction requires review' }); });
  e = createEngine({ sql, objects: s.objects, ports: { useDecisions: useDecisions() } }); const d = await draft(e);
  await e.requestReview(ctx(), 'document', d.id, { expectedRevision: 1 });
  const approved = await e.approve(editor(), 'document', d.id, { revision: 1 });
  const options = { requireApproved: true, idempotencyKey: 'fixed-approved-during-put' };
  await assert.rejects(e.exportDocument(ctx(), d.id, 1, options), code('approval_invalid'));
  assert.equal((await e.listApprovals(ctx(), 'document', d.id))[0]!.status, 'needs_renewal');
  const original = (await e.listExports(ctx(), d.id))[0]!; assert.equal(original.approval!.id, approved.id);
  assert.deepEqual(await effects(sql), { exports: 1, audits: 1, events: 1 });
  for (const flag of await e.listFlags(ctx(), { objectId: d.id, status: 'open' })) await e.resolveFlag(editor(), flag.id, { resolution: 'reviewed_still_accurate', note: 'Fictional reviewed correction; no assertion of source truth' });
  const renewed = await e.approve(editor(), 'document', d.id, { revision: 1 }); assert.notEqual(renewed.id, approved.id);
  const ack = await e.exportDocument(ctx(), d.id, 1, options); assert.deepEqual(ack.manifest, original);
  assert.equal(ack.manifest.approval!.id, approved.id, 'original manifest remains historical');
  assert.equal(s.puts(), 1); assert.deepEqual(await effects(sql), { exports: 1, audits: 1, events: 1 });
}));
for (const kind of ['permission_withdrawn', 'source_corrected'] as const) test(`cached export final snapshot rechecks ${kind} after final host callback`, needsPg, () => db(async sql => {
    const ports: { useDecisions: ReturnType<typeof useDecisions>; authorization?: AuthorizationPort } = { useDecisions: useDecisions() };
    const e = createEngine({ sql, ports }); const d = await draft(e);
    await e.requestReview(ctx(), 'document', d.id, { expectedRevision: 1 }); await e.approve(editor(), 'document', d.id, { revision: 1 });
    const options = { requireApproved: true, idempotencyKey: `cached-final-${kind}` };
    await e.exportDocument(ctx(), d.id, 1, options); let calls = 0;
    ports.authorization = { async authorize() { if (++calls === 2) await e.applyUpstreamChange(ctx(), { eventId: `final-callback-${kind}`, kind, refs: [SEGMENT_INTERVIEW], reason: 'Fictional current event' }); return { allowed: true, reason: 'synthetic', policyVersion: 'fixture' }; } };
    await assert.rejects(e.exportDocument(ctx(), d.id, 1, options), code(kind === 'permission_withdrawn' ? 'consent_denied' : 'approval_invalid'));
    assert.equal(calls, 2); assert.equal((await e.listExports(ctx(), d.id)).length, 1);
}));

test('lifting a recorded withdrawal cannot bypass retained blocked flags at final admission', needsPg, () => db(async sql => {
  let e: EditorialEngine;
  const s = storage(async () => {
    await e.applyUpstreamChange(ctx(), { eventId: 'fictional-block-during-put', kind: 'permission_withdrawn', refs: [SEGMENT_INTERVIEW], reason: 'Fictional withdrawal' });
    await e.applyUpstreamChange(ctx(), { eventId: 'fictional-permission-changed', kind: 'permission_changed', refs: [SEGMENT_INTERVIEW], reason: 'Fictional new decision; old blocked flags remain' });
  });
  e = createEngine({ sql, objects: s.objects, ports: { useDecisions: useDecisions() } }); const d = await draft(e);
  await assert.rejects(e.exportDocument(ctx(), d.id, 1, { idempotencyKey: 'fixed-block-during-put' }), code('consent_denied'));
  assert.equal((await sql.query('select * from e09_editorial.withdrawn_refs')).length, 0);
  assert.ok((await e.listFlags(ctx(), { objectId: d.id, status: 'open' })).some(f => f.kind === 'blocked'));
  assert.equal(s.puts(), 1); assert.deepEqual(await effects(sql), { exports: 1, audits: 1, events: 1 });
}));
test('unapproved private export preserves stale-review semantics when approval was not required', needsPg, () => db(async sql => {
  let e: EditorialEngine;
  const s = storage(async () => { await e.applyUpstreamChange(ctx(), { eventId: 'fictional-stale-private', kind: 'source_corrected', refs: [SEGMENT_INTERVIEW], reason: 'Fictional review required' }); });
  e = createEngine({ sql, objects: s.objects, ports: { useDecisions: useDecisions() } }); const d = await draft(e);
  const ack = await e.exportDocument(ctx(), d.id, 1, { idempotencyKey: 'private-no-approval' });
  assert.equal(ack.manifest.approval, null); assert.equal(s.puts(), 1);
  assert.ok((await e.listFlags(ctx(), { objectId: d.id, status: 'open' })).some(f => f.kind === 'stale'));
  assert.deepEqual(await effects(sql), { exports: 1, audits: 1, events: 1 });
}));
