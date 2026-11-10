import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { generateSigningKey, signAccessToken, withDisposableDatabase } from '../src/service-kit.ts';
import { ADMIN, ALL_CAPS, CLAIM_CONTRACT, block, investigationPackage, needsPg, project } from './fixtures.ts';

// End to end: the real `serve` entry in a child process, real PostgreSQL, signed tokens, plain fetch.
test('HTTP end to end through the standalone server', needsPg, () => withDisposableDatabase(pg, ADMIN, async (url) => {
  const key = generateSigningKey('k1');
  const child = spawn(process.execPath, ['src/engine/serve.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', DATABASE_URL: url, PORT: '0', HOST: '127.0.0.1', IDENTITY_PUBLIC_KEYS: JSON.stringify({ k1: key.publicKeyPem }), IDENTITY_ISSUER: 'iap', EDITORIAL_STANDALONE: 'knowledge,consent', OBJECT_STORE_PATH: await mkdtemp(join(tmpdir(), 'e09-http-')) } });
  let stderr = ''; child.stderr.on('data', (c) => { stderr += String(c); });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let out = ''; const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 20_000);
      child.stdout.on('data', (c) => { out += String(c); const m = /"port":(\d+)/.exec(out); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const now = Math.floor(Date.now() / 1000);
    const token = (sub: string, caps: string[], tid = 't1') => signAccessToken({ iss: 'iap', sub, kind: 'human', tid, pid: 'p1', roles: [], caps, cmp: [], purpose: 'editorial', pv: '1', iat: now, exp: now + 300, jti: `${sub}-${tid}` }, key);
    const author = token('author-1', ALL_CAPS), reviewer = token('editor-1', ALL_CAPS), reader = token('reader-1', ['editorial:read']), foreign = token('author-9', ALL_CAPS, 't2');
    const call = async (method: string, path: string, body?: unknown, auth: string | null = author, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const r = await fetch(base + path, { method, headers: { ...(auth === null ? {} : { authorization: `Bearer ${auth}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    const health = await call('GET', '/healthz', undefined, null);
    assert.equal(health.status, 200); assert.equal(health.json.detail.standalone.knowledge, true);
    assert.equal((await call('GET', '/v1/manifest', undefined, null)).json.id, 'E09');
    assert.equal((await call('GET', '/v1/documents', undefined, null)).status, 401);
    assert.equal((await call('GET', '/v1/documents', undefined, 'not-a-token')).status, 401);
    assert.equal((await call('POST', '/v1/projects', { body: project() }, reader)).status, 403);

    const p = await call('POST', '/v1/creative/projects', { body: project() }, author, { 'idempotency-key': 'p-1' });
    assert.equal(p.status, 201);
    assert.equal((await call('POST', '/v1/projects', { body: project() }, author, { 'idempotency-key': 'p-1' })).json.id, p.json.id, 'Idempotency-Key header replays');
    const body = (blocks: unknown[]) => ({ title: 'Harbor draft', editorialProjectId: p.json.id, docType: 'article', language: 'en', blocks });
    const rejected = await call('POST', '/v1/documents', { body: body([{ id: 'a', type: 'passage', text: 'No label.' }]) });
    assert.equal(rejected.status, 400); assert.equal(rejected.json.error.code, 'invalid_basis');
    const d = await call('POST', '/v1/documents', { body: body([block('a', { text: 'The council approved the contract.' }), block('b', { basis: 'reconstruction', sources: [CLAIM_CONTRACT], disclosure: 'Reconstructed scene.', text: 'They signed at night.' })]) });
    assert.equal(d.status, 201); assert.equal(d.json.ref, `E09:document:${d.json.id}@1`);
    const id = d.json.id as string;
    const r2 = await call('POST', `/v1/stories/${id}/versions`, { expectedRevision: 1, summary: 'edit', body: body([block('a', { text: 'The council approved the dredging contract.' }), d.json.body.blocks[1]]) });
    assert.equal(r2.status, 201); assert.equal(r2.json.revision, 2);
    const conflict = await call('POST', `/v1/documents/${id}/revisions`, { expectedRevision: 1, body: body([block('a')]) });
    assert.equal(conflict.status, 409); assert.equal(conflict.json.error.code, 'revision_conflict');
    assert.equal((await call('GET', `/v1/documents/${id}?revision=1`)).json.body.blocks[0].text, 'The council approved the contract.');
    assert.deepEqual((await call('GET', `/v1/documents/${id}/diff?from=1&to=2`)).json.blocks.changed.map((c: { id: string }) => c.id), ['a']);
    assert.equal((await call('GET', `/v1/documents/${id}/revisions`)).json.length, 2);
    const scene = await call('POST', '/v1/scenes', { documentId: id, expectedRevision: 2, scene: { id: 's1', text: 'The quay at dawn.', basis: 'reconstruction', sources: [CLAIM_CONTRACT], disclosure: 'Staged.', data: { purpose: 'Establish the place', panels: [{ id: 'p1', description: 'Wide quay', assetRefs: [] }] } } });
    assert.equal(scene.status, 201); assert.equal(scene.json.revision, 3);
    const map = await call('GET', `/v1/stories/${id}/fact-map`);
    assert.deepEqual(map.json.statements.map((s: { blockId: string; status: string }) => [s.blockId, s.status]), [['a', 'not_checked']]);
    // review, approval by a second person, export with manifest
    assert.equal((await call('POST', `/v1/documents/${id}/review`, { expectedRevision: 3 })).json.state, 'in_review');
    assert.equal((await call('POST', `/v1/documents/${id}/approvals`, { revision: 3 })).status, 403);
    const approval = await call('POST', `/v1/documents/${id}/approvals`, { revision: 3 }, reviewer);
    assert.equal(approval.status, 201); assert.equal(approval.json.status, 'active');
    const exp = await call('POST', `/v1/documents/${id}/exports`, { revision: 3, requireApproved: true, formats: ['json', 'markdown'] });
    assert.equal(exp.status, 201); assert.equal(exp.json.manifest.document, `E09:document:${id}@3`); assert.equal(exp.json.manifest.approval.status, 'active');
    assert.match(exp.json.renderings.markdown, /Disclosure \(reconstruction\): Reconstructed scene\./);
    assert.deepEqual(exp.json.manifest.sourceRefs, [CLAIM_CONTRACT]);
    // upstream change → stale + approval needs renewal, visible through inspect; events feed for the router
    const up = await call('POST', '/v1/upstream-changes', { eventId: 'evt-http-1', kind: 'claim_changed', refs: ['E07:claim:c-contract@3'], reason: 'claim corrected' });
    assert.equal(up.status, 200); assert.ok(up.json.affected.includes(`E09:block:${id}.a@3`));
    const insp = await call('GET', `/v1/inspect?ref=${encodeURIComponent(`E09:document:${id}`)}`);
    assert.equal(insp.json.stale, true); assert.equal(insp.json.decisions[0].status, 'needs_renewal'); assert.equal(insp.json.versions.length, 3);
    assert.equal((await call('POST', `/v1/documents/${id}/exports`, { revision: 3, requireApproved: true })).status, 409);
    assert.equal((await call('GET', '/v1/flags?status=open')).json.length, 3);
    let types: string[] = [];
    for (let i = 0; i < 100 && !types.includes('editorial.approval_invalidated'); i++) { types = (await call('GET', '/v1/events?limit=500')).json.map((e: { type: string }) => e.type); if (!types.includes('editorial.approval_invalidated')) await new Promise((r) => setTimeout(r, 100)); }
    for (const t of ['editorial.document_revised', 'editorial.review_requested', 'editorial.approved', 'editorial.exported', 'editorial.block_stale', 'editorial.approval_invalidated']) assert.ok(types.includes(t), t);
    assert.equal((await call('GET', '/v1/events', undefined, token('x', ['editorial:read', 'editorial:write']))).status, 403);
    // generator from a package, lyrics helper, search, audit
    const gen = await call('POST', '/v1/generate', { generator: 'narrative', editorialProjectId: p.json.id, package: investigationPackage() });
    assert.equal(gen.status, 201); assert.equal(gen.json.document.body.docType, 'narrative'); assert.equal(gen.json.omitted.length, 2);
    assert.equal((await call('POST', '/v1/lyrics/analyze', { text: 'The council met at night\nand signed away the light', language: 'en' })).json.rhymeScheme, 'AA');
    assert.deepEqual((await call('POST', '/v1/lyrics/rhymes', { word: 'night', language: 'en', candidates: ['light', 'harbor'] })).json.map((s: { word: string }) => s.word), ['light']);
    assert.ok((await call('GET', '/v1/search?q=dredging')).json.length >= 1);
    assert.ok((await call('GET', `/v1/audit?subject=${encodeURIComponent(`E09:document:${id}`)}`)).json.length >= 5);
    // a missing collaborator is an explicit 503, never a silent fake
    const model = await call('POST', `/v1/documents/${id}/proposals`, { instruction: 'tighten' });
    assert.equal(model.status, 503); assert.equal(model.json.error.code, 'unavailable'); assert.match(model.json.error.message, /ModelPort/);
    // another tenant sees nothing
    assert.equal((await call('GET', `/v1/documents/${id}`, undefined, foreign)).status, 404);
    assert.deepEqual((await call('GET', '/v1/documents', undefined, foreign)).json, []);
    assert.deepEqual((await call('GET', '/v1/search?q=dredging', undefined, foreign)).json, []);
    assert.equal((await call('GET', `/v1/inspect?ref=${encodeURIComponent(`E09:document:${id}`)}`, undefined, foreign)).status, 404);
    assert.equal((await call('POST', `/v1/documents/${id}/exports`, { revision: 3 }, foreign)).status, 404);
    assert.equal((await call('GET', '/v1/nothing-here')).status, 404);
    assert.equal((await call('POST', '/v1/documents', [1, 2])).status, 400);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { child.once('exit', r); setTimeout(() => { child.kill('SIGKILL'); r(null); }, 5000); });
  }
}));
