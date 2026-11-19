// Owning PostgreSQL with synthetic scoped Consent decisions; not live Consent/current-human proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { withDisposableDatabase } from '../src/service-kit.ts';
import type { ObjectStore, AuthorizationPort } from '../src/service-kit.ts';
import { ADMIN, needsPg, ctx, project, block, viewpoint, useDecisions, SEGMENT_INTERVIEW } from './fixtures.ts';
const entry = process.env.EDITORIAL_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
  : createRequire(resolve(process.env.EDITORIAL_PACKAGE_ROOT, 'package.json')).resolve('@accountability/editorial-story/engine');
const { createEngine, migrate } = await import(pathToFileURL(entry).href) as typeof import('../src/engine/index.ts');
for (const at of ['put', 'final-host'] as const) test(`export rechecks originally declared Consent after ${at} and retains historical acknowledgement`, needsPg, () => withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
  await migrate(sql); const policy = useDecisions(); let puts = 0, armed = false, authCalls = 0;
  const ports: { useDecisions: typeof policy; authorization?: AuthorizationPort } = { useDecisions: policy };
  const objects: ObjectStore = { async put(key, bytes) { puts++; if (armed && at === 'put') policy.deny.add(SEGMENT_INTERVIEW); return { key, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }; }, async get() { throw Error('no read'); }, async head() { return null; }, async list() { return []; }, async delete() { throw Error('retain uncertain output'); } };
  const e = createEngine({ sql, ports, objects });
  const vp = await e.create(ctx(), 'viewpoint', { body: viewpoint() });
  const p = await e.create(ctx(), 'editorial_project', { body: project() });
  const d = await e.create(ctx(), 'document', { body: { title: 'Fictional private Consent review', editorialProjectId: p.id, docType: 'article', language: 'en', blocks: [block('t', { basis: 'attributed_testimony', attribution: 'Fictional participant', sources: [SEGMENT_INTERVIEW], viewpointId: vp.id })] } });
  const options = { audience: 'private-review', territory: 'fictional-scope', destination: 'private-workspace', idempotencyKey: `fixed-final-consent-${at}` };
  if (at === 'final-host') {
    await e.exportDocument(ctx(), d.id, 1, options);
    ports.authorization = { async authorize() { if (++authCalls === 2) policy.deny.add(SEGMENT_INTERVIEW); return { allowed: true, reason: 'synthetic', policyVersion: 'fixture' }; } };
  }
  armed = true;
  await assert.rejects(e.exportDocument(ctx(), d.id, 1, options), (error: any) => error?.code === 'consent_denied');
  const original = (await e.listExports(ctx(), d.id))[0]!; assert.equal(puts, 1);
  const effects = () => sql.query(`select (select count(*)::integer from e09_editorial.exports) as exports, (select count(*)::integer from e09_editorial._audit where action='document.exported') as audits, (select count(*)::integer from e09_editorial._events where type='editorial.exported') as events`);
  assert.deepEqual(await effects(), [{ exports: 1, audits: 1, events: 1 }]);
  const latest = policy.calls.at(-1)!;
  assert.equal(latest.action, 'adapt'); assert.deepEqual([...latest.subjects].sort(), [SEGMENT_INTERVIEW, 'E11:participant:part-1', 'E11:permission:perm-1@1'].sort());
  armed = false; delete ports.authorization; policy.deny.clear();
  assert.deepEqual((await e.exportDocument(ctx(), d.id, 1, options)).manifest, original);
  assert.equal(puts, 1); assert.deepEqual(await effects(), [{ exports: 1, audits: 1, events: 1 }]);
}));
