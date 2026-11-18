import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/contracts.ts';
import { httpKnowledgePort } from '../src/engine/ports.ts';
import { ctx } from './fixtures.ts';
const token = (tid = 't1', pid = 'p1', purpose = 'editorial') => `header.${Buffer.from(JSON.stringify({ tid, pid, purpose })).toString('base64url')}.signature`;
const ref = 'E07:claim:example@2';
const claim = (extra = {}) => ({ ref, id: 'example', kind: 'claim', revision: 2, state: 'active', stale: false, blocked: false,
  assessments: { factual: { value: 'supported', needsReverification: false }, editorial: { value: 'not_reviewed', needsReverification: false } }, ...extra });
const unavailable = (e: unknown) => e instanceof DomainError && e.code === 'unavailable';
test('actual E07 GET claim route and assessment tracks, with one scope-checked credential', async () => {
  let reads = 0;
  const port = httpKnowledgePort({ baseUrl: 'https://example.invalid', token: () => ++reads === 1 ? token() : token('foreign'),
    fetch: async (url, init) => { assert.equal(String(url), 'https://example.invalid/v1/claims/example'); assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token()}`); return Response.json(claim()); } });
  assert.deepEqual(await port.getClaimStatus(ctx(), ref), { factual: 'supported', editorial: 'not_reviewed', stale: false, blocked: false });
  assert.equal(reads, 1);
});
test('tenant/project/purpose mismatch and malformed exact refs never reach transport', async () => {
  let sends = 0;
  for (const credential of [undefined, token('foreign'), token('t1', 'foreign'), token('t1', 'p1', 'other')]) {
    const port = httpKnowledgePort({ baseUrl: 'https://example.invalid', ...(credential === undefined ? {} : { token: credential }),
      fetch: async () => { sends++; return Response.json(claim()); } });
    await assert.rejects(port.getClaimStatus(ctx(), ref), unavailable);
  }
  const port = httpKnowledgePort({ baseUrl: 'https://example.invalid', token: token(), fetch: async () => { sends++; return Response.json(claim()); } });
  for (const bad of ['E07:claim:example', 'E07:claim:example@0', 'E08:finding:x@1', 'E07:claim:x/y@1']) await assert.rejects(port.getClaimStatus(ctx(), bad), unavailable);
  assert.equal(sends, 0);
});
test('old convention and malformed or different editions cannot silently become supported', async () => {
  for (const value of [{ factual: 'supported', editorial: 'approved' }, claim({ ref: 'E07:claim:example@3', revision: 3 }),
    claim({ assessments: { factual: { value: 'supported' }, editorial: { value: 'approved' } } }), claim({ stale: undefined })]) {
    await assert.rejects(httpKnowledgePort({ baseUrl: 'https://example.invalid', token: token(), fetch: async () => Response.json(value) }).getClaimStatus(ctx(), ref), unavailable);
  }
  for (const status of [401, 403, 500]) await assert.rejects(httpKnowledgePort({ baseUrl: 'https://example.invalid', token: token(), fetch: async () => Response.json({}, { status }) }).getClaimStatus(ctx(), ref), unavailable);
  assert.equal(await httpKnowledgePort({ baseUrl: 'https://example.invalid', token: token(), fetch: async () => Response.json({}, { status: 404 }) }).getClaimStatus(ctx(), ref), null);
});
test('withdrawn claims and stale assessment tracks remain unusable metadata', async () => {
  for (const state of ['withdrawn', 'superseded']) assert.equal((await httpKnowledgePort({ baseUrl: 'https://example.invalid', token: token(), fetch: async () => Response.json(claim({ state })) }).getClaimStatus(ctx(), ref))?.blocked, true);
  const result = await httpKnowledgePort({ baseUrl: 'https://example.invalid', token: token(), fetch: async () => Response.json(claim({ assessments: { factual: { value: 'supported', needsReverification: true }, editorial: { value: 'approved', needsReverification: false } } })) }).getClaimStatus(ctx(), ref);
  assert.equal(result?.stale, true);
});
test('oversize responses, malformed UTF8 and late callbacks fail closed and close their signals', async () => {
  for (const mode of ['bytes', 'utf8', 'late']) {
    let signal: AbortSignal | null = null;
    const port = httpKnowledgePort({ baseUrl: 'https://example.invalid', token: token(), timeoutMs: 100,
      fetch: async (_url, init) => { signal = init?.signal ?? null;
        if (mode === 'late') { const end = performance.now() + 140; while (performance.now() < end) {} }
        return mode === 'utf8' ? new Response(new Uint8Array([255])) : new Response(JSON.stringify(claim()) + (mode === 'bytes' ? ' '.repeat(512 * 1024) : '')); } });
    await assert.rejects(port.getClaimStatus(ctx(), ref), unavailable); assert.equal((signal as AbortSignal | null)?.aborted, true);
  }
});
