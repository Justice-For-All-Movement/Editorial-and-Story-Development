import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DomainError } from '../src/contracts.ts';
import { BUILTIN_LANGUAGES, analyzeLyrics, countSyllables, languageData, rhymeKey, suggestRhymes, syllablesInWord, wrapBySyllables } from '../src/engine/lyrics.ts';
import { checkBasisRules, diffText, normalizeBlock, storyGraph } from '../src/engine/model.ts';
import { httpKnowledgePort, httpModelPort } from '../src/engine/ports.ts';
import { ctx } from './fixtures.ts';

test('syllable counting is language data: English rules, Spanish diphthongs, Ukrainian vowels, generic fallback', () => {
  const en = BUILTIN_LANGUAGES.en!, es = BUILTIN_LANGUAGES.es!, uk = BUILTIN_LANGUAGES.uk!;
  for (const [w, n] of Object.entries({ water: 2, harbor: 2, table: 2, walked: 1, wanted: 2, time: 1, nation: 2, council: 2, the: 1, evidence: 3, contract: 2, river: 2, beautiful: 3, night: 1, promises: 3, quietly: 3 })) assert.equal(syllablesInWord(w, en), n, w);
  for (const [w, n] of Object.entries({ aire: 2, poeta: 3, ciudad: 2, 'país': 2, puerto: 2, que: 1, hoy: 1, playa: 2, contrato: 3, 'río': 2 })) assert.equal(syllablesInWord(w, es), n, w);
  for (const [w, n] of Object.entries({ 'вода': 2, 'місто': 2, 'правда': 2, 'її': 2, 'свідчення': 3 })) assert.equal(syllablesInWord(w, uk), n, w);
  assert.equal(languageData('pt-BR').resolved, 'generic'); assert.equal(languageData('en-GB').resolved, 'en');
  assert.equal(countSyllables('água limpa', languageData('pt').data), 4);
  const custom = languageData('xx', { xx: { mode: 'each_vowel', vowels: 'ao', exceptions: { kraa: 1 } } });
  assert.equal(custom.resolved, 'xx'); assert.equal(syllablesInWord('kalao', custom.data), 3); assert.equal(syllablesInWord('kraa', custom.data), 1);
  assert.equal(syllablesInWord('abc', { mode: 'vowel_groups', vowels: 'a', add: ['(((('] }), 1, 'a malformed configured pattern is ignored, not thrown');
});

test('line analysis, meter check, rhyme scheme and rhyme suggestions', () => {
  const a = analyzeLyrics('The council met at night\nand signed away the light\nThe river keeps its time\nfor those who live in rhyme', 'en', { meter: '6-6' });
  assert.deepEqual(a.syllablePattern, [6, 6, 6, 6]); assert.equal(a.rhymeScheme, 'AABB'); assert.deepEqual(a.meter.deviations, []);
  assert.deepEqual(analyzeLyrics('one two\none two three four', 'en', { meter: '2-2' }).meter.deviations, [{ line: 2, expected: 2, actual: 4 }]);
  assert.match(a.note, /estimated/);
  assert.equal(rhymeKey('night', BUILTIN_LANGUAGES.en!), rhymeKey('white', BUILTIN_LANGUAGES.en!));
  const s = suggestRhymes('night', ['light', 'White', 'harbor', 'ride', 'night', 'sight', 'nation'], 'en');
  assert.deepEqual(s.filter((x) => x.quality === 'perfect').map((x) => x.word), ['light', 'sight', 'white']);
  assert.ok(s.some((x) => x.word === 'ride' && x.quality === 'near')); assert.ok(!s.some((x) => x.word === 'harbor' || x.word === 'night'));
  assert.deepEqual(suggestRhymes('canción', ['nación', 'puerto', 'razón'], 'es').map((x) => [x.word, x.quality]), [['nación', 'perfect'], ['razón', 'near']]);
  assert.deepEqual(wrapBySyllables('The council approved the dredging contract at its public session', 8, BUILTIN_LANGUAGES.en!), ['The council approved the dredging', 'contract at its public session']);
});

test('pure rules: basis is required, graphs are validated, text diff is word level', () => {
  assert.throws(() => normalizeBlock({ id: 'a', type: 'passage', text: 'x' }), (e: unknown) => e instanceof DomainError && e.code === 'invalid_basis');
  const b = normalizeBlock({ id: 'a', type: 'passage', text: 'x', basis: 'attributed_testimony', attribution: 'A witness', sources: ['E07:claim:c1'] });
  const rules = { projectKind: 'factual' as const, isFactSource: (r: string) => r.startsWith('E07:claim'), isTestimonySource: (r: string) => r.startsWith('E06:') };
  assert.throws(() => checkBasisRules(b, rules), /testimony source/);
  checkBasisRules(b, { ...rules, viewpointTestimony: ['E07:claim:c1'] });
  assert.throws(() => storyGraph([normalizeBlock({ id: 'a', type: 'story_node', text: 'x', basis: 'unknown_acknowledged', data: { key: 'a', choices: [{ label: 'loop', to: 'a' }] } })]), /exactly one start/);
  assert.deepEqual(diffText('the old harbor wall', 'the new harbor wall'), [{ op: 'eq', text: 'the ' }, { op: 'del', text: 'old' }, { op: 'add', text: 'new' }, { op: 'eq', text: ' harbor wall' }]);
});

test('HTTP port adapters against a controlled local server: success, 404, provider failure, secrets stay out of errors', async () => {
  const seen: { url: string; auth: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => { let body = ''; req.on('data', (c) => { body += String(c); }); req.on('end', () => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization, body });
    if (req.url === '/model') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'local-fixture', proposals: [{ text: 'A line.' }] })); }
    else if (req.url === '/broken') { res.statusCode = 500; res.end('secret-internal-detail'); }
    else if (req.url === '/v1/claims/status') { const ref = (JSON.parse(body) as { ref: string }).ref; if (ref.includes('missing')) { res.statusCode = 404; res.end(); } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ factual: 'contested', editorial: 'approved', stale: true })); } }
    else { res.statusCode = 404; res.end(); }
  }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const request = { task: 'draft' as const, mode: 'creative' as const, instruction: 'x', language: 'en', docType: 'article', title: 't', blocks: [], maxProposals: 1 };
    assert.deepEqual(await httpModelPort({ endpoint: `${base}/model`, apiKey: 'key-123' }).propose(ctx(), request), { proposals: [{ text: 'A line.' }], model: 'local-fixture' });
    assert.equal(seen[0]!.auth, 'Bearer key-123'); assert.deepEqual(JSON.parse(seen[0]!.body), request);
    await assert.rejects(httpModelPort({ endpoint: `${base}/broken`, apiKey: 'key-123' }).propose(ctx(), request), (e: unknown) => e instanceof DomainError && e.code === 'unavailable' && !/secret|key-123/.test(e.message));
    await assert.rejects(httpModelPort({ endpoint: 'http://127.0.0.1:1/none', timeoutMs: 2000 }).propose(ctx(), request), (e: unknown) => e instanceof DomainError && e.code === 'unavailable');
    assert.throws(() => httpModelPort({ endpoint: 'file:///etc/passwd' }), (e: unknown) => e instanceof DomainError && e.code === 'invalid_config');
    const k = httpKnowledgePort({ baseUrl: base, token: 'svc-token' });
    assert.deepEqual(await k.getClaimStatus(ctx(), 'E07:claim:c1@1'), { factual: 'contested', editorial: 'approved', stale: true, blocked: false });
    assert.equal(await k.getClaimStatus(ctx(), 'E07:claim:missing'), null);
    assert.equal(seen.at(-1)!.auth, 'Bearer svc-token');
  } finally { server.close(); }
});
