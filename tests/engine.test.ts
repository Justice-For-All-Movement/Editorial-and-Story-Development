import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { DomainError } from '../src/contracts.ts';
import { FsObjectStore, withDisposableDatabase } from '../src/service-kit.ts';
import type { EngineEvent, ServiceContext, Sql } from '../src/service-kit.ts';
import { createEngine, migrate } from '../src/engine/index.ts';
import type { Block, DocumentBody, EditorialDeps, EditorialEngine } from '../src/engine/index.ts';
import { ADMIN, CLAIM_CONTRACT, CLAIM_DENIAL, CLAIM_PAYMENT, CLAIM_TIPOFF, EVIDENCE_MINUTES, FINDING_CONTRACT, FINDING_TIPOFF, PACKAGE_REF, SEGMENT_INTERVIEW, block, ctx, editor, investigationPackage, knowledge, needsPg, project, useDecisions, viewpoint } from './fixtures.ts';

const fails = (code: string, match?: RegExp) => (e: unknown): boolean => { assert.ok(e instanceof DomainError, `expected DomainError, got ${String(e)}`); assert.equal(e.code, code, e.message); if (match) assert.match(e.message, match); return true; };
const db = (fn: (sql: Sql) => Promise<void>): Promise<void> => withDisposableDatabase(pg, ADMIN, async (_u, sql) => { await migrate(sql); await fn(sql); });
const make = (sql: Sql, over: Partial<EditorialDeps> = {}): EditorialEngine => createEngine({ sql, ports: { knowledge: knowledge(), useDecisions: useDecisions() }, ...over });
async function events(e: EditorialEngine, c: ServiceContext, type: string, want = 1): Promise<EngineEvent[]> {
  // The feed withholds rows while any transaction on the server is open; poll briefly.
  for (let i = 0; ; i++) { const got = (await e.events(c, { limit: 1000 })).filter((x) => x.type === type); if (got.length >= want || i > 100) return got; await new Promise((r) => setTimeout(r, 100)); }
}
async function doc(e: EditorialEngine, blocks: unknown[], over: Record<string, unknown> = {}, projectOver: Record<string, unknown> = {}): Promise<{ projectId: string; id: string }> {
  const p = await e.create(ctx(), 'editorial_project', { body: project(projectOver) });
  const d = await e.create(ctx(), 'document', { body: { title: 'Draft', editorialProjectId: p.id, docType: 'article', language: 'en', blocks, ...over } });
  return { projectId: p.id, id: d.id };
}

test('migrations are idempotent and the manifest names the engine', needsPg, () => db(async (sql) => {
  assert.deepEqual(await migrate(sql), []);
  const e = make(sql);
  assert.equal(e.manifest.id, 'E09');
  assert.equal((await e.health()).ok, true);
}));

test('basis labels and sources are enforced on every save', needsPg, () => db(async (sql) => {
  const k = knowledge(); const u = useDecisions();
  const e = make(sql, { ports: { knowledge: k, useDecisions: u } });
  const p = await e.create(ctx(), 'editorial_project', { body: project() });
  const save = (b: Record<string, unknown>) => e.create(ctx(), 'document', { body: { title: 'D', editorialProjectId: p.id, docType: 'article', language: 'en', blocks: [b] } });
  const { basis: _b, ...noBasis } = block('b1');
  await assert.rejects(save(noBasis), fails('invalid_basis', /basis label is required/));
  await assert.rejects(save(block('b1', { basis: 'true_story' })), fails('invalid_basis'));
  await assert.rejects(save(block('b1', { sources: [] })), fails('invalid_basis', /claim or finding source/));
  await assert.rejects(save(block('b1', { sources: [EVIDENCE_MINUTES] })), fails('invalid_basis', /claim or finding source/));
  await assert.rejects(save(block('b1', { sources: ['not a ref'] })), fails('invalid_reference'));
  // knowledge service: contested, stale and unknown claims cannot back a verified fact
  k.set(CLAIM_TIPOFF, { factual: 'contested' });
  await assert.rejects(save(block('b1', { sources: [CLAIM_TIPOFF] })), fails('invalid_basis', /contested/));
  k.set(CLAIM_TIPOFF, { stale: true });
  await assert.rejects(save(block('b1', { sources: [CLAIM_CONTRACT, CLAIM_TIPOFF] })), fails('invalid_basis', /stale/));
  k.set(CLAIM_TIPOFF, null);
  await assert.rejects(save(block('b1', { sources: [CLAIM_TIPOFF] })), fails('invalid_basis', /unknown to the knowledge service/));
  // downgrade only by explicit author choice, recorded on the block
  const down = await e.create(ctx(), 'document', { unsupportedFacts: 'downgrade', body: { title: 'D', editorialProjectId: p.id, docType: 'article', language: 'en', blocks: [block('b1', { sources: [CLAIM_TIPOFF] })] } });
  assert.equal(down.body.blocks[0]!.basis, 'allegation');
  assert.equal(down.body.blocks[0]!.downgraded!.from, 'verified_fact');
  await assert.rejects(e.create(ctx(), 'document', { unsupportedFacts: 'downgrade', downgradeTo: 'verified_fact', body: { title: 'D', editorialProjectId: p.id, docType: 'article', language: 'en', blocks: [block('b1', { sources: [CLAIM_TIPOFF] })] } }), fails('invalid_input'));
  // attributed testimony: attribution and a testimony source
  await assert.rejects(save(block('b1', { basis: 'attributed_testimony', sources: [SEGMENT_INTERVIEW] })), fails('invalid_basis', /attribution/));
  await assert.rejects(save(block('b1', { basis: 'attributed_testimony', attribution: 'A witness', sources: [CLAIM_CONTRACT] })), fails('invalid_basis', /testimony source/));
  const t = await save(block('b1', { basis: 'attributed_testimony', attribution: 'A witness', sources: [SEGMENT_INTERVIEW] }));
  assert.equal((t.body.blocks[0]!.verification!.useDecision as { decision: string }).decision, 'allow');
  assert.deepEqual(u.calls.at(-1), { subjects: [SEGMENT_INTERVIEW], action: 'adapt' });
  u.deny.add(SEGMENT_INTERVIEW);
  await assert.rejects(save(block('b2', { basis: 'attributed_testimony', attribution: 'A witness', sources: [SEGMENT_INTERVIEW] })), fails('consent_denied'));
  // allegation, and declared non-factual bases
  await assert.rejects(save(block('b1', { basis: 'allegation', sources: [] })), fails('invalid_basis', /attribution or a source/));
  for (const basis of ['reconstruction', 'invention']) await assert.rejects(save(block('b1', { basis, sources: [] })), fails('invalid_basis', /disclosure/));
  await assert.rejects(save(block('b1', { basis: 'satire', sources: [], disclosure: 'A joke.' })), fails('invalid_basis', /kind satire/));
  const ok = await save(block('b1', { basis: 'reconstruction', sources: [CLAIM_CONTRACT], disclosure: 'Reconstructed from the minutes; the dialogue is not verbatim.' }));
  assert.equal(ok.body.blocks[0]!.disclosure, 'Reconstructed from the minutes; the dialogue is not verbatim.');
  await assert.rejects(save({ ...block('b1'), surprise: 1 }), fails('invalid_input', /unknown property/));
  const count = await sql.query<{ n: string }>(`select count(*)::text as n from e09_editorial.objects where kind='document'`);
  assert.equal(count[0]!.n, '3', 'rejected saves persist nothing');
}));

test('protective checks deny when a port is absent, unless a standalone mode is selected', needsPg, () => db(async (sql) => {
  const bare = createEngine({ sql });
  const p = await bare.create(ctx(), 'editorial_project', { body: project() });
  const body = (b: Record<string, unknown>) => ({ body: { title: 'D', editorialProjectId: p.id, docType: 'article', language: 'en', blocks: [b] } });
  await assert.rejects(bare.create(ctx(), 'document', body(block('b1'))), fails('unavailable', /KnowledgePort/));
  await assert.rejects(bare.create(ctx(), 'viewpoint', { body: viewpoint() }), fails('unavailable', /UseDecisionPort/));
  await assert.rejects(bare.proposeDrafts(ctx(), p.id, { instruction: 'x' }), fails('unavailable', /ModelPort/));
  const standalone = createEngine({ sql, config: { standalone: { knowledge: true, useDecisions: true } } });
  const d = await standalone.create(ctx(), 'document', body(block('b1')));
  assert.deepEqual(d.body.blocks[0]!.verification!.knowledge, { mode: 'standalone', status: 'not_checked' });
  const fc = await standalone.factCheck(ctx(), d.id);
  assert.equal(fc.knowledge, 'standalone_not_checked'); assert.equal(fc.statements[0]!.status, 'not_checked');
  const v = await standalone.create(ctx(), 'viewpoint', { body: viewpoint() });
  assert.equal(v.revision, 1);
}));

test('authorization fails closed and sensitive actions need their exact capability', needsPg, () => db(async (sql) => {
  const e = make(sql);
  const { id } = await doc(e, [block('b1')]);
  const none = ctx({ capabilities: [] }), wild = ctx({ capabilities: ['editorial:*'] }), reader = ctx({ capabilities: ['editorial:read'] });
  await assert.rejects(e.get(none, 'document', id), fails('forbidden'));
  await assert.rejects(e.create(reader, 'editorial_project', { body: project() }), fails('forbidden'));
  await assert.rejects(e.search(none, { q: 'Text' }), fails('forbidden'));
  await assert.rejects(e.inspect(none, `E09:document:${id}`), fails('forbidden'));
  await assert.rejects(e.factCheck(none, id), fails('forbidden'));
  assert.equal((await e.get(wild, 'document', id)).id, id);
  await e.requestReview(wild, 'document', id, { expectedRevision: 1 });
  await assert.rejects(e.approve(editor({ capabilities: ['editorial:*'] }), 'document', id, { revision: 1 }), fails('forbidden'));
  await assert.rejects(e.exportDocument(wild, id, 1), fails('forbidden'));
  await assert.rejects(e.events(wild), fails('forbidden'));
  await assert.rejects(e.applyUpstreamChange(wild, { eventId: 'x', kind: 'claim_changed', refs: [CLAIM_CONTRACT], reason: 'r' }), fails('forbidden'));
  await assert.rejects(e.get(undefined as unknown as ServiceContext, 'document', id), fails('unauthenticated'));
  // AuthorizationPort is re-checked before approval and export
  const strict = make(sql, { ports: { knowledge: knowledge(), useDecisions: useDecisions(), authorization: { authorize: async () => ({ allowed: false, reason: 'policy', policyVersion: '1' }) } } });
  await assert.rejects(strict.approve(editor(), 'document', id, { revision: 1 }), fails('forbidden'));
  await assert.rejects(strict.exportDocument(ctx(), id, 1), fails('forbidden'));
}));

test('version history, diff, restore as a new revision, and idempotent replay', needsPg, () => db(async (sql) => {
  const e = make(sql);
  const p = await e.create(ctx(), 'editorial_project', { body: project() });
  const body = (blocks: unknown[], title = 'Draft') => ({ title, editorialProjectId: p.id, docType: 'article', language: 'en', blocks });
  const a = block('a', { text: 'The council approved the contract in March.' }), b = block('b', { basis: 'allegation', attribution: 'A resident', sources: [], text: 'It was decided earlier.' }), c = block('c', { basis: 'unknown_acknowledged', sources: [], text: 'Nobody knows who signed.' });
  const r1 = await e.create(ctx(), 'document', { body: body([a, b]), idempotencyKey: 'k-create' });
  const replay = await e.create(ctx(), 'document', { body: body([a, b]), idempotencyKey: 'k-create' });
  assert.equal(replay.id, r1.id);
  await assert.rejects(e.create(ctx(), 'document', { body: body([a]), idempotencyKey: 'k-create' }), fails('idempotency_conflict'));
  const r2 = await e.revise(ctx(), 'document', r1.id, { expectedRevision: 1, summary: 'tighten, reorder, add unknown', idempotencyKey: 'k-rev', body: body([b, { ...a, text: 'The council approved the dredging contract in March.' }, c], 'Draft two') });
  assert.equal((await e.revise(ctx(), 'document', r1.id, { expectedRevision: 1, summary: 'tighten, reorder, add unknown', idempotencyKey: 'k-rev', body: body([b, { ...a, text: 'The council approved the dredging contract in March.' }, c], 'Draft two') })).revision, 2, 'replay returns the stored result, not a third revision');
  assert.equal(r2.revision, 2);
  await assert.rejects(e.revise(ctx(), 'document', r1.id, { expectedRevision: 2, body: r2.body }), fails('invalid_input', /identical/));
  const d = await e.diff(ctx(), 'document', r1.id, 1, 2);
  assert.deepEqual(d.fields.map((f) => f.path), ['title']);
  assert.deepEqual(d.blocks!.added.map((x) => x.id), ['c']);
  assert.equal(d.blocks!.moved.length, 1);
  const changed = d.blocks!.changed.find((x) => x.id === 'a')!;
  assert.deepEqual(changed.fields, ['text']);
  assert.deepEqual(changed.text!.filter((o) => o.op === 'add').map((o) => o.text.trim()), ['dredging']);
  const r3 = await e.restore(ctx(), 'document', r1.id, { revision: 1, expectedRevision: 2 });
  assert.equal(r3.revision, 3); assert.equal(r3.restoredFrom, 1); assert.equal(r3.body.title, 'Draft');
  assert.deepEqual(r3.body.blocks.map((x) => [x.id, x.text, x.basis]), r1.body.blocks.map((x) => [x.id, x.text, x.basis]));
  const h = await e.history(ctx(), 'document', r1.id);
  assert.deepEqual(h.map((x) => [x.revision, x.restoredFrom]), [[1, null], [2, null], [3, 1]]);
  assert.equal((await e.get(ctx(), 'document', r1.id, 2)).body.title, 'Draft two', 'earlier revisions stay readable and unchanged');
  await assert.rejects(e.get(ctx(), 'document', r1.id, 9), fails('not_found'));
  // other kinds are revisioned the same way
  const p2 = await e.revise(ctx(), 'editorial_project', p.id, { expectedRevision: 1, body: project({ aim: 'Explain the vote' }) });
  assert.deepEqual((await e.diff(ctx(), 'editorial_project', p.id, 1, 2)).fields.map((f) => f.path), ['aim']);
  assert.equal(p2.revision, 2);
  const audit = await e.audit(ctx(), { subject: `E09:document:${r1.id}` });
  assert.deepEqual(audit.map((x) => x.action), ['document.created', 'document.revised', 'document.restored']);
  const revised = await events(e, ctx(), 'editorial.document_revised', 3);
  assert.deepEqual(revised.map((x) => x.subject), [1, 2, 3].map((n) => `E09:document:${r1.id}@${n}`));
}));

test('concurrent edits: one writer wins, the other gets a revision conflict', needsPg, () => db(async (sql) => {
  const e = make(sql);
  const { id, projectId } = await doc(e, [block('a')]);
  const body = (text: string) => ({ title: 'Draft', editorialProjectId: projectId, docType: 'article', language: 'en', blocks: [block('a', { text })] });
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_x, i) => e.revise(ctx(), 'document', id, { expectedRevision: 1, body: body(`Writer ${i} version.`) })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results) if (r.status === 'rejected') assert.ok(fails('revision_conflict')(r.reason));
  assert.equal((await e.history(ctx(), 'document', id)).length, 2);
  await assert.rejects(e.revise(ctx(), 'document', id, { expectedRevision: 1, body: body('late') }), fails('revision_conflict'));
}));

test('approval binds to one revision; a source change invalidates it without rewriting the text', needsPg, () => db(async (sql) => {
  const e = make(sql);
  const { id, projectId } = await doc(e, [block('a', { text: 'The council approved the contract.' }), block('b', { basis: 'allegation', attribution: 'A resident', sources: [CLAIM_TIPOFF], text: 'It was decided earlier.' })]);
  await assert.rejects(e.approve(editor(), 'document', id, { revision: 1 }), fails('invalid_state'));
  assert.equal((await e.requestReview(ctx(), 'document', id, { expectedRevision: 1 })).state, 'in_review');
  await assert.rejects(e.approve(ctx(), 'document', id, { revision: 1 }), fails('forbidden', /author/));
  const approval = await e.approve(editor(), 'document', id, { revision: 1, note: 'checked against minutes' });
  const approved = await e.get(ctx(), 'document', id);
  assert.equal(approved.state, 'approved'); assert.equal(approval.digest, approved.digest); assert.equal(approval.status, 'active');
  // a newer draft does not disturb the approved revision
  const r2 = await e.revise(ctx(), 'document', id, { expectedRevision: 1, body: { title: 'Draft', editorialProjectId: projectId, docType: 'article', language: 'en', blocks: [block('a', { text: 'The council approved the contract.' }), block('c', { basis: 'unknown_acknowledged', sources: [], text: 'The vote count is not recorded.' })] } });
  assert.equal(r2.state, 'draft');
  assert.equal((await e.get(ctx(), 'document', id, 1)).state, 'approved');
  // upstream: the claim behind block a changes (new revision 3 of the claim cited at @2)
  const change = { eventId: 'evt-claim-1', kind: 'claim_changed' as const, refs: ['E07:claim:c-contract@3'], reason: 'The claim was corrected: the session was in April' };
  const out = await e.applyUpstreamChange(ctx(), change);
  assert.ok(out.affected.includes(`E09:block:${id}.a@2`), 'current block flagged');
  assert.ok(out.affected.includes(`E09:document:${id}@1`) && out.affected.includes(approval.ref), 'approved revision reported');
  assert.deepEqual(await e.applyUpstreamChange(ctx(), change), out, 'replay by eventId returns the same result');
  assert.equal((await e.listFlags(ctx(), { objectId: id })).length, 1, 'replay adds no second flag');
  const after1 = await e.get(ctx(), 'document', id, 1);
  assert.equal(after1.digest, approved.digest); assert.deepEqual(after1.body, approved.body, 'approved text is untouched');
  const approvals = await e.listApprovals(ctx(), 'document', id);
  assert.equal(approvals[0]!.status, 'needs_renewal'); assert.equal(approvals[0]!.invalidatedCause, 'evt-claim-1');
  const cur = await e.get(ctx(), 'document', id);
  assert.equal(cur.stale, true); assert.equal(cur.flags[0]!.blockId, 'a'); assert.match(cur.flags[0]!.reason, /April/);
  const insp = (await e.inspect(ctx(), `E09:block:${id}.a`))!;
  assert.equal(insp.stale, true); assert.match(insp.staleReasons[0]!, /evt-claim-1/); assert.deepEqual(insp.sources, [CLAIM_CONTRACT]);
  assert.equal((await e.inspect(ctx(), `E09:block:${id}.c`))!.stale, false);
  assert.equal((await events(e, ctx(), 'editorial.block_stale'))[0]!.subject, `E09:block:${id}.a@2`);
  const inv = (await events(e, ctx(), 'editorial.approval_invalidated'))[0]!;
  assert.equal(inv.subject, `E09:document:${id}@1`); assert.equal((inv.payload as { cause: string }).cause, 'evt-claim-1');
  await assert.rejects(e.exportDocument(ctx(), id, 1, { requireApproved: true }), fails('approval_invalid', /needs_renewal/));
  // review of the stale current revision is refused until the flag is resolved by a human
  await e.requestReview(ctx(), 'document', id, { expectedRevision: 2 });
  await assert.rejects(e.approve(editor(), 'document', id, { revision: 2 }), fails('invalid_state', /open stale/));
  await e.resolveFlag(ctx(), cur.flags[0]!.id, { resolution: 'reviewed_still_accurate', note: 'The passage does not state the month.' });
  const a2 = await e.approve(editor(), 'document', id, { revision: 2 });
  assert.equal(a2.revision, 2);
  assert.deepEqual((await e.listApprovals(ctx(), 'document', id)).map((x) => x.status), ['superseded', 'active']);
  assert.equal((await e.get(ctx(), 'document', id, 1)).state, 'superseded');
  // an unrelated change touches nothing
  assert.deepEqual((await e.applyUpstreamChange(ctx(), { eventId: 'evt-other', kind: 'source_corrected', refs: ['E05:evidence_version:unrelated@1'], reason: 'r' })).affected, []);
}));

test('generators keep the labels and sources of the investigation package', needsPg, () => db(async (sql) => {
  const k = knowledge(); const e = make(sql, { ports: { knowledge: k, useDecisions: useDecisions() } });
  const p = await e.create(ctx(), 'editorial_project', { body: project() });
  const v = await e.create(ctx(), 'viewpoint', { body: viewpoint() });
  const gen = (generator: string, extra: Record<string, unknown> = {}) => e.generate(ctx(), { generator: generator as 'outline', editorialProjectId: p.id, package: investigationPackage(), viewpointIds: [v.id], ...extra });
  const byText = (blocks: Block[], re: RegExp): Block => { const b = blocks.find((x) => re.test(x.text.replace(/\s+/g, ' '))); assert.ok(b, `no block matching ${re}`); return b; };
  for (const name of ['outline', 'treatment', 'narrative', 'lyrics', 'script', 'storyboard', 'interactive'] as const) {
    const { document: d, omitted } = await gen(name);
    const blocks = d.body.blocks;
    const fact = byText(blocks, /approved the dredging contract/);
    assert.equal(fact.basis, 'verified_fact', name);
    assert.deepEqual(fact.sources, [FINDING_CONTRACT, CLAIM_CONTRACT, EVIDENCE_MINUTES], name);
    assert.deepEqual(fact.sourceSelectors, { [EVIDENCE_MINUTES]: { page: 4 } });
    assert.match(fact.note!, /vote count/);
    const disputed = byText(blocks, /told the outcome before the vote/);
    assert.equal(disputed.basis, 'allegation'); assert.ok(disputed.attribution); assert.deepEqual(disputed.sources, [FINDING_TIPOFF, CLAIM_TIPOFF, CLAIM_DENIAL]);
    assert.match(disputed.note!, /Contradicting sources/);
    assert.equal(byText(blocks, /second payment is not known/).basis, 'unknown_acknowledged');
    assert.equal(byText(blocks, /bid evaluation sheets/).basis, 'unknown_acknowledged');
    assert.equal(byText(blocks, /Open question/).basis, 'unknown_acknowledged');
    const dated = byText(blocks, /second payment was made/);
    assert.equal(dated.basis, 'verified_fact'); assert.deepEqual(dated.sources, [CLAIM_PAYMENT, 'E05:evidence_version:ev-ledger@1']);
    const voice = byText(blocks, /trucks arrive/);
    assert.equal(voice.basis, 'attributed_testimony'); assert.equal(voice.viewpointId, v.id); assert.equal(voice.attribution, 'A dock worker who was present'); assert.deepEqual(voice.sources, [SEGMENT_INTERVIEW]);
    assert.ok(!blocks.some((b) => /paid by the contractor|nine years earlier/.test(b.text)), 'refuted and stale findings are not presented');
    assert.deepEqual(omitted.map((o) => o.ref).sort(), ['E08:finding:f-bribe@1', 'E08:finding:f-old@2']);
    for (const b of blocks.filter((x) => x.generated!.role === 'connective')) { assert.equal(b.basis, 'invention'); assert.match(b.disclosure!, /Generated/); assert.deepEqual(b.sources, []); }
    if (name !== 'storyboard') assert.ok(blocks.some((b) => b.generated!.role === 'connective'), `${name} labels its connective text`);
    assert.ok(blocks.every((b) => b.generated !== undefined));
    assert.deepEqual(d.body.meta.generatedFrom, { package: PACKAGE_REF, generator: name, viewpoints: [v.id] });
  }
  // deterministic
  const one = await gen('narrative'), two = await gen('narrative');
  const plain = (bs: Block[]) => bs.map(({ verification: _v, ...b }) => b);
  assert.deepEqual(plain(one.document.body.blocks), plain(two.document.body.blocks));
  // chronology orders the narrative; lyric sections carry syllable counts; the graph is playable
  const narrative = one.document.body.blocks.filter((b) => b.generated!.role === 'content').map((b) => b.data.heading);
  assert.deepEqual(narrative.slice(0, 3), ['2031-03-03', '2031-04-10', 'Undated']);
  const lyrics = (await gen('lyrics', { lineSyllables: 7 })).document.body.blocks;
  assert.deepEqual(lyrics.map((b) => b.data.part).slice(0, 3), ['verse', 'chorus', 'verse']);
  for (const b of lyrics) assert.equal((b.data.syllables as number[]).length, b.text.split('\n').length);
  const interview = (await gen('interview_plan')).document.body.blocks;
  assert.ok(interview.every((b) => b.type === 'interview_question' && b.basis !== 'verified_fact'));
  assert.deepEqual(interview[0]!.data.consentPrerequisites, ['E11:permission:perm-1@1']);
  // generated facts go through the same knowledge check: no silent verified_fact for a contested claim
  k.set(CLAIM_CONTRACT, { factual: 'contested' });
  await assert.rejects(gen('outline'), fails('invalid_basis', /contested/));
  const down = await gen('outline', { unsupportedFacts: 'downgrade' });
  assert.equal(byText(down.document.body.blocks, /approved the dredging contract/).basis, 'allegation');
  // the generated document depends on the package: a new package version flags it
  const out = await e.applyUpstreamChange(ctx(), { eventId: 'evt-pkg', kind: 'content_changed', refs: ['E08:investigation_package:inv-harbor@5'], reason: 'package rebuilt' });
  assert.ok(out.affected.includes(`E09:document:${one.document.id}@1`));
  await assert.rejects(e.generate(ctx(), { generator: 'outline', editorialProjectId: p.id, package: { ref: PACKAGE_REF, content: { schema: 'other' } } }), fails('invalid_input'));
}));

test('fact-check ledger lists factual statements, their sources and status, and unsourced statements', needsPg, () => db(async (sql) => {
  const k = knowledge(); const e = make(sql, { ports: { knowledge: k, useDecisions: useDecisions() } });
  const { id } = await doc(e, [
    block('fact', { sources: [CLAIM_CONTRACT, EVIDENCE_MINUTES], sourceSelectors: { [EVIDENCE_MINUTES]: { page: 4 } }, note: 'The minutes do not give the vote count.' }),
    block('claim', { basis: 'allegation', attribution: 'A resident', sources: [] }),
    block('guess', { basis: 'inference', sources: [] }),
    block('scene', { basis: 'reconstruction', sources: [CLAIM_CONTRACT], disclosure: 'Reconstructed scene.' }),
    block('gap', { basis: 'unknown_acknowledged', sources: [] }),
  ]);
  let fc = await e.factCheck(ctx(), id);
  assert.deepEqual(fc.statements.map((s) => [s.blockId, s.status]), [['fact', 'supported'], ['claim', 'unsourced'], ['guess', 'unsourced']]);
  assert.deepEqual(fc.unsourced, ['claim', 'guess']);
  assert.deepEqual(fc.declared.map((d) => [d.blockId, d.basis]), [['scene', 'reconstruction'], ['gap', 'unknown_acknowledged']]);
  const fact = fc.statements[0]!;
  assert.equal(fact.uncertainty, 'The minutes do not give the vote count.');
  assert.deepEqual(fact.sources.map((s) => [s.ref, s.role, s.selector]), [[CLAIM_CONTRACT, 'fact', null], [EVIDENCE_MINUTES, 'testimony', { page: 4 }]]);
  assert.deepEqual(fact.sources[0]!.current, { factual: 'supported', editorial: 'approved', stale: false, blocked: false });
  assert.deepEqual(fc.summary, { blocks: 5, byBasis: { verified_fact: 1, allegation: 1, inference: 1, reconstruction: 1, unknown_acknowledged: 1 }, factual: 2, unsourced: 2, attention: 0 });
  // the live status is shown even before any upstream event arrives
  k.set(CLAIM_CONTRACT, { factual: 'refuted' });
  fc = await e.factCheck(ctx(), id);
  assert.equal(fc.statements[0]!.status, 'attention'); assert.equal((fc.statements[0]!.sources[0]!.current as { factual: string }).factual, 'refuted');
  const insp = (await e.inspect(ctx(), `E09:block:${id}.fact@1`))!;
  assert.equal(insp.kind, 'block'); assert.equal(insp.state, 'verified_fact'); assert.deepEqual(insp.sources, [CLAIM_CONTRACT, EVIDENCE_MINUTES].sort());
}));

test('exports carry labels, disclosures, credits and a manifest of the exact revision', needsPg, () => db(async (sql) => {
  const store = new FsObjectStore(await mkdtemp(join(tmpdir(), 'e09-')));
  const u = useDecisions(); const e = make(sql, { objects: store, ports: { knowledge: knowledge(), useDecisions: u } });
  const col = await e.create(ctx(), 'collaborator', { body: { name: 'Mara Quill', roles: ['writer'], creditLine: 'Written by Mara Quill' } });
  const v = await e.create(ctx(), 'viewpoint', { body: viewpoint() });
  const { id, projectId } = await doc(e, [
    block('h', { type: 'script_element', basis: 'invention', sources: [], disclosure: 'Scene heading chosen by the writers.', text: 'Harbor office, night', data: { element: 'scene_heading' } }),
    block('n', { type: 'script_element', text: 'The council approved the contract.', data: { element: 'narration' } }),
    block('d', { type: 'script_element', basis: 'attributed_testimony', attribution: 'A dock worker who was present', sources: [SEGMENT_INTERVIEW], viewpointId: v.id, text: 'I saw the trucks arrive.', data: { element: 'dialogue', character: 'Dock worker' } }),
    block('r', { type: 'script_element', basis: 'reconstruction', sources: [CLAIM_CONTRACT], disclosure: 'Reconstructed exchange; the words are not a transcript.', text: 'Sign it tonight.', data: { element: 'dialogue', character: 'Official' } }),
    block('s', { type: 'scene', basis: 'reconstruction', sources: [CLAIM_CONTRACT], disclosure: 'Staged reconstruction.', text: 'Trucks wait at the gate.', data: { purpose: 'Show the early arrival', location: 'Harbor gate', time: 'Dawn', panels: [{ id: 'p1', description: 'Wide shot of the gate', framing: 'wide', durationSeconds: 4, audioNotes: 'engines idling', assetRefs: ['E10:asset:gate-plate@1'] }] } }),
  ], { docType: 'script' }, { credits: [{ collaboratorId: col.id, role: 'writer' }], format: 'documentary' });
  const x = await e.exportDocument(ctx(), id, 1, { idempotencyKey: 'exp-1' });
  assert.equal(x.manifest.document, `E09:document:${id}@1`); assert.equal(x.manifest.revision, 1);
  assert.equal(x.manifest.contentDigest, (await e.get(ctx(), 'document', id)).digest);
  assert.deepEqual(x.manifest.sourceRefs, [SEGMENT_INTERVIEW, CLAIM_CONTRACT].sort());
  assert.deepEqual(x.manifest.assetRefs, ['E10:asset:gate-plate@1']);
  assert.ok(x.manifest.viewpointRefs.includes(`E09:viewpoint:${v.id}`) && x.manifest.viewpointRefs.includes('E11:participant:part-1'));
  assert.deepEqual(x.manifest.formats, ['json', 'markdown', 'fountain']);
  assert.deepEqual(x.manifest.credits, [{ name: 'Mara Quill', role: 'writer', creditLine: 'Written by Mara Quill' }]);
  assert.equal(x.manifest.reviewState, 'draft'); assert.equal(x.manifest.approval, null);
  assert.deepEqual(x.manifest.disclosures.map((d) => d.blockId), ['h', 'r', 's']);
  assert.equal(x.manifest.labels.projectKind, 'factual'); assert.equal(x.manifest.labels.notice, null);
  assert.equal(u.calls.at(-1)!.action, 'adapt');
  for (const text of [x.renderings.markdown!, x.renderings.fountain!]) { assert.match(text, /Reconstructed exchange; the words are not a transcript\./); assert.match(text, /Staged reconstruction\./); assert.match(text, /A dock worker who was present/i); assert.match(text, /verified_fact/); assert.match(text, /E07:claim:c-contract@2/); }
  assert.match(x.renderings.fountain!, /^Title: Draft\nCredit: Written by Mara Quill/); assert.match(x.renderings.fountain!, /\n\.HARBOR OFFICE, NIGHT\n/); assert.match(x.renderings.fountain!, /@DOCK WORKER\nI saw the trucks arrive\./); assert.match(x.renderings.fountain!, /!SHOT 1 — wide — 4s: Wide shot of the gate/);
  assert.equal(x.document.blocks.find((b) => b.id === 'd')!.viewpoint!.label, 'Dock worker');
  assert.ok(!JSON.stringify(x).includes('workplace entrance'), 'dignity notes are internal and never exported');
  const stored = JSON.parse(Buffer.from(await store.get(x.manifest.objectKey!)).toString('utf8')) as { manifest: { exportId: string } };
  assert.equal(stored.manifest.exportId, x.manifest.exportId); assert.ok(x.manifest.objectKey!.startsWith('t1/p1/exports/'));
  assert.equal((await e.exportDocument(ctx(), id, 1, { idempotencyKey: 'exp-1' })).manifest.exportId, x.manifest.exportId);
  assert.equal((await e.listExports(ctx(), id)).length, 1);
  assert.equal((await events(e, ctx(), 'editorial.exported'))[0]!.subject, `E09:document:${id}@1`);
  await assert.rejects(e.exportDocument(ctx(), id, 1, { requireApproved: true }), fails('approval_invalid'));
  await assert.rejects(e.exportDocument(ctx(), id, 1, { formats: ['graph'] }), fails('invalid_input'));
  await assert.rejects(e.exportDocument(ctx(), id, 7), fails('not_found'));
  // publishing needs a completed consent decision
  u.review.add(SEGMENT_INTERVIEW);
  await assert.rejects(e.exportDocument(ctx(), id, 1, { intendedUse: 'publish' }), fails('consent_denied', /review/));
  assert.equal(((await e.exportDocument(ctx(), id, 1)).manifest.useDecisions[0] as { decision: string }).decision, 'review');
  u.review.clear(); u.deny.add('E11:participant:part-1');
  await assert.rejects(e.exportDocument(ctx(), id, 1), fails('consent_denied'));
  u.deny.clear();
  // lyric sheet and interactive graph
  const song = await e.create(ctx(), 'document', { body: { title: 'Harbor song', editorialProjectId: projectId, docType: 'lyrics', language: 'en', blocks: [
    block('v1', { type: 'lyric_section', text: 'The council met in early spring\nand signed the paper for the thing', data: { part: 'verse', label: 'Verse 1', meter: '8-8', tempoBpm: 92, key: 'D minor', melodyHint: 'falling line' } }),
    block('c1', { type: 'lyric_section', basis: 'invention', sources: [], disclosure: 'Chorus is the songwriter\'s own image.', text: 'Deep water keeps what it is told', data: { part: 'chorus' } })] } });
  assert.deepEqual(song.body.blocks[0]!.data.syllables, [8, 8]);
  const sheet = (await e.exportDocument(ctx(), song.id, 1)).renderings.lyricSheet!;
  assert.match(sheet, /\[Verse 1\] \(verified_fact\) \{meter 8-8; 92 bpm; key D minor; melody: falling line\}/); assert.match(sheet, /and signed the paper for the thing {2}\(8\)/); assert.match(sheet, /\(Disclosure \(invention\): Chorus is the songwriter's own image\.\)/);
  const node = (id2: string, key: string, data: Record<string, unknown>, over: Record<string, unknown> = {}) => block(id2, { type: 'story_node', data: { key, ...data }, ...over });
  const story = (blocks: unknown[]) => e.create(ctx(), 'document', { body: { title: 'Paths', editorialProjectId: projectId, docType: 'interactive_story', language: 'en', blocks } });
  await assert.rejects(story([node('a', 'start', { start: true, choices: [{ label: 'go', to: 'nowhere' }] })]), fails('invalid_input', /unknown node/));
  await assert.rejects(story([node('a', 'start', { start: true, choices: [{ label: 'go', to: 'end' }] }), node('b', 'end', { ending: 'done' }), node('c', 'island', { ending: 'lost' })]), fails('invalid_input', /cannot be reached/));
  await assert.rejects(story([node('a', 'start', { start: true })]), fails('invalid_input', /dead end/));
  const g = await story([node('a', 'start', { start: true, choices: [{ label: 'Read the minutes', to: 'minutes', effects: { read: true } }, { label: 'Leave', to: 'end', condition: { var: 'read', op: 'eq', value: true } }] }), node('b', 'minutes', { choices: [{ label: 'Back', to: 'start' }] }), node('c', 'end', { ending: 'closed' }, { basis: 'unknown_acknowledged', sources: [] })]);
  const graph = (await e.exportDocument(ctx(), g.id, 1)).renderings.graph as { start: string; endings: string[]; variables: string[]; nodes: { key: string; basis: string; sources: string[] }[] };
  assert.equal(graph.start, 'start'); assert.deepEqual(graph.endings, ['end']); assert.deepEqual(graph.variables, ['read']);
  assert.deepEqual(graph.nodes.map((n) => [n.key, n.basis]), [['start', 'verified_fact'], ['minutes', 'verified_fact'], ['end', 'unknown_acknowledged']]);
}));

test('translations: block-to-block links, inherited labels, staleness when the source block changes', needsPg, () => db(async (sql) => {
  const e = make(sql);
  const { id, projectId } = await doc(e, [block('a', { text: 'The council approved the contract.' }), block('b', { basis: 'reconstruction', sources: [CLAIM_CONTRACT], disclosure: 'Reconstructed.', text: 'They signed at night.' }), block('c', { basis: 'unknown_acknowledged', sources: [], text: 'Nobody knows why.' })]);
  const tr = (blocks: unknown[]) => e.createTranslation(ctx(), { sourceDocumentId: id, language: 'es', title: 'Borrador', blocks });
  await assert.rejects(tr([{ id: 'ta', translates: 'zzz', text: 'x' }]), fails('invalid_input', /names no block/));
  await assert.rejects(tr([{ id: 'ta', translates: 'a', text: 'El consejo aprobó el contrato.', basis: 'allegation', attribution: 'x' }]), fails('invalid_basis', /keeps the basis/));
  await assert.rejects(tr([{ id: 'tb', translates: 'b', text: 'Firmaron de noche.' }]), fails('invalid_basis', /disclosure/));
  const t = await tr([{ id: 'ta', translates: 'a', text: 'El consejo aprobó el contrato.' }, { id: 'tb', translates: 'b', text: 'Firmaron de noche.', disclosure: 'Reconstrucción.' }]);
  assert.deepEqual(t.body.translationOf, { documentId: id, revision: 1 });
  assert.deepEqual(t.body.blocks.map((b) => [b.basis, b.sources]), [['verified_fact', [CLAIM_CONTRACT]], ['reconstruction', [CLAIM_CONTRACT]]]);
  let st = await e.translationStatus(ctx(), id);
  assert.deepEqual(st.translations[0]!.blocks.map((b) => b.state), ['current', 'current']); assert.deepEqual(st.translations[0]!.untranslated, ['c']);
  // the source block a changes; b does not
  const src = (await e.get(ctx(), 'document', id)).body;
  await e.revise(ctx(), 'document', id, { expectedRevision: 1, body: { ...src, blocks: src.blocks.map((b) => (b.id === 'a' ? { ...b, text: 'The council approved the dredging contract.' } : b)) } });
  const flagged = await e.get(ctx(), 'document', t.id);
  assert.equal(flagged.stale, true); assert.deepEqual(flagged.flags.map((f) => [f.blockId, f.changeKind]), [['ta', 'translation_source_changed']]);
  assert.equal(flagged.body.blocks[0]!.text, 'El consejo aprobó el contrato.', 'the translation text is not rewritten');
  st = await e.translationStatus(ctx(), id);
  assert.deepEqual(st.translations[0]!.blocks.map((b) => b.state), ['stale', 'current']);
  assert.equal((await events(e, ctx(), 'editorial.translation_stale'))[0]!.subject, `E09:block:${t.id}.ta@1`);
  // re-pinning to revision 2 with an updated block clears the flag
  const up = await e.revise(ctx(), 'document', t.id, { expectedRevision: 1, body: { title: 'Borrador', editorialProjectId: projectId, docType: 'article', language: 'es', translationOf: { documentId: id, revision: 2 }, blocks: [{ id: 'ta', translates: 'a', text: 'El consejo aprobó el contrato de dragado.' }, { id: 'tb', translates: 'b', text: 'Firmaron de noche.', disclosure: 'Reconstrucción.' }] } });
  assert.equal(up.stale, false);
  assert.equal((await e.listFlags(ctx(), { objectId: t.id, status: 'resolved' }))[0]!.resolution, 'translation_updated');
  // an upstream claim change reaches the translation too, because it inherits the sources
  const out = await e.applyUpstreamChange(ctx(), { eventId: 'evt-t', kind: 'claim_changed', refs: [CLAIM_CONTRACT], reason: 'corrected' });
  assert.ok(out.affected.includes(`E09:block:${t.id}.ta@2`) && out.affected.includes(`E09:block:${id}.a@2`));
  await assert.rejects(e.createTranslation(ctx(), { sourceDocumentId: t.id, language: 'uk', title: 'x', blocks: [] }), fails('invalid_input', /not from another translation/));
}));

test('satirical and campaign work is separated by project kind and labelled in exports', needsPg, () => db(async (sql) => {
  const e = make(sql);
  const factual = await e.create(ctx(), 'editorial_project', { body: project() });
  const satire = await e.create(ctx(), 'editorial_project', { body: project({ title: 'The Dredge Gazette', format: 'satire', projectKind: 'satire', publishingIdentity: 'Example Desk Satire' }) });
  const campaign = await e.create(ctx(), 'editorial_project', { body: project({ title: 'Open the bids', format: 'campaign_piece', projectKind: 'campaign', publishingIdentity: 'Open Harbor Campaign' }) });
  await assert.rejects(e.create(ctx(), 'editorial_project', { body: project({ format: 'satire' }) }), fails('invalid_input', /requires projectKind satire/));
  const joke = block('j', { basis: 'satire', sources: [], disclosure: 'Satirical invention; no such memo exists.', text: 'The council voted to dredge the minutes instead.' });
  const mk = (pid: string, blocks: unknown[]) => e.create(ctx(), 'document', { body: { title: 'Piece', editorialProjectId: pid, docType: 'article', language: 'en', blocks } });
  await assert.rejects(mk(factual.id, [joke]), fails('invalid_basis', /kind satire, not factual/));
  await assert.rejects(mk(campaign.id, [joke]), fails('invalid_basis', /not campaign/));
  await assert.rejects(mk(satire.id, [{ ...joke, disclosure: undefined }]), fails('invalid_basis', /disclosure/));
  const s = await mk(satire.id, [joke, block('f')]);
  const c = await mk(campaign.id, [block('f'), block('ask', { basis: 'invention', sources: [], disclosure: 'Campaign appeal.', text: 'Ask the council to publish the bids.' })]);
  // the kind cannot be relabelled later, and a document cannot be moved into another project
  await assert.rejects(e.revise(ctx(), 'editorial_project', satire.id, { expectedRevision: 1, body: project({ title: 'The Dredge Gazette', format: 'article', projectKind: 'factual', publishingIdentity: 'Example Desk Satire' }) }), fails('invalid_input', /fixed/));
  await assert.rejects(e.revise(ctx(), 'document', s.id, { expectedRevision: 1, body: { ...s.body, editorialProjectId: factual.id } }), fails('invalid_input', /cannot move/));
  const sx = await e.exportDocument(ctx(), s.id, 1), cx = await e.exportDocument(ctx(), c.id, 1);
  assert.equal(sx.manifest.labels.projectKind, 'satire'); assert.equal(sx.manifest.labels.publishingIdentity, 'Example Desk Satire');
  assert.match(sx.renderings.markdown!, /^# Piece\n\n> \*\*Satire\. This work is not a factual report\.\*\*/); assert.match(sx.renderings.markdown!, /Disclosure \(satire\): Satirical invention; no such memo exists\./);
  assert.equal(cx.manifest.labels.notice, 'Campaign material published by Open Harbor Campaign.'); assert.match(cx.renderings.markdown!, /Campaign material published by Open Harbor Campaign\./);
  // series keep one kind
  const series = await e.create(ctx(), 'series', { body: { title: 'Harbor files', projectKind: 'factual', publishingIdentity: 'Example Desk', items: [{ editorialProjectId: factual.id, label: 'Part 1' }] } });
  await assert.rejects(e.revise(ctx(), 'series', series.id, { expectedRevision: 1, body: { ...series.body, items: [...series.body.items, { editorialProjectId: satire.id }] } }), fails('invalid_input', /cannot contain a satire project/));
  const notices = createEngine({ sql, ports: { knowledge: knowledge(), useDecisions: useDecisions() }, config: { notices: { en: { satire: 'SATIRE — invented for comic effect.' } } } });
  assert.match((await notices.exportDocument(ctx(), s.id, 1)).renderings.markdown!, /SATIRE — invented for comic effect\./);
}));

test('permission withdrawal blocks viewpoints, passages, scenes and assets for future use', needsPg, () => db(async (sql) => {
  const e = make(sql);
  const v = await e.create(ctx(), 'viewpoint', { body: viewpoint() });
  const asset = await e.create(ctx(), 'asset', { body: { title: 'Gate photograph', targetRef: 'E05:evidence_version:ev-photo@1', mediaKind: 'image', provenance: 'archival', rightsRef: 'E11:permission:perm-photo@1' } });
  const scene = (assetRefs: string[], over: Record<string, unknown> = {}) => block('s', { type: 'scene', basis: 'reconstruction', sources: [CLAIM_CONTRACT], disclosure: 'Staged.', text: 'At the gate.', data: { purpose: 'Arrival', panels: [{ id: 'p1', description: 'Gate', assetRefs }] }, ...over });
  const p = await e.create(ctx(), 'editorial_project', { body: project() });
  const mk = (blocks: unknown[]) => e.create(ctx(), 'document', { body: { title: 'Film', editorialProjectId: p.id, docType: 'storyboard', language: 'en', blocks } });
  await assert.rejects(mk([scene([`E09:asset:${asset.id}`])]), fails('approval_invalid', /no active approval/));
  await e.requestReview(ctx(), 'asset', asset.id, { expectedRevision: 1 }); await e.approve(editor(), 'asset', asset.id, { revision: 1 });
  const testimony = block('t', { basis: 'attributed_testimony', attribution: 'A dock worker who was present', sources: [SEGMENT_INTERVIEW], viewpointId: v.id, text: 'I saw the trucks.' });
  const d = await mk([testimony, scene([`E09:asset:${asset.id}`]), block('f')]);
  await e.requestReview(ctx(), 'document', d.id, { expectedRevision: 1 }); await e.approve(editor(), 'document', d.id, { revision: 1 });
  assert.deepEqual((await e.usage(ctx(), 'viewpoint', v.id)).usedBy.map((x) => x.blockIds), [['t']]);
  // the participant withdraws
  const out = await e.applyUpstreamChange(ctx(), { eventId: 'evt-w1', kind: 'permission_withdrawn', refs: ['E11:participant:part-1'], reason: 'The participant withdrew consent' });
  assert.ok(out.affected.includes(`E09:viewpoint:${v.id}@1`) && out.affected.includes(`E09:block:${d.id}.t@1`));
  assert.ok(!out.affected.includes(`E09:block:${d.id}.f@1`));
  assert.equal((await e.get(ctx(), 'viewpoint', v.id)).blocked, true);
  const blockedDoc = await e.get(ctx(), 'document', d.id);
  assert.equal(blockedDoc.blocked, true); assert.equal(blockedDoc.body.blocks[0]!.text, 'I saw the trucks.', 'nothing is deleted or rewritten');
  assert.equal((await e.listApprovals(ctx(), 'document', d.id))[0]!.status, 'needs_renewal');
  assert.equal((await e.inspect(ctx(), `E09:block:${d.id}.t`))!.blocked, true);
  assert.deepEqual((await events(e, ctx(), 'editorial.block_blocked')).map((x) => x.subject), [`E09:block:${d.id}.t@1`]);
  assert.equal((await events(e, ctx(), 'editorial.object_blocked'))[0]!.subject, `E09:viewpoint:${v.id}@1`);
  await assert.rejects(e.exportDocument(ctx(), d.id, 1), fails('consent_denied'));
  await assert.rejects(e.resolveFlag(ctx(), blockedDoc.flags[0]!.id, { resolution: 'reviewed_still_accurate', note: 'x' }), fails('invalid_state', /cannot be dismissed/));
  // no new use: another document cannot start using the viewpoint or the withdrawn reference
  await assert.rejects(mk([{ ...testimony, id: 't2' }]), fails('consent_denied'));
  await assert.rejects(mk([block('t3', { basis: 'allegation', sources: ['E11:participant:part-1'] })]), fails('consent_denied', /withdrawn/));
  await assert.rejects(e.create(ctx(), 'viewpoint', { body: viewpoint({ label: 'Again' }) }), fails('consent_denied'));
  // unrelated edits to the blocked document are still possible, and removing the block clears the flag
  const kept = await e.revise(ctx(), 'document', d.id, { expectedRevision: 1, body: { ...blockedDoc.body, title: 'Film, retitled' } });
  assert.equal(kept.blocked, true);
  const cleared = await e.revise(ctx(), 'document', d.id, { expectedRevision: 2, body: { ...kept.body, blocks: kept.body.blocks.filter((b) => b.id !== 't') } });
  assert.equal(cleared.blocked, false);
  assert.equal((await e.exportDocument(ctx(), d.id, 3)).manifest.revision, 3);
  await assert.rejects(e.exportDocument(ctx(), d.id, 1), fails('consent_denied', /withdrawn/), 'the old revision still contains the withdrawn testimony');
  // rights withdrawn on the asset: registry entry and the scene using it are blocked
  const out2 = await e.applyUpstreamChange(ctx(), { eventId: 'evt-w2', kind: 'permission_withdrawn', refs: ['E11:permission:perm-photo'], reason: 'Licence ended' });
  assert.ok(out2.affected.includes(`E09:asset:${asset.id}@1`) && out2.affected.includes(`E09:block:${d.id}.s@3`));
  assert.equal((await e.listApprovals(ctx(), 'asset', asset.id))[0]!.status, 'needs_renewal');
  await assert.rejects(mk([scene([`E09:asset:${asset.id}`], { id: 's9' })]), fails('consent_denied'));
  // rights_changed is a staleness signal, not a block
  const d2 = await mk([block('f2', { sources: [CLAIM_CONTRACT, 'E05:evidence_version:ev-map@1'] })]);
  const out3 = await e.applyUpstreamChange(ctx(), { eventId: 'evt-r', kind: 'rights_changed', refs: ['E05:evidence_version:ev-map@1'], reason: 'Licence narrowed' });
  assert.deepEqual(out3.affected, [`E09:block:${d2.id}.f2@1`]);
  assert.equal((await e.get(ctx(), 'document', d2.id)).blocked, false);
  await assert.rejects(e.applyUpstreamChange(ctx(), { eventId: 'e', kind: 'nonsense' as 'claim_changed', refs: [CLAIM_CONTRACT], reason: 'r' }), fails('invalid_input'));
}));

test('long-lived series, collections, collaborators and reusable approved assets', needsPg, () => db(async (sql) => {
  const e = make(sql);
  const col = await e.create(ctx(), 'collaborator', { body: { name: 'Ilse Varga', roles: ['composer', 'translator'], creditLine: 'Music by Ilse Varga', languages: ['en', 'uk'] } });
  const p1 = await e.create(ctx(), 'editorial_project', { body: project({ title: 'Episode 1', format: 'documentary', credits: [{ collaboratorId: col.id, role: 'composer' }] }) });
  const p2 = await e.create(ctx(), 'editorial_project', { body: project({ title: 'Episode 2', format: 'audio_piece', credits: [{ collaboratorId: col.id, role: 'composer', creditLine: 'Score: I. Varga' }] }) });
  await assert.rejects(e.create(ctx(), 'editorial_project', { body: project({ credits: [{ collaboratorId: '00000000-0000-4000-8000-000000000000', role: 'x' }] }) }), fails('invalid_reference'));
  let series = await e.create(ctx(), 'series', { body: { title: 'Harbor files', projectKind: 'factual', publishingIdentity: 'Example Desk', items: [{ editorialProjectId: p1.id, label: 'Episode 1' }] } });
  series = await e.revise(ctx(), 'series', series.id, { expectedRevision: 1, summary: 'second episode', body: { ...series.body, items: [...series.body.items, { editorialProjectId: p2.id, label: 'Episode 2' }] } });
  assert.equal(series.revision, 2); assert.equal((await e.history(ctx(), 'series', series.id)).length, 2);
  // one approved asset used by documents of both projects
  await assert.rejects(e.create(ctx(), 'asset', { body: { title: 'Fake archive', targetRef: 'E10:asset:gen-1@1', mediaKind: 'image', provenance: 'archival', rightsRef: 'E11:permission:r1' } }), fails('invalid_input', /cannot be registered as archival/));
  const theme = await e.create(ctx(), 'asset', { body: { title: 'Series theme', targetRef: 'E10:asset:theme@2', mediaKind: 'audio', provenance: 'original_production', rightsRef: 'E11:permission:theme-rights@1', tags: ['music'] } });
  const generated = await e.create(ctx(), 'asset', { body: { title: 'Harbor at night (generated)', targetRef: 'E10:asset:gen-harbor@1', mediaKind: 'image', provenance: 'generated', rightsRef: 'E11:permission:gen-rights@1' } });
  for (const a of [theme, generated]) { await e.requestReview(ctx(), 'asset', a.id, { expectedRevision: 1 }); await e.approve(editor(), 'asset', a.id, { revision: 1 }); }
  const scene = (id: string, refs: string[], panel: Record<string, unknown> = {}) => block(id, { type: 'scene', text: 'Opening.', data: { purpose: 'Open', panels: [{ id: 'p1', description: 'Title card', assetRefs: refs, ...panel }] } });
  const mk = (pid: string, blocks: unknown[]) => e.create(ctx(), 'document', { body: { title: 'Board', editorialProjectId: pid, docType: 'storyboard', language: 'en', blocks } });
  const d1 = await mk(p1.id, [scene('s1', [`E09:asset:${theme.id}`])]), d2 = await mk(p2.id, [scene('s1', [`E09:asset:${theme.id}`])]);
  assert.deepEqual((await e.usage(ctx(), 'asset', theme.id)).usedBy.map((u) => u.document).sort(), [`E09:document:${d1.id}@1`, `E09:document:${d2.id}@1`].sort());
  assert.ok((await e.exportDocument(ctx(), d1.id, 1)).manifest.assetRefs.includes('E10:asset:theme@2'), 'the manifest names the underlying E10 asset');
  await assert.rejects(mk(p1.id, [scene('s2', [`E09:asset:${generated.id}`])]), fails('invalid_basis', /cannot pass as archival/));
  await mk(p1.id, [scene('s2', [`E09:asset:${generated.id}`], { disclosure: 'Generated image, not a photograph.' })]);
  await assert.rejects(mk(p1.id, [scene('s3', ['E09:asset:00000000-0000-4000-8000-000000000000'])]), fails('invalid_reference'));
  // revising the asset entry flags its users rather than changing them
  await e.revise(ctx(), 'asset', theme.id, { expectedRevision: 1, body: { ...theme.body, usageNotes: 'Not for trailers.' } });
  const flagged = await e.get(ctx(), 'document', d1.id);
  assert.equal(flagged.stale, true); assert.match(flagged.flags[0]!.reason, /asset was revised/);
  // collections gather any editorial objects
  const coll = await e.create(ctx(), 'collection', { body: { title: 'Festival cut', items: [{ ref: `E09:document:${d1.id}`, note: 'opening' }, { ref: `E09:asset:${theme.id}` }, { ref: `E09:series:${series.id}` }] } });
  assert.equal(coll.body.items.length, 3);
  await assert.rejects(e.create(ctx(), 'collection', { body: { title: 'Bad', items: [{ ref: 'E09:document:00000000-0000-4000-8000-000000000000' }] } }), fails('invalid_reference'));
  assert.deepEqual((await e.list(ctx(), 'editorial_project')).map((s) => s.title), ['Episode 1', 'Episode 2']);
  assert.deepEqual((await e.list(ctx(), 'document', { editorialProjectId: p2.id })).map((s) => s.id), [d2.id]);
  const insp = (await e.inspect(ctx(), `E09:asset:${theme.id}`))!;
  assert.ok(insp.dependents.includes(`E09:document:${d2.id}@1`)); assert.deepEqual(insp.permissions, [{ rightsRef: 'E11:permission:theme-rights@1', restrictions: [] }]); assert.equal(insp.versions.length, 2);
}));

test('comments, suggestions, assignments and machine proposals', needsPg, () => db(async (sql) => {
  const seen: unknown[] = [];
  const e = make(sql, { ports: { knowledge: knowledge(), useDecisions: useDecisions(), model: { propose: async (_c, request) => { seen.push(request); return { model: 'fixture-model', proposals: [
    { text: 'The harbor slept while the paper moved.\u0007', targetBlockId: 'a', rationale: 'more vivid', basis: 'verified_fact', sources: [CLAIM_CONTRACT] } as never,
    { text: 'A closing line.', targetBlockId: 'not-requested' }, { text: '   ' }, { nonsense: true } as never] }; } } } });
  const { id } = await doc(e, [block('a', { text: 'The council approved the contract.' }), block('b', { basis: 'unknown_acknowledged', sources: [], text: 'The reason is unknown.' })]);
  const c = await e.addComment(editor(), 'document', id, { body: 'Check the month.', blockId: 'a' });
  await assert.rejects(e.addComment(editor(), 'document', id, { body: 'x', blockId: 'zzz' }), fails('invalid_input'));
  assert.equal((await e.resolveComment(ctx(), c.id, { status: 'resolved', note: 'checked' })).status, 'resolved');
  await assert.rejects(e.resolveComment(ctx(), c.id, { status: 'resolved' }), fails('invalid_state'));
  // a human suggestion goes through the same rules when accepted
  const bad = await e.suggest(editor(), id, { blockId: 'b', block: { type: 'passage', text: 'The mayor ordered it.', basis: 'verified_fact', sources: [] }, note: 'state it plainly' });
  await assert.rejects(e.acceptSuggestion(ctx(), bad.id, { expectedRevision: 1 }), fails('invalid_basis'));
  assert.equal((await e.get(ctx(), 'document', id)).revision, 1);
  const good = await e.suggest(editor(), id, { afterBlockId: 'a', block: block('n', { basis: 'allegation', attribution: 'A resident', sources: [CLAIM_TIPOFF], text: 'It was decided earlier.' }) });
  const r2 = await e.acceptSuggestion(ctx(), good.id, { expectedRevision: 1 });
  assert.deepEqual(r2.body.blocks.map((b) => b.id), ['a', 'n', 'b']);
  await assert.rejects(e.acceptSuggestion(ctx(), good.id, { expectedRevision: 2 }), fails('invalid_state'));
  // machine proposals: only the text is taken; label is invention with a disclosure and no sources
  const { suggestions, model } = await e.proposeDrafts(ctx(), id, { instruction: 'Make the opening more vivid', blockIds: ['a'], count: 5 });
  assert.equal(model, 'fixture-model'); assert.equal(suggestions.length, 2);
  assert.deepEqual((seen[0] as { blocks: unknown[] }).blocks, [{ id: 'a', type: 'passage', basis: 'verified_fact', text: 'The council approved the contract.' }]);
  const [m1, m2] = suggestions as [typeof suggestions[0], typeof suggestions[0]];
  assert.equal(m1.origin, 'model'); assert.equal(m1.proposal!.mode, 'replace'); assert.equal(m1.proposal!.block.text, 'The harbor slept while the paper moved.');
  assert.equal(m1.proposal!.block.basis, 'invention'); assert.deepEqual(m1.proposal!.block.sources, []); assert.match(m1.proposal!.block.disclosure!, /Machine-proposed/); assert.deepEqual(m1.proposal!.block.generated, { by: 'model', role: 'content', name: 'fixture-model' });
  assert.equal(m2.proposal!.mode, 'insert', 'a target outside the request is ignored');
  assert.equal((await e.get(ctx(), 'document', id)).revision, 2, 'proposals change nothing until accepted');
  // accepted as-is it stays a disclosed invention; a human may relabel and source it, and then the rules apply
  await assert.rejects(e.acceptSuggestion(ctx(), m1.id, { expectedRevision: 2, relabel: { basis: 'verified_fact' } }), fails('invalid_basis', /claim or finding source/));
  const r3 = await e.acceptSuggestion(ctx(), m1.id, { expectedRevision: 2, relabel: { basis: 'verified_fact', sources: [CLAIM_CONTRACT], text: 'The council approved the contract while the harbor slept.' } });
  const a = r3.body.blocks.find((b) => b.id === 'a')!;
  assert.equal(a.basis, 'verified_fact'); assert.equal(a.disclosure, undefined); assert.equal(a.generated!.by, 'model');
  const r4 = await e.acceptSuggestion(ctx(), m2.id, { expectedRevision: 3 });
  assert.equal(r4.body.blocks.at(-1)!.basis, 'invention'); assert.match(r4.body.blocks.at(-1)!.disclosure!, /Machine-proposed/);
  const analytic = await e.proposeDrafts(ctx(), id, { instruction: 'Summarise', mode: 'analytical', count: 1 });
  assert.equal(analytic.suggestions[0]!.proposal!.block.basis, 'inference');
  assert.deepEqual((await e.listComments(ctx(), 'document', id, { kind: 'suggestion' })).map((s) => s.status), ['open', 'accepted', 'accepted', 'accepted', 'open']);
  // assignments
  const asg = await e.assign(ctx(), 'document', id, { assigneeId: 'checker-1', role: 'fact_checker', blockId: 'a', dueAt: '2031-06-01T00:00:00Z' });
  assert.equal((await e.listAssignments(ctx(), { assigneeId: 'checker-1' }))[0]!.id, asg.id);
  assert.equal((await e.updateAssignment(ctx(), asg.id, { status: 'done' })).status, 'done');
  await assert.rejects(e.addComment(ctx({ capabilities: ['editorial:read'] }), 'document', id, { body: 'x' }), fails('forbidden'));
}));

test('tenant, project and compartment isolation', needsPg, () => db(async (sql) => {
  const store = new FsObjectStore(await mkdtemp(join(tmpdir(), 'e09-')));
  const e = make(sql, { objects: store });
  const v = await e.create(ctx(), 'viewpoint', { body: viewpoint() });
  const { id, projectId } = await doc(e, [block('a', { text: 'Zanzibar-marker sentence about the council.' }), block('t', { basis: 'attributed_testimony', attribution: 'A dock worker who was present', sources: [SEGMENT_INTERVIEW], viewpointId: v.id })]);
  await e.requestReview(ctx(), 'document', id, { expectedRevision: 1 }); const approval = await e.approve(editor(), 'document', id, { revision: 1 });
  const exp = await e.exportDocument(ctx(), id, 1);
  const comment = await e.addComment(ctx(), 'document', id, { body: 'note' });
  const sugg = await e.suggest(ctx(), id, { afterBlockId: 'a', block: block('n') });
  const asg = await e.assign(ctx(), 'document', id, { assigneeId: 'x', role: 'editor' });
  await e.applyUpstreamChange(ctx(), { eventId: 'evt-1', kind: 'claim_changed', refs: [CLAIM_CONTRACT], reason: 'r' });
  const flag = (await e.listFlags(ctx()))[0]!;
  for (const other of [ctx({ tenantId: 't2' }), ctx({ projectId: 'p2' }), editor({ tenantId: 't3', projectId: 'p3' })]) {
    for (const kind of ['document', 'editorial_project', 'viewpoint', 'asset', 'series', 'collection', 'collaborator'] as const) assert.deepEqual(await e.list(other, kind), []);
    await assert.rejects(e.get(other, 'document', id), fails('not_found'));
    await assert.rejects(e.get(other, 'viewpoint', v.id), fails('not_found'));
    await assert.rejects(e.history(other, 'document', id), fails('not_found'));
    await assert.rejects(e.diff(other, 'document', id, 1, 1), fails('not_found'));
    await assert.rejects(e.revise(other, 'document', id, { expectedRevision: 1, body: {} }), fails('not_found'));
    await assert.rejects(e.restore(other, 'document', id, { revision: 1, expectedRevision: 1 }), fails('not_found'));
    await assert.rejects(e.requestReview(other, 'document', id, { expectedRevision: 1 }), fails('not_found'));
    await assert.rejects(e.approve(other, 'document', id, { revision: 1 }), fails('not_found'));
    await assert.rejects(e.listApprovals(other, 'document', id), fails('not_found'));
    await assert.rejects(e.factCheck(other, id), fails('not_found'));
    await assert.rejects(e.exportDocument(other, id, 1), fails('not_found'));
    await assert.rejects(e.listExports(other, id), fails('not_found'));
    await assert.rejects(e.translationStatus(other, id), fails('not_found'));
    await assert.rejects(e.createTranslation(other, { sourceDocumentId: id, language: 'es', title: 'x', blocks: [] }), fails('not_found'));
    await assert.rejects(e.listComments(other, 'document', id), fails('not_found'));
    await assert.rejects(e.addComment(other, 'document', id, { body: 'x' }), fails('not_found'));
    await assert.rejects(e.resolveComment(other, comment.id, { status: 'resolved' }), fails('not_found'));
    await assert.rejects(e.acceptSuggestion(other, sugg.id, { expectedRevision: 1 }), fails('not_found'));
    await assert.rejects(e.updateAssignment(other, asg.id, { status: 'done' }), fails('not_found'));
    await assert.rejects(e.resolveFlag(other, flag.id, { resolution: 'revised', note: 'x' }), fails('not_found'));
    await assert.rejects(e.usage(other, 'viewpoint', v.id), fails('not_found'));
    await assert.rejects(e.suggestRhymes(other, { word: 'night', language: 'en', documentId: id }), fails('not_found'));
    await assert.rejects(e.generate(other, { generator: 'outline', editorialProjectId: projectId, package: investigationPackage() }), fails('invalid_reference'));
    await assert.rejects(e.create(other, 'document', { body: { title: 'x', editorialProjectId: projectId, docType: 'article', language: 'en', blocks: [] } }), fails('invalid_reference'));
    await assert.rejects(e.create(other, 'collection', { body: { title: 'x', items: [{ ref: `E09:document:${id}` }] } }), fails('invalid_reference'));
    assert.deepEqual(await e.listFlags(other), []); assert.deepEqual(await e.listAssignments(other), []);
    assert.deepEqual(await e.search(other, { q: 'zanzibar' }), []);
    assert.deepEqual(await e.audit(other), []);
    assert.deepEqual(await e.events(other), []);
    for (const ref of [`E09:document:${id}`, `E09:block:${id}.a`, `E09:viewpoint:${v.id}`, approval.ref]) assert.equal(await e.inspect(other, ref), null);
    // another scope's upstream change with the same refs and even the same event id touches nothing here
    assert.deepEqual((await e.applyUpstreamChange(other, { eventId: 'evt-1', kind: 'permission_withdrawn', refs: [CLAIM_CONTRACT, SEGMENT_INTERVIEW], reason: 'r' })).affected, []);
  }
  assert.equal((await e.get(ctx(), 'document', id)).blocked, false, 'the other scope\'s withdrawal did not leak in');
  assert.equal((await e.listFlags(ctx())).length, 1);
  assert.equal((await e.search(ctx(), { q: 'ZANZIBAR' }))[0]!.ref, `E09:document:${id}@1`);
  assert.deepEqual(await store.list('t2/'), []); assert.equal((await store.list('t1/p1/')).length, 1); assert.ok(exp.manifest.objectKey);
  assert.equal(await e.inspect(ctx(), 'E05:evidence:x'), null); assert.equal(await e.inspect(ctx(), 'garbage'), null);
  // compartments: hidden objects are indistinguishable from missing ones
  const inside = ctx({ compartments: ['source-protection'] });
  const secret = await e.create(inside, 'document', { compartment: 'source-protection', body: { title: 'Protected draft', editorialProjectId: projectId, docType: 'article', language: 'en', blocks: [block('x', { text: 'Quetzal-marker protected line.' })] } });
  await assert.rejects(e.create(ctx(), 'document', { compartment: 'source-protection', body: secret.body }), fails('forbidden'));
  await assert.rejects(e.get(ctx(), 'document', secret.id), fails('not_found'));
  assert.equal(await e.inspect(ctx(), secret.ref), null);
  assert.deepEqual(await e.search(ctx(), { q: 'quetzal' }), []);
  assert.ok(!(await e.list(ctx(), 'document')).some((s) => s.id === secret.id));
  assert.equal((await e.search(inside, { q: 'quetzal' })).length, 1);
  const tr = await e.createTranslation(inside, { sourceDocumentId: secret.id, language: 'es', title: 'Protegido', blocks: [{ id: 'tx', translates: 'x', text: 'Línea protegida.' }] });
  assert.equal(tr.compartment, 'source-protection', 'a translation inherits the compartment of its source');
  // the audit chain of the tenant verifies
  const { verifyAuditChain, listAudit } = await import('../src/service-kit.ts');
  assert.ok(verifyAuditChain(await listAudit(sql, 'e09_editorial', ctx(), { allProjects: true, limit: 1000 })));
}));
