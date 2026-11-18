// Real pinned E11, separate E09/E11 databases, real standalone E09 child process and signed HTTP. No providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { generateSigningKey, signAccessToken, withDisposableDatabase } from '../src/service-kit.ts';
import { httpUseDecisionPort } from '../src/engine/ports.ts';
import { ALL_CAPS, ctx, project, block } from '../tests/fixtures.ts';

test('standalone Editorial uses real Consent HTTP and denies an old private draft after withdrawal, without fallback or export', async () => {
  const directory = process.env.E11_DIR, admin = process.env.TEST_DATABASE_URL;
  assert.ok(directory && admin, 'Dedicated integration requires E11_DIR and TEST_DATABASE_URL; no silent skip');
  const consent = await import(pathToFileURL(resolve(directory, 'src/engine/index.ts')).href);
  const kit = await import(pathToFileURL(resolve(directory, 'src/service-kit.ts')).href);
  await withDisposableDatabase(pg, admin, async (_consentUrl, sql) => {
    await consent.migrate(sql); const engine = consent.createEngine({ sql });
    const key = generateSigningKey('fixture'), now = Math.floor(Date.now() / 1000);
    const signed = (kind: 'human' | 'service', caps: readonly string[]) => signAccessToken({ iss: 'iap', sub: `fictional-${kind}`, kind,
      tid: 't1', pid: 'p1', purpose: 'editorial', cmp: [], caps, roles: [], pv: '1', iat: now, exp: now + 600, jti: randomUUID() }, key);
    const service = signed('service', ['consent:decide']), staff = signed('human', ['consent:write', 'consent:withdraw']);
    const handler = kit.createHttpHandler({ name: consent.manifest.name, version: consent.manifest.version, routes: consent.routes(engine),
      verify: kit.createTokenVerifier({ publicKeys: { fixture: key.publicKeyPem }, issuer: 'iap' }), health: () => engine.health() });
    let requests = 0;
    const server = createServer((req, res) => { requests++; void handler(req, res); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const consentBase = `http://127.0.0.1:${address.port}`;
    const sendConsent = async (path: string, body: unknown) => {
      const res = await fetch(consentBase + path, { method: 'POST', headers: { authorization: `Bearer ${staff}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json() as Record<string, any>; assert.ok(res.ok, `${res.status}: ${JSON.stringify(json)}`); return json;
    };
    try {
      const port = httpUseDecisionPort({ baseUrl: consentBase, token: service });
      const subject = 'E06:segment:fictional-interview@1';
      assert.equal((await port.decide(ctx(), { subjects: [subject], action: 'adapt', purpose: 'editorial' })).decision, 'review');
      const before = requests; await assert.rejects(port.decide(ctx({ tenantId: 'other' }), { subjects: [subject], action: 'adapt', purpose: 'editorial' }));
      assert.equal(requests, before);
      const holder = await sendConsent('/v1/holders', { ref: 'pseudonym:fictional-participant', kind: 'participant' });
      const permission = await sendConsent('/v1/permissions', { holderId: holder.id, scope: { type: 'subject', value: subject }, actions: ['adapt'],
        purposes: ['editorial'], provenance: { method: 'other', note: 'Fictional participant grant; no real research or contact.' } });
      assert.equal((await port.decide(ctx(), { subjects: [subject], action: 'adapt', purpose: 'editorial' })).decision, 'allow');
      await withDisposableDatabase(pg, admin, async (editorialUrl) => {
        const folder = await mkdtemp(join(tmpdir(), 'editorial-consent-'));
        const file = join(folder, 'service-token'); await writeFile(file, service, { mode: 0o600 });
        const child = spawn(process.execPath, ['src/engine/serve.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env: {
          PATH: process.env.PATH ?? '', DATABASE_URL: editorialUrl, PORT: '0', HOST: '127.0.0.1',
          IDENTITY_PUBLIC_KEYS: JSON.stringify({ fixture: key.publicKeyPem }), IDENTITY_ISSUER: 'iap',
          CONSENT_URL: consentBase, CONSENT_TOKEN_FILE: file, EDITORIAL_STANDALONE: 'consent', OBJECT_STORE_PATH: join(folder, 'objects'),
        } });
        let errors = ''; child.stderr.on('data', chunk => { errors += String(chunk); });
        try {
          const portNumber = await new Promise<number>((ok, fail) => {
            const timer = setTimeout(() => fail(new Error('Editorial startup timeout')), 20000); let text = '';
            child.stdout.on('data', chunk => { text += String(chunk); const found = /"port":(\d+)/.exec(text); if (found) { clearTimeout(timer); ok(Number(found[1])); } });
            child.once('exit', code => { clearTimeout(timer); fail(new Error(`Editorial exited ${code}: ${errors}`)); });
          });
          const auth = signed('human', ALL_CAPS);
          const send = async (method: string, path: string, body?: unknown) => {
            const res = await fetch(`http://127.0.0.1:${portNumber}${path}`, { method, headers: { authorization: `Bearer ${auth}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            return { status: res.status, json: await res.json() as any };
          };
          const made = await send('POST', '/v1/projects', { body: project() }); assert.equal(made.status, 201);
          const draft = await send('POST', '/v1/documents', { body: { title: 'Fictional private draft', editorialProjectId: made.json.id, docType: 'article', language: 'en',
            blocks: [block('t', { basis: 'attributed_testimony', attribution: 'Fictional participant', sources: [subject] })] } });
          assert.equal(draft.status, 201, JSON.stringify(draft.json));
          assert.equal(draft.json.body.blocks[0].verification.useDecision.decision, 'allow');
          // A factual/inference source is not testimony, but its permission withdrawal still applies.
          const claimSubject = 'E07:claim:fictional-sourced-inference@1';
          const claimPermission = await sendConsent('/v1/permissions', { holderId: holder.id, scope: { type: 'subject', value: claimSubject }, actions: ['adapt'],
            purposes: ['editorial'], provenance: { method: 'other', note: 'Fictional declared-source grant; no truth assessment.' } });
          const sourced = await send('POST', '/v1/documents', { body: { title: 'Fictional sourced inference', editorialProjectId: made.json.id, docType: 'article', language: 'en',
            blocks: [block('i', { basis: 'inference', sources: [claimSubject] })] } });
          assert.equal(sourced.status, 201, JSON.stringify(sourced.json));
          const sourcedInput = { revision: 1, idempotencyKey: 'non-testimony-export' };
          const sourcedExport = await send('POST', `/v1/documents/${sourced.json.id}/exports`, sourcedInput); assert.equal(sourcedExport.status, 201);
          assert.deepEqual(sourcedExport.json.manifest.useDecisions[0].subjects, [claimSubject]);
          assert.equal(sourcedExport.json.manifest.useDecisions[0].decision, 'allow');
          await sendConsent(`/v1/permissions/${claimPermission.id}/withdraw`, { reason: 'Fictional non-testimony withdrawal' });
          for (const input of [sourcedInput, { revision: 1 }]) {
            const rejected = await send('POST', `/v1/documents/${sourced.json.id}/exports`, input);
            assert.equal(rejected.status, 403); assert.equal(rejected.json.error.code, 'consent_denied');
          }
          const sourcedHistory = await send('GET', `/v1/documents/${sourced.json.id}/exports`);
          assert.equal(sourcedHistory.json.length, 1); assert.equal(sourcedHistory.json[0].exportId, sourcedExport.json.manifest.exportId);
          assert.equal((await send('GET', `/v1/documents/${sourced.json.id}`)).json.digest, sourced.json.digest);
          const exportInput = { revision: 1, idempotencyKey: 'private-export-before-withdrawal' };
          const originalExport = await send('POST', `/v1/documents/${draft.json.id}/exports`, exportInput); assert.equal(originalExport.status, 201);
          await sendConsent(`/v1/permissions/${permission.id}/withdraw`, { reason: 'Fictional withdrawal fixture' });
          assert.equal((await port.decide(ctx(), { subjects: [subject], action: 'adapt', purpose: 'editorial' })).decision, 'deny');
          const replay = await send('POST', `/v1/documents/${draft.json.id}/exports`, exportInput);
          assert.equal(replay.status, 403, 'historical cached export must not disclose revoked material'); assert.equal(replay.json.error.code, 'consent_denied');
          const denied = await send('POST', `/v1/documents/${draft.json.id}/exports`, { revision: 1 });
          assert.equal(denied.status, 403); assert.equal(denied.json.error.code, 'consent_denied');
          const exports = await send('GET', `/v1/documents/${draft.json.id}/exports`); assert.equal(exports.json.length, 1); assert.equal(exports.json[0].exportId, originalExport.json.manifest.exportId);
          const retained = await send('GET', `/v1/documents/${draft.json.id}`); assert.equal(retained.json.digest, draft.json.digest);
          assert.equal(retained.json.body.blocks[0].text, draft.json.body.blocks[0].text);
          assert.equal((await send('POST', '/v1/documents', { body: { ...draft.json.body, title: 'Must remain denied' } })).status, 403);
        } finally {
          if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
          await rm(folder, { recursive: true, force: true });
        }
      });
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
});
