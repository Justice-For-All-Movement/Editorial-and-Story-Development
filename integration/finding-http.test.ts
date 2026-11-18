// Actual pinned E08 public HTTP and separate migrated E09 database; no providers or publication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { generateSigningKey, signAccessToken, withDisposableDatabase } from '../src/service-kit.ts';
import { createEngine, migrate, httpFindingPort } from '../src/engine/index.ts';
import { ctx, project, block } from '../tests/fixtures.ts';

test('real E08 draft/approval/withdrawal metadata gates owning Editorial authoring without latest substitution', async () => {
  const directory = process.env.E08_DIR, admin = process.env.TEST_DATABASE_URL;
  assert.ok(directory && admin, 'Dedicated integration requires E08_DIR and disposable TEST_DATABASE_URL; never silently skipped');
  const factual = await import(pathToFileURL(resolve(directory, 'src/engine/index.ts')).href);
  const kit = await import(pathToFileURL(resolve(directory, 'src/service-kit.ts')).href);
  await withDisposableDatabase(pg, admin, async (_url, sql) => {
    await factual.migrate(sql);
    const engine = factual.createEngine({ sql });
    const key = generateSigningKey('fixture'), now = Math.floor(Date.now() / 1000);
    const signed = (id: string, kind: 'human' | 'service', caps: string[]) => signAccessToken({ iss: 'iap', sub: id, kind,
      tid: 't1', pid: 'p1', purpose: 'editorial', cmp: [], roles: [], caps, pv: '1', iat: now, exp: now + 600, jti: randomUUID() }, key);
    const reader = signed('fixture-reader', 'service', ['investigation:read']);
    const author = signed('fixture-author', 'human', ['investigation:read', 'investigation:write']);
    const reviewer = signed('fixture-reviewer', 'human', ['investigation:read', 'investigation:approve']);
    const handler = kit.createHttpHandler({ name: factual.manifest.name, version: factual.manifest.version, routes: factual.routes(engine),
      verify: kit.createTokenVerifier({ publicKeys: { fixture: key.publicKeyPem }, issuer: 'iap' }), health: () => engine.health() });
    let reads = 0;
    const server = createServer((req, res) => { reads++; void handler(req, res); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const send = async (path: string, body: unknown, token = author) => {
      const response = await fetch(baseUrl + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json() as any; assert.ok(response.ok, `${response.status}: ${JSON.stringify(data)}`); return data;
    };
    try {
      const investigation = await send('/v1/investigations', { title: 'Fictional records comparison', originRef: 'E02:case:fiction', scopeStatement: 'Compare invented records for a controlled metadata test.', originalAccount: { summary: 'An invented report, not a factual conclusion.' } });
      const question = await send(`/v1/investigations/${investigation.id}/questions`, { text: 'Do the fictional records agree?', material: false });
      const checklist = Object.fromEntries(['primary_source_checked', 'independence_by_source_family', 'counter_evidence_searched', 'alternative_explanations_addressed', 'subject_response_sought', 'dates_identities_confirmed'].map(k => [k, { status: 'done', note: 'Synthetic fixture assertion; no actual investigative work.' }]));
      const draft = await send(`/v1/investigations/${investigation.id}/findings`, { statement: 'The invented records agree.', label: 'verified_fact', classification: 'established', questionIds: [question.id], supporting: [{ ref: 'E07:claim:fiction@1' }], limitations: ['Only fictional inputs; no real-world truth or source verification.'], confidence: { level: 'possible', basis: 'Synthetic fixture only.' }, checklist });
      const port = httpFindingPort({ baseUrl, token: reader });
      assert.equal((await port.getFindingStatus(ctx(), draft.ref))?.state, 'draft');
      const before = reads; await assert.rejects(port.getFindingStatus(ctx({ tenantId: 'foreign' }), draft.ref)); assert.equal(reads, before);
      assert.equal(await port.getFindingStatus(ctx(), 'E08:finding:missing@1'), null);
      await withDisposableDatabase(pg, admin, async (_editorialUrl, ownSql) => {
        await migrate(ownSql); const editorial = createEngine({ sql: ownSql, ports: { findings: port } });
        const p = await editorial.create(ctx(), 'editorial_project', { body: project() });
        const save = (ref: string) => editorial.create(ctx(), 'document', { body: { title: 'Fictional private draft', editorialProjectId: p.id, docType: 'article', language: 'en', blocks: [block('f', { text: 'An invented statement.', sources: [ref] })] } });
        await assert.rejects(save(draft.ref), (e: any) => e.code === 'invalid_basis');
        await send(`/v1/findings/${draft.id}/submit`, {});
        const approved = await send(`/v1/findings/${draft.id}/review`, { decision: 'approve' }, reviewer);
        assert.equal(approved.state, 'approved'); assert.ok(approved.revision > draft.revision);
        await assert.rejects(port.getFindingStatus(ctx(), draft.ref), 'old citation cannot silently upgrade');
        const saved = await save(approved.ref);
        const ledger = await editorial.factCheck(ctx(), saved.id); assert.equal(ledger.statements[0]?.status, 'supported');
        assert.equal((ledger.statements[0]?.sources[0]?.current as any).ref, approved.ref);
        const withdrawn = await send(`/v1/findings/${draft.id}/withdraw`, { rationale: 'Fictional withdrawal fixture.' });
        assert.equal((await port.getFindingStatus(ctx(), withdrawn.ref))?.state, 'withdrawn');
        await assert.rejects(save(approved.ref), 'no stale-edition substitution after withdrawal');
        await assert.rejects(save(withdrawn.ref), (e: any) => e.code === 'invalid_basis');
        await assert.rejects(editorial.factCheck(ctx(), saved.id), 'changed edition withholds the whole current report');
        assert.equal((await editorial.get(ctx(), 'document', saved.id)).digest, saved.digest);
        assert.equal((await editorial.get(ctx(), 'document', saved.id)).body.blocks[0]?.text, 'An invented statement.');
      });
      const parts = reader.split('.');
      await assert.rejects(httpFindingPort({ baseUrl, token: `${parts[0]}.${parts[1]}.forged` }).getFindingStatus(ctx(), draft.ref));
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
});
