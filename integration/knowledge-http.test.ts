// Dedicated CI: real pinned E07, PostgreSQL, signed human/service tokens and native HTTP. No live providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { generateSigningKey, signAccessToken, withDisposableDatabase } from '../src/service-kit.ts';
import { httpKnowledgePort } from '../src/engine/ports.ts';
import { ctx, project, block } from '../tests/fixtures.ts';

test('Editorial reads the real E07 claim route and current assessment tracks without edition or scope substitution', async () => {
  const directory = process.env.E07_DIR, admin = process.env.TEST_DATABASE_URL;
  assert.ok(directory && admin, 'Dedicated integration requires E07_DIR and TEST_DATABASE_URL; no silent skips');
  const knowledge = await import(pathToFileURL(resolve(directory, 'src/engine/index.ts')).href);
  const kit = await import(pathToFileURL(resolve(directory, 'src/service-kit.ts')).href);
  await withDisposableDatabase(pg, admin, async (_url, sql) => {
    await knowledge.migrate(sql);
    const engine = knowledge.createEngine({ sql });
    const key = generateSigningKey('test-key'), now = Math.floor(Date.now() / 1000);
    const signed = (kind: 'human' | 'service', caps: string[]) => signAccessToken({ iss: 'iap', sub: `fictional-${kind}`, kind,
      tid: 't1', pid: 'p1', roles: [], caps, cmp: [], purpose: 'editorial', pv: '1', iat: now, exp: now + 600, jti: randomUUID() }, key);
    const writer = signed('human', ['knowledge:read', 'knowledge:write', 'knowledge:approve']);
    const reader = signed('service', ['knowledge:read']);
    let requests = 0;
    const handler = kit.createHttpHandler({ name: knowledge.manifest.name, version: knowledge.manifest.version,
      routes: knowledge.routes(engine), verify: kit.createTokenVerifier({ publicKeys: { 'test-key': key.publicKeyPem }, issuer: 'iap' }),
      health: () => engine.health() });
    const server = createServer((request, response) => { requests++; void handler(request, response); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const send = async (method: string, path: string, body: unknown) => {
      const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${writer}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = await response.json() as Record<string, any>;
      assert.ok(response.ok, `${response.status} ${JSON.stringify(json)}`); return json;
    };
    try {
      const made = await send('POST', '/v1/claims', { text: 'The fictional maintenance log records an inspection.', claimType: 'observation' });
      const port = httpKnowledgePort({ baseUrl: base, token: reader });
      assert.deepEqual(await port.getClaimStatus(ctx(), made.ref), { factual: 'unassessed', editorial: 'not_reviewed', stale: false, blocked: false });
      await send('POST', `/v1/claims/${made.id}/assessments`, { dimension: 'factual', value: 'supported', documentedRationale: true,
        rationale: 'A fictional human review records a sufficiently detailed documented rationale for this test only.' });
      assert.equal((await port.getClaimStatus(ctx(), made.ref))?.factual, 'supported');
      const before = requests;
      await assert.rejects(port.getClaimStatus(ctx({ tenantId: 'other' }), made.ref));
      assert.equal(requests, before, 'foreign caller scope never uses the service credential');
      assert.equal(await port.getClaimStatus(ctx(), `E07:claim:${randomUUID()}@1`), null);
      await withDisposableDatabase(pg, admin, async (_ownUrl, ownSql) => {
        const entry = process.env.EDITORIAL_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
          : createRequire(resolve(process.env.EDITORIAL_PACKAGE_ROOT, 'package.json')).resolve('@accountability/editorial-story/engine');
        const editorialModule = await import(pathToFileURL(entry).href);
        await editorialModule.migrate(ownSql);
        const editorial = editorialModule.createEngine({ sql: ownSql, ports: { knowledge: port }, config: { standalone: { useDecisions: true } } });
        const p = await editorial.create(ctx(), 'editorial_project', { body: project() });
        const d = await editorial.create(ctx(), 'document', { body: { title: 'Fictional exact-source draft', editorialProjectId: p.id, docType: 'article', language: 'en', blocks: [block('f', { sources: [made.ref] })] } });
        const options = { idempotencyKey: 'real-current-claim' };
        const original = await editorial.exportDocument(ctx(), d.id, 1, options);
        await send('POST', `/v1/claims/${made.id}/assessments`, { dimension: 'factual', value: 'unassessed', documentedRationale: true,
          rationale: 'An explicit fictional reset leaves this controlled claim unassessed until another documented review.' });
        assert.equal((await port.getClaimStatus(ctx(), made.ref))?.factual, 'unassessed');
        for (const input of [options, {}]) await assert.rejects(editorial.exportDocument(ctx(), d.id, 1, input), (e: any) => e.code === 'invalid_basis');
        await send('POST', `/v1/claims/${made.id}/assessments`, { dimension: 'factual', value: 'supported', documentedRationale: true,
          rationale: 'A fictional documented reassessment restores the controlled metadata value for this test only.' });
        assert.equal((await editorial.exportDocument(ctx(), d.id, 1, options)).manifest.exportId, original.manifest.exportId, 'readmission returns the original ACK, not another export');
        const changed = await send('PATCH', `/v1/claims/${made.id}`, { expectedRevision: 1, reason: 'Fictional withdrawal test', state: 'withdrawn' });
        await assert.rejects(port.getClaimStatus(ctx(), made.ref), 'old citations cannot borrow a newer claim assessment');
        assert.equal((await port.getClaimStatus(ctx(), changed.ref))?.blocked, true);
        for (const input of [options, {}]) await assert.rejects(editorial.exportDocument(ctx(), d.id, 1, input), (e: any) => e.code === 'unavailable');
        const history = await editorial.listExports(ctx(), d.id); assert.equal(history.length, 1); assert.equal(history[0].exportId, original.manifest.exportId);
        const retained = await editorial.get(ctx(), 'document', d.id); assert.equal(retained.digest, d.digest); assert.equal(retained.body.blocks[0].basis, 'verified_fact');
      });
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
});
