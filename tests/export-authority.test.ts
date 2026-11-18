// Fictional own-PostgreSQL export boundaries; synthetic host authorization, not E01 authentication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { withDisposableDatabase } from '../src/service-kit.ts';
import type { AuthorizationPort, ObjectStore, Sql } from '../src/service-kit.ts';
import type { EditorialDeps, EditorialEngine } from '../src/engine/index.ts';
import { ADMIN, needsPg, ctx, project, block } from './fixtures.ts';
const entry = process.env.EDITORIAL_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
  : createRequire(resolve(process.env.EDITORIAL_PACKAGE_ROOT, 'package.json')).resolve('@accountability/editorial-story/engine');
const { createEngine, migrate } = await import(pathToFileURL(entry).href) as typeof import('../src/engine/index.ts');
const denied = (e: unknown): boolean => {
  assert.ok(e && typeof e === 'object' && 'code' in e && 'message' in e);
  assert.equal(e.code, 'forbidden'); assert.equal(e.message, 'Export is not authorized'); return true;
};
const db = (fn: (sql: Sql) => Promise<void>) => withDisposableDatabase(pg, ADMIN, async (_u, sql) => { await migrate(sql); await fn(sql); });
async function draft(e: EditorialEngine): Promise<string> {
  const p = await e.create(ctx(), 'editorial_project', { body: project() });
  return (await e.create(ctx(), 'document', { body: { title: 'Private fictional draft', editorialProjectId: p.id, docType: 'article', language: 'en',
    blocks: [block('u', { basis: 'unknown_acknowledged', sources: [], text: 'The fictional question remains open.' })] } })).id;
}
const count = async (sql: Sql, table: string) => Number((await sql.query<{n: string}>(`select count(*)::text as n from e09_editorial.${table}`))[0]!.n);

test('export rejects nonliteral and throwing authorizers before any SQL', async () => {
  let reads = 0;
  const sql: Sql = { async query() { reads++; throw Error('unexpected SQL'); }, async tx() { reads++; throw Error('unexpected SQL'); } };
  for (const value of ['yes', 1, {}, null, undefined, false]) {
    const e = createEngine({ sql, ports: { authorization: { async authorize() { return { allowed: value }; } } as unknown as AuthorizationPort } });
    await assert.rejects(e.exportDocument(ctx(), '00000000-0000-4000-8000-000000000001', 1), denied);
  }
  for (const location of ['port', 'method', 'decision', 'callback']) {
    const ports: { authorization?: AuthorizationPort } = {};
    const port = { async authorize() { if (location === 'callback') throw Error('private-host-secret'); return Object.defineProperty({}, 'allowed', { get() { throw Error('private-host-secret'); } }); } } as unknown as AuthorizationPort;
    if (location === 'port') Object.defineProperty(ports, 'authorization', { get() { throw Error('private-host-secret'); } });
    else { ports.authorization = port; if (location === 'method') Object.defineProperty(port, 'authorize', { get() { throw Error('private-host-secret'); } }); }
    await assert.rejects(createEngine({ sql, ports }).exportDocument(ctx(), '00000000-0000-4000-8000-000000000001', 1), denied);
  }
  assert.equal(reads, 0);
});

test('post-store revocation with port removal withholds content but retains one committed export and identical replay', needsPg, () => db(async sql => {
  let allowed = true, calls = 0, puts = 0;
  const stored = new Map<string, Uint8Array>();
  const ports: { authorization?: AuthorizationPort } = {};
  const authority: AuthorizationPort = { async authorize(c, request) {
    assert.equal(this, authority); assert.ok(Object.isFrozen(c)); assert.equal(request.capability, 'editorial:export'); calls++;
    return { allowed, reason: 'synthetic fixture', policyVersion: '1' };
  } };
  const objects: ObjectStore = { async put(key, bytes) {
    puts++; stored.set(key, new Uint8Array(bytes)); allowed = false; delete ports.authorization;
    return { key, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }, async get() { throw Error('no reads'); }, async head() { return null; }, async list() { return [...stored.keys()]; }, async delete() { throw Error('retained output must not be deleted'); } };
  const e = createEngine({ sql, ports, objects }); const id = await draft(e); ports.authorization = authority;
  const options = { idempotencyKey: 'fixed-original-export' };
  await assert.rejects(e.exportDocument(ctx(), id, 1, options), denied);
  assert.equal(calls, 2); assert.equal(puts, 1); assert.equal(stored.size, 1);
  const history = await e.listExports(ctx(), id); assert.equal(history.length, 1);
  const audit = await count(sql, '_audit'), outbox = await count(sql, '_events');
  ports.authorization = authority;
  await assert.rejects(e.exportDocument(ctx(), id, 1, options), denied); assert.equal(puts, 1);
  allowed = true;
  const ack = await e.exportDocument(ctx(), id, 1, options);
  assert.equal(ack.manifest.exportId, history[0]!.exportId); assert.equal(puts, 1);
  assert.equal(await count(sql, '_audit'), audit); assert.equal(await count(sql, '_events'), outbox);
  assert.equal((await e.listExports(ctx(), id)).length, 1);
}));

test('post-COMMIT authorization runs even without object storage and preserves original replay effects', needsPg, () => db(async sql => {
  let afterCommit = false, armed = false, allowed = true, calls = 0;
  const wrapped: Sql = { query: sql.query.bind(sql), async tx(fn) { const result = await sql.tx(fn); if (armed) { afterCommit = true; allowed = false; } return result; } };
  const ports: { authorization?: AuthorizationPort } = {};
  const e = createEngine({ sql: wrapped, ports }); const id = await draft(e);
  ports.authorization = { async authorize() { calls++; if (calls % 2 === 0) assert.equal(afterCommit, true); return { allowed, reason: '', policyVersion: '1' }; } };
  armed = true;
  await assert.rejects(e.exportDocument(ctx(), id, 1, { idempotencyKey: 'post-commit' }), denied);
  assert.equal(calls, 2); assert.equal((await e.listExports(ctx(), id)).length, 1);
  armed = false; allowed = true;
  assert.equal((await e.exportDocument(ctx(), id, 1, { idempotencyKey: 'post-commit' })).manifest.objectKey, null);
  assert.equal(calls, 4); assert.equal((await e.listExports(ctx(), id)).length, 1);
}));

test('final callback errors are sanitized after commit and initial optional absence remains explicit', needsPg, () => db(async sql => {
  const ports: { authorization?: AuthorizationPort } = {}; const e = createEngine({ sql, ports }); const id = await draft(e);
  let calls = 0;
  ports.authorization = { async authorize() { if (++calls === 2) throw Error('private-host-secret'); return { allowed: true, reason: '', policyVersion: '1' }; } };
  await assert.rejects(e.exportDocument(ctx(), id, 1, { idempotencyKey: 'unknown-final' }), denied);
  assert.equal((await e.listExports(ctx(), id)).length, 1);
  delete ports.authorization;
  const ack = await e.exportDocument(ctx(), id, 1, { idempotencyKey: 'unknown-final' });
  assert.equal(ack.manifest.exportId, (await e.listExports(ctx(), id))[0]!.exportId);
  assert.equal((await e.listExports(ctx(), id)).length, 1);
}));
