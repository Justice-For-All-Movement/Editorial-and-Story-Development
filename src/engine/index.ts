// E09 — Editorial and story development engine: service layer.
// Revisioned editorial objects (series, collections, editorial projects, collaborators, viewpoints, reusable assets,
// documents made of basis-labelled blocks), review and approvals bound to exact revisions, translations, fact-check
// ledger, generators, exports and stale/blocked propagation.
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import {
  SERVICE_KIT_VERSION, appendAudit, emitEvent, idempotent, listAudit, parseUref, readEvents, requireCapability, runMigrations, standardRoutes, uref,
} from '../service-kit.ts';
import type { AuditRecord, AuthorizationPort, EngineEvent, EngineManifestV1, HttpResponse, Inspection, Migration, ObjectStore, Route, SearchHit, ServiceContext, Sql, StandardEngine, UpstreamChange, UseAction, UseDecisionPort } from '../service-kit.ts';
import {
  BASES, DEFAULT_FORMATS, DISCLOSED_BASES, DOWNGRADE_TARGETS, FACTUAL_BASES, KINDS, UUID, blockHash, bodyDigest, checkBasisRules, clean, diffBlocks, diffJson, isRec, language as languageTag,
  normalizeBlock, normalizeBody, oneOf, optStr, pack, panelsOf, posInt, rec, str, strList, titleOf, uuid,
} from './model.ts';
import type { AssetBody, Basis, Block, BlockDiff, Bodies, CollaboratorBody, CollectionBody, DocumentBody, FieldChange, Kind, ProjectBody, SeriesBody, ViewpointBody } from './model.ts';
import { GENERATORS, generate as runGenerator, parsePackage, vocabulary } from './generators.ts';
import type { GeneratorName, Templates } from './generators.ts';
import { analyzeLyrics as analyze, countSyllables, languageData, suggestRhymes as rhymes } from './lyrics.ts';
import type { LanguageSet, LyricAnalysis, RhymeSuggestion } from './lyrics.ts';
import { EXPORT_FORMATS, collectDisclosures, defaultFormats, renderFountain, renderGraph, renderLyricSheet, renderMarkdown } from './render.ts';
import type { ExportBlock, ExportDocument, ExportFormat } from './render.ts';
import type { ClaimStatus, KnowledgePort, ModelPort } from './ports.ts';

export * from './model.ts';
export * from './ports.ts';
export { GENERATORS, DEFAULT_TEMPLATES, parsePackage } from './generators.ts';
export type { GeneratorName, Templates } from './generators.ts';
export { BUILTIN_LANGUAGES } from './lyrics.ts';
export type { LanguageData, LanguageSet, LyricAnalysis, RhymeSuggestion } from './lyrics.ts';
export { EXPORT_FORMATS } from './render.ts';
export type { ExportDocument, ExportFormat } from './render.ts';

export const SCHEMA = 'e09_editorial';
const EID = 'E09';
const S = SCHEMA;
export const manifest: EngineManifestV1 = {
  id: EID, name: 'editorial-and-story-development', version: '1.0.0', kit: SERVICE_KIT_VERSION,
  capabilities: ['editorial:read', 'editorial:write', 'editorial:comment', 'editorial:approve', 'editorial:export', 'editorial:events'],
  emits: ['editorial.document_revised', 'editorial.object_revised', 'editorial.review_requested', 'editorial.review_returned', 'editorial.approved', 'editorial.block_stale', 'editorial.block_blocked', 'editorial.object_stale', 'editorial.object_blocked', 'editorial.approval_invalidated', 'editorial.translation_stale', 'editorial.suggestion_proposed', 'editorial.exported'],
  consumes: ['source_corrected', 'source_superseded', 'source_removed', 'claim_changed', 'content_changed', 'render_changed', 'audience_changed', 'rights_changed', 'permission_changed', 'permission_withdrawn'],
};

export const migrations: readonly Migration[] = [{ id: '001_editorial', sql: `
create table {s}.objects (
  tenant_id text not null, project_id text not null, id uuid not null, kind text not null,
  revision int not null, state text not null, title text not null, compartment text,
  editorial_project_id uuid, parent_document_id uuid, language text, doc_type text, search_text text not null default '',
  created_at timestamptz not null, created_by text not null, updated_at timestamptz not null,
  primary key (tenant_id, project_id, id)
);
create index objects_kind on {s}.objects (tenant_id, project_id, kind, updated_at desc);
create index objects_parent on {s}.objects (tenant_id, project_id, parent_document_id) where parent_document_id is not null;
create table {s}.revisions (
  tenant_id text not null, project_id text not null, object_id uuid not null, revision int not null,
  body jsonb not null, digest text not null, summary text, review_state text not null default 'draft',
  restored_from int, actor_id text not null, at timestamptz not null,
  primary key (tenant_id, project_id, object_id, revision)
);
create table {s}.links (
  tenant_id text not null, project_id text not null, object_id uuid not null, revision int not null,
  block_id text not null default '', role text not null, ref text not null,
  ref_engine text not null, ref_kind text not null, ref_id text not null, ref_rev int
);
create index links_ref on {s}.links (tenant_id, project_id, ref_engine, ref_kind, ref_id);
create index links_object on {s}.links (tenant_id, project_id, object_id, revision);
create table {s}.approvals (
  tenant_id text not null, project_id text not null, id uuid not null, object_id uuid not null, revision int not null,
  digest text not null, status text not null, approver_id text not null, note text, at timestamptz not null,
  invalidated_reason text, invalidated_cause text, invalidated_at timestamptz,
  primary key (tenant_id, project_id, id)
);
create index approvals_object on {s}.approvals (tenant_id, project_id, object_id, revision);
create table {s}.flags (
  tenant_id text not null, project_id text not null, id uuid not null, object_id uuid not null, block_id text not null default '',
  revision int not null, kind text not null check (kind in ('stale','blocked')), reason text not null, cause text not null, ref text not null,
  change_kind text not null, status text not null default 'open', created_at timestamptz not null,
  resolved_at timestamptz, resolved_by text, resolution text, note text,
  primary key (tenant_id, project_id, id),
  unique (tenant_id, project_id, object_id, block_id, kind, cause, ref)
);
create index flags_object on {s}.flags (tenant_id, project_id, object_id, status);
create table {s}.withdrawn_refs (
  tenant_id text not null, project_id text not null, ref_engine text not null, ref_kind text not null, ref_id text not null,
  cause text not null, reason text not null, at timestamptz not null,
  primary key (tenant_id, project_id, ref_engine, ref_kind, ref_id)
);
create table {s}.comments (
  tenant_id text not null, project_id text not null, id uuid not null, object_id uuid not null, revision int not null, block_id text,
  kind text not null check (kind in ('comment','suggestion')), body text not null, proposal jsonb, origin text not null,
  status text not null default 'open', author_id text not null, created_at timestamptz not null,
  resolved_by text, resolved_at timestamptz, resolution_note text, applied_revision int,
  primary key (tenant_id, project_id, id)
);
create index comments_object on {s}.comments (tenant_id, project_id, object_id, created_at);
create table {s}.assignments (
  tenant_id text not null, project_id text not null, id uuid not null, object_id uuid not null, block_id text,
  assignee_id text not null, role text not null, note text, due_at timestamptz, status text not null default 'open',
  created_by text not null, created_at timestamptz not null, updated_at timestamptz not null,
  primary key (tenant_id, project_id, id)
);
create table {s}.exports (
  tenant_id text not null, project_id text not null, id uuid not null, object_id uuid not null, revision int not null,
  formats text[] not null, manifest jsonb not null, digest text not null, object_key text, actor_id text not null, at timestamptz not null,
  primary key (tenant_id, project_id, id)
);
create table {s}.upstream_events (
  tenant_id text not null, project_id text not null, event_id text not null, kind text not null, result jsonb not null, at timestamptz not null,
  primary key (tenant_id, project_id, event_id)
);
` }];
export function migrate(sql: Sql): Promise<string[]> { return runMigrations(sql, SCHEMA, migrations); }

// ───────────────────────────── public types ─────────────────────────────
export type EditorialConfig = Readonly<{
  /** Documented standalone modes. Without the port AND without the matching flag the protective check denies (unavailable). */
  standalone?: Readonly<{ knowledge?: boolean; useDecisions?: boolean }>;
  /** Default false: the approver must differ from the author of the approved revision. */
  allowSelfApproval?: boolean;
  formats?: readonly string[];
  /** `E07:claim*`-style patterns. Defaults: E07:claim*, E08:finding* (fact) and E02:*, E05:*, E06:*, E07:testimony* (testimony). */
  factSourcePatterns?: readonly string[]; testimonySourcePatterns?: readonly string[];
  supportedFactualValues?: readonly string[];
  languages?: LanguageSet; lexicons?: Readonly<Record<string, readonly string[]>>;
  templates?: Readonly<Record<string, Templates>>;
  notices?: Readonly<Record<string, Readonly<{ satire?: string; campaign?: string; modelDisclosure?: string }>>>;
}>;
export type EditorialPorts = Readonly<{ knowledge?: KnowledgePort; useDecisions?: UseDecisionPort; authorization?: AuthorizationPort; model?: ModelPort }>;
export type EditorialDeps = Readonly<{ sql: Sql; objects?: ObjectStore; ports?: EditorialPorts; config?: EditorialConfig }>;

export type Flag = { id: string; objectId: string; blockId: string | null; kind: 'stale' | 'blocked'; reason: string; cause: string; ref: string; changeKind: string; status: 'open' | 'resolved'; revision: number; createdAt: string; resolvedAt: string | null; resolvedBy: string | null; resolution: string | null; note: string | null };
export type Stored<K extends Kind = Kind> = { ref: string; id: string; kind: K; revision: number; currentRevision: number; state: string; title: string; compartment: string | null; body: Bodies[K]; digest: string; summary: string | null; actorId: string; at: string; restoredFrom: number | null; createdAt: string; stale: boolean; blocked: boolean; flags: Flag[] };
export type Summary = { ref: string; id: string; kind: Kind; revision: number; state: string; title: string; docType: string | null; language: string | null; editorialProjectId: string | null; translationOf: string | null; stale: boolean; blocked: boolean; updatedAt: string };
export type RevisionInfo = { revision: number; at: string; actorId: string; summary: string | null; reviewState: string; digest: string; restoredFrom: number | null };
export type Approval = { id: string; ref: string; objectRef: string; revision: number; digest: string; status: 'active' | 'needs_renewal' | 'superseded'; approverId: string; note: string | null; at: string; invalidatedReason: string | null; invalidatedCause: string | null };
export type Comment = { id: string; objectId: string; revision: number; blockId: string | null; kind: 'comment' | 'suggestion'; body: string; proposal: SuggestionProposal | null; origin: 'human' | 'model'; status: 'open' | 'resolved' | 'accepted' | 'rejected'; authorId: string; createdAt: string; resolvedBy: string | null; resolvedAt: string | null; resolutionNote: string | null; appliedRevision: number | null };
export type SuggestionProposal = { mode: 'replace' | 'insert'; blockId?: string; afterBlockId?: string; block: Block };
export type Assignment = { id: string; objectId: string; blockId: string | null; assigneeId: string; role: string; note: string | null; dueAt: string | null; status: 'open' | 'done' | 'cancelled'; createdBy: string; createdAt: string; updatedAt: string };
export type SaveOptions = { summary?: string; idempotencyKey?: string; unsupportedFacts?: 'reject' | 'downgrade'; downgradeTo?: Basis; resolveFlagIds?: readonly string[] };
export type FactStatement = { blockId: string; ref: string; type: string; basis: Basis; text: string; attribution: string | null; uncertainty: string | null; status: 'supported' | 'not_checked' | 'sourced' | 'unsourced' | 'attention'; sources: { ref: string; selector: Json | null; role: 'fact' | 'testimony' | 'other'; current: ClaimStatus | 'unknown_claim' | 'not_checked' | null }[]; saved: Json | null; flags: Flag[] };
export type FactCheck = { document: string; revision: number; knowledge: 'port' | 'standalone_not_checked'; summary: { blocks: number; byBasis: Record<string, number>; factual: number; unsourced: number; attention: number }; statements: FactStatement[]; unsourced: string[]; declared: { blockId: string; basis: Basis; disclosure: string | null; generatedRole: string | null }[] };
export type ExportManifest = { exportId: string; engine: string; engineVersion: string; document: string; revision: number; contentDigest: string; reviewState: string; approval: { id: string; status: string; approverId: string; at: string } | null; formats: ExportFormat[]; renderingDigests: Record<string, string>; sourceRefs: string[]; assetRefs: string[]; viewpointRefs: string[]; packageRefs: string[]; translationOf: string | null; labels: ExportDocument['labels']; credits: ExportDocument['credits']; disclosures: ExportDocument['disclosures']; openFlags: { blockId: string | null; kind: string; reason: string; cause: string }[]; useDecisions: Json[]; intendedUse: UseAction; exportedAt: string; exportedBy: string; objectKey: string | null };
export type ExportResult = { manifest: ExportManifest; document: ExportDocument; renderings: { markdown?: string; fountain?: string; lyricSheet?: string; graph?: Json } };
export type DiffResult = { ref: string; from: number; to: number; fields: FieldChange[]; blocks: BlockDiff | null };

type ObjRow = { id: string; kind: Kind; revision: number; state: string; title: string; compartment: string | null; editorial_project_id: string | null; parent_document_id: string | null; language: string | null; doc_type: string | null; created_at: Date; updated_at: Date };
type RevRow = { revision: number; body: Bodies[Kind]; digest: string; summary: string | null; review_state: string; restored_from: number | null; actor_id: string; at: Date };
type Loaded = { o: ObjRow; r: RevRow };
type Link = { blockId: string; role: string; ref: string };
const iso = (v: unknown): string => new Date(v as string).toISOString();
const isoN = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const notFound = (): never => { throw new DomainError('not_found', 'Not found'); };
const pattern = (patterns: readonly string[]) => (ref: string): boolean => {
  let p: { engine: string; kind: string }; try { p = parseUref(ref); } catch { return false; }
  return patterns.some((x) => { const [e, k = '*'] = x.split(':'); return e === p.engine && (k.endsWith('*') ? p.kind.startsWith(k.slice(0, -1)) : p.kind === k); });
};
const blockRef = (docId: string, blockId: string, revision?: number): string => `${EID}:block:${docId}.${blockId}${revision === undefined ? '' : `@${revision}`}`;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const toFlag = (r: Record<string, unknown>): Flag => ({ id: r.id as string, objectId: r.object_id as string, blockId: r.block_id === '' ? null : r.block_id as string, kind: r.kind as Flag['kind'], reason: r.reason as string, cause: r.cause as string, ref: r.ref as string, changeKind: r.change_kind as string, status: r.status as Flag['status'], revision: r.revision as number, createdAt: iso(r.created_at), resolvedAt: isoN(r.resolved_at), resolvedBy: (r.resolved_by as string | null) ?? null, resolution: (r.resolution as string | null) ?? null, note: (r.note as string | null) ?? null });
const toComment = (r: Record<string, unknown>): Comment => ({ id: r.id as string, objectId: r.object_id as string, revision: r.revision as number, blockId: (r.block_id as string | null) ?? null, kind: r.kind as Comment['kind'], body: r.body as string, proposal: (r.proposal as SuggestionProposal | null) ?? null, origin: r.origin as Comment['origin'], status: r.status as Comment['status'], authorId: r.author_id as string, createdAt: iso(r.created_at), resolvedBy: (r.resolved_by as string | null) ?? null, resolvedAt: isoN(r.resolved_at), resolutionNote: (r.resolution_note as string | null) ?? null, appliedRevision: (r.applied_revision as number | null) ?? null });
const toAssignment = (r: Record<string, unknown>): Assignment => ({ id: r.id as string, objectId: r.object_id as string, blockId: (r.block_id as string | null) ?? null, assigneeId: r.assignee_id as string, role: r.role as string, note: (r.note as string | null) ?? null, dueAt: isoN(r.due_at), status: r.status as Assignment['status'], createdBy: r.created_by as string, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });

export type EditorialEngine = ReturnType<typeof createEngine>;

export function createEngine(deps: EditorialDeps) {
  const { sql } = deps;
  const ports = deps.ports ?? {};
  const cfg = deps.config ?? {};
  const formats = cfg.formats ?? DEFAULT_FORMATS;
  const isFact = pattern(cfg.factSourcePatterns ?? ['E07:claim*', 'E08:finding*']);
  const isTestimony = pattern(cfg.testimonySourcePatterns ?? ['E02:*', 'E05:*', 'E06:*', 'E07:testimony*']);
  const supported = cfg.supportedFactualValues ?? ['supported'];
  const claimOk = (s: ClaimStatus | null): boolean => s !== null && supported.includes(s.factual) && !s.stale && !s.blocked;
  const notice = (lang: string, key: 'satire' | 'campaign' | 'modelDisclosure'): string => cfg.notices?.[lang]?.[key] ?? cfg.notices?.[lang.split('-')[0] as string]?.[key]
    ?? { satire: 'Satire. This work is not a factual report.', campaign: 'Campaign material published by {identity}.', modelDisclosure: 'Machine-proposed draft text. It is not sourced and has not been verified.' }[key];
  const templatesFor = (lang: string): Templates => cfg.templates?.[lang] ?? cfg.templates?.[lang.split('-')[0] as string] ?? {};

  const idem = <T>(tx: Sql, ctx: ServiceContext, key: string | undefined, input: unknown, fn: () => Promise<T>): Promise<T> =>
    idempotent(tx, S, ctx, key, input, async () => clean(await fn()) as unknown as Json) as unknown as Promise<T>;
  const scope = (ctx: ServiceContext): [string, string] => [ctx.tenantId, ctx.projectId];

  async function load(q: Sql, ctx: ServiceContext, kind: Kind | null, id: string, opt: { revision?: number; lock?: boolean; system?: boolean } = {}): Promise<Loaded | null> {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    const o = (await q.query<ObjRow>(`select * from ${S}.objects where tenant_id=$1 and project_id=$2 and id=$3 and ($4::text is null or kind=$4)${opt.lock === true ? ' for update' : ''}`, [...scope(ctx), id, kind]))[0];
    if (o === undefined) return null;
    if (opt.system !== true && o.compartment !== null && !ctx.compartments.includes(o.compartment)) return null;
    if (opt.revision !== undefined && !(Number.isSafeInteger(opt.revision) && opt.revision > 0)) return null;
    const r = (await q.query<RevRow>(`select revision, body, digest, summary, review_state, restored_from, actor_id, at from ${S}.revisions where tenant_id=$1 and project_id=$2 and object_id=$3 and revision=$4`, [...scope(ctx), id, opt.revision ?? o.revision]))[0];
    return r === undefined ? null : { o, r };
  }
  async function need<K extends Kind>(q: Sql, ctx: ServiceContext, kind: K, id: string, opt: { revision?: number; lock?: boolean } = {}): Promise<Loaded & { r: RevRow & { body: Bodies[K] } }> {
    return (await load(q, ctx, kind, id, opt) ?? notFound()) as Loaded & { r: RevRow & { body: Bodies[K] } };
  }
  async function openFlags(q: Sql, ctx: ServiceContext, objectId: string): Promise<Flag[]> {
    return (await q.query(`select * from ${S}.flags where tenant_id=$1 and project_id=$2 and object_id=$3 and status='open' order by created_at, id`, [...scope(ctx), objectId])).map(toFlag);
  }
  async function stored<K extends Kind>(q: Sql, ctx: ServiceContext, l: Loaded): Promise<Stored<K>> {
    const flags = await openFlags(q, ctx, l.o.id);
    return { ref: uref(EID, l.o.kind, l.o.id, l.r.revision), id: l.o.id, kind: l.o.kind as K, revision: l.r.revision, currentRevision: l.o.revision, state: l.r.review_state, title: titleOf(l.o.kind, l.r.body), compartment: l.o.compartment, body: l.r.body as Bodies[K], digest: l.r.digest, summary: l.r.summary, actorId: l.r.actor_id, at: iso(l.r.at), restoredFrom: l.r.restored_from, createdAt: iso(l.o.created_at), stale: flags.some((f) => f.kind === 'stale'), blocked: flags.some((f) => f.kind === 'blocked'), flags };
  }
  async function isWithdrawn(q: Sql, ctx: ServiceContext, refs: readonly string[]): Promise<string | null> {
    for (const ref of refs) {
      const p = parseUref(ref);
      if ((await q.query(`select 1 from ${S}.withdrawn_refs where tenant_id=$1 and project_id=$2 and ref_engine=$3 and ref_kind=$4 and ref_id=$5`, [...scope(ctx), p.engine, p.kind, p.id])).length > 0) return ref;
    }
    return null;
  }
  async function hasBlockedFlag(q: Sql, ctx: ServiceContext, objectId: string): Promise<boolean> {
    return (await q.query(`select 1 from ${S}.flags where tenant_id=$1 and project_id=$2 and object_id=$3 and status='open' and kind='blocked' and block_id='' limit 1`, [...scope(ctx), objectId])).length > 0;
  }
  /** Consults E11 for adapting/publishing testimony-based material. Denies when the port is absent and standalone mode is not selected. */
  async function useDecision(ctx: ServiceContext, subjects: readonly string[], action: UseAction, extra: { audience?: string; territory?: string; destination?: string } = {}): Promise<Json> {
    if (ports.useDecisions === undefined) {
      if (cfg.standalone?.useDecisions !== true) throw new DomainError('unavailable', 'A use-decision service (UseDecisionPort) is required before testimony-based material can be used; none is configured');
      return { decision: 'not_checked', mode: 'standalone', subjects: [...subjects], action };
    }
    const d = await ports.useDecisions.decide(ctx, { subjects, action, purpose: ctx.purpose, ...extra });
    if (d.decision === 'deny') throw new DomainError('consent_denied', `Use decision denies ${action}: ${d.reasons.join('; ') || 'no reason given'}`);
    return { decision: d.decision, reasons: [...d.reasons], permissionRefs: [...d.permissionRefs], restrictions: [...d.restrictions], decidedAt: d.decidedAt, subjects: [...subjects], action };
  }

  // ───────────────────────────── preparation (validation with collaborators) ─────────────────────────────
  type Prepared = { body: Bodies[Kind]; links: Link[]; cols: { editorialProjectId: string | null; parentDocumentId: string | null; language: string | null; docType: string | null }; search: string };
  const noCols = { editorialProjectId: null, parentDocumentId: null, language: null, docType: null };

  async function prepareDocument(tx: Sql, ctx: ServiceContext, rawIn: unknown, o: SaveOptions, prior: Loaded | null): Promise<Prepared> {
    let raw = rawIn;
    let source: Loaded | null = null;
    if (isRec(raw) && isRec(raw.translationOf)) {
      const t = raw.translationOf;
      source = typeof t.documentId === 'string' && Number.isSafeInteger(t.revision) ? await load(tx, ctx, 'document', t.documentId, { revision: t.revision as number }) : null;
      invariant(source !== null, 'invalid_reference', 'translationOf names no document revision');
      invariant((source.r.body as DocumentBody).translationOf === undefined, 'invalid_input', 'A translation is made from an original document, not from another translation');
      const src = new Map((source.r.body as DocumentBody).blocks.map((b) => [b.id, b]));
      if (Array.isArray(raw.blocks)) raw = { ...raw, blocks: raw.blocks.map((b) => { if (!isRec(b) || typeof b.translates !== 'string') return b; const s = src.get(b.translates); invariant(s !== undefined, 'invalid_input', `block ${String(b.id)}: translates names no block of the source revision`); return { type: s.type, basis: s.basis, sources: s.sources, ...(s.sourceSelectors === undefined ? {} : { sourceSelectors: s.sourceSelectors }), ...(s.viewpointId === undefined ? {} : { viewpointId: s.viewpointId }), data: s.data, ...b }; }) };
    }
    const body = normalizeBody('document', raw, formats);
    const project = await load(tx, ctx, 'editorial_project', body.editorialProjectId);
    invariant(project !== null, 'invalid_reference', 'Unknown editorial project');
    const projectKind = (project.r.body as ProjectBody).projectKind;
    if (prior !== null) {
      const p = prior.r.body as DocumentBody;
      invariant(p.editorialProjectId === body.editorialProjectId && p.docType === body.docType, 'invalid_input', 'A document cannot move to another editorial project or change its type; create a new document');
      invariant((p.translationOf?.documentId ?? null) === (body.translationOf?.documentId ?? null), 'invalid_input', 'translationOf.documentId cannot change');
    }
    if (source !== null) {
      const src = new Map((source.r.body as DocumentBody).blocks.map((b) => [b.id, b]));
      const seen = new Set<string>();
      for (const b of body.blocks) {
        if (b.translates === undefined) continue;
        const s = src.get(b.translates) as Block;
        invariant(!seen.has(b.translates), 'invalid_input', `block ${b.id}: source block ${b.translates} is already translated by another block`); seen.add(b.translates);
        if (b.basis !== s.basis || b.type !== s.type || [...b.sources].sort().join('|') !== [...s.sources].sort().join('|')) throw new DomainError('invalid_basis', `block ${b.id}: a translation keeps the basis label, type and sources of its source block`);
        invariant(s.attribution === undefined || b.attribution !== undefined, 'invalid_basis', `block ${b.id}: the source block is attributed; the translation must carry the attribution`);
        invariant(s.disclosure === undefined || b.disclosure !== undefined, 'invalid_basis', `block ${b.id}: the source block carries a disclosure; the translation must carry it too`);
        b.sourceHash = blockHash(s);
      }
    }
    const { data: langData } = languageData(body.language, cfg.languages);
    const priorBlocks = new Map((prior === null ? [] : (prior.r.body as DocumentBody).blocks).map((b) => [b.id, b]));
    const viewpoints = new Map<string, { body: ViewpointBody; blocked: boolean }>();
    for (const id of new Set(body.blocks.map((b) => b.viewpointId).filter((x): x is string => x !== undefined))) {
      const v = await load(tx, ctx, 'viewpoint', id);
      invariant(v !== null, 'invalid_reference', 'Unknown viewpoint');
      viewpoints.set(id, { body: v.r.body as ViewpointBody, blocked: await hasBlockedFlag(tx, ctx, id) });
    }
    const assets = new Map<string, { body: AssetBody; blocked: boolean; approved: boolean }>();
    for (const ref of new Set(body.blocks.flatMap((b) => panelsOf(b).flatMap((p) => p.assetRefs)))) {
      const p = parseUref(ref);
      if (p.engine !== EID) continue;
      const a = p.kind === 'asset' ? await load(tx, ctx, 'asset', p.id) : null;
      invariant(a !== null, 'invalid_reference', `Unknown registered asset ${ref}`);
      const approved = (await tx.query(`select 1 from ${S}.approvals where tenant_id=$1 and project_id=$2 and object_id=$3 and status='active' limit 1`, [...scope(ctx), p.id])).length > 0;
      assets.set(ref, { body: a.r.body as AssetBody, blocked: await hasBlockedFlag(tx, ctx, p.id), approved });
    }
    const links: Link[] = [];
    const changed: Block[] = [];
    const blockLinks = (b: Block): Link[] => {
      const out: Link[] = b.sources.map((ref) => ({ blockId: b.id, role: 'source', ref }));
      if (b.viewpointId !== undefined) { const v = (viewpoints.get(b.viewpointId) as { body: ViewpointBody }).body; out.push({ blockId: b.id, role: 'viewpoint', ref: uref(EID, 'viewpoint', b.viewpointId) }, ...[v.participantRef, v.consentRef, ...v.testimonyRefs].map((ref) => ({ blockId: b.id, role: 'viewpoint_dep', ref }))); }
      for (const p of panelsOf(b)) for (const ref of p.assetRefs) { out.push({ blockId: b.id, role: 'asset', ref }); const a = assets.get(ref); if (a !== undefined) out.push({ blockId: b.id, role: 'asset_dep', ref: a.body.targetRef }, { blockId: b.id, role: 'asset_dep', ref: a.body.rightsRef }); }
      if (b.type === 'interview_question') for (const c of b.data.consentPrerequisites as string[]) { try { parseUref(c); out.push({ blockId: b.id, role: 'consent', ref: c }); } catch { /* free-text prerequisite */ } }
      return out;
    };
    for (const b of body.blocks) {
      if (b.type === 'lyric_section') {
        const lines = b.text.split(/\r?\n/).filter((l) => l.trim() !== '');
        const given = b.data.syllables as number[] | undefined;
        invariant(given === undefined || given.length === lines.length, 'invalid_input', `block ${b.id}: syllables must give one count per non-empty line`);
        if (given === undefined) b.data = { ...b.data, syllables: lines.map((l) => countSyllables(l, langData)) };
      }
      const vp = b.viewpointId === undefined ? undefined : viewpoints.get(b.viewpointId);
      checkBasisRules(b, { projectKind, isFactSource: isFact, isTestimonySource: isTestimony, viewpointTestimony: vp?.body.testimonyRefs });
      for (const p of panelsOf(b)) for (const ref of p.assetRefs) { const a = assets.get(ref); if (a !== undefined && (a.body.provenance === 'generated' || a.body.provenance === 'reconstruction') && p.disclosure === undefined && b.disclosure === undefined) throw new DomainError('invalid_basis', `block ${b.id}: panel ${p.id} uses a ${a.body.provenance} asset and needs a disclosure; generated material cannot pass as archival evidence`); }
      const pb = priorBlocks.get(b.id);
      if (pb !== undefined && blockHash(pb) === blockHash(b)) { if (pb.verification !== undefined) b.verification = pb.verification; if (b.downgraded === undefined && pb.downgraded !== undefined) b.downgraded = pb.downgraded; }
      else changed.push(b);
    }
    // Newly written or changed blocks may not start depending on blocked or withdrawn material.
    for (const b of changed) {
      const bl = blockLinks(b);
      if (b.viewpointId !== undefined && (viewpoints.get(b.viewpointId) as { blocked: boolean }).blocked) throw new DomainError('consent_denied', `block ${b.id}: the viewpoint is blocked after a permission was withdrawn`);
      for (const p of panelsOf(b)) for (const ref of p.assetRefs) { const a = assets.get(ref); if (a === undefined) continue; if (a.blocked) throw new DomainError('consent_denied', `block ${b.id}: asset ${ref} is blocked`); invariant(a.approved, 'approval_invalid', `block ${b.id}: asset ${ref} has no active approval in the asset registry`); }
      const w = await isWithdrawn(tx, ctx, bl.map((l) => l.ref));
      if (w !== null) throw new DomainError('consent_denied', `block ${b.id}: permission for ${w} was withdrawn`);
    }
    // verified_fact: factual assessment of every cited claim must be supported.
    const statusCache = new Map<string, ClaimStatus | null>();
    for (const b of changed.filter((x) => x.basis === 'verified_fact')) {
      const claimRefs = b.sources.filter((s) => parseUref(s).engine === 'E07' && isFact(s));
      if (ports.knowledge === undefined) {
        if (cfg.standalone?.knowledge !== true) throw new DomainError('unavailable', 'A knowledge service (KnowledgePort) is required to label a block verified_fact; none is configured');
        b.verification = { ...(b.verification ?? {}), knowledge: { mode: 'standalone', status: 'not_checked' }, checkedAt: ctx.now };
        continue;
      }
      const results: { ref: string; status: ClaimStatus | null }[] = [];
      for (const ref of claimRefs) { if (!statusCache.has(ref)) statusCache.set(ref, await ports.knowledge.getClaimStatus(ctx, ref)); results.push({ ref, status: statusCache.get(ref) ?? null }); }
      const bad = results.filter((r) => !claimOk(r.status));
      if (bad.length === 0) { b.verification = { ...(b.verification ?? {}), knowledge: { mode: 'port', status: claimRefs.length === 0 ? 'no_claim_source_to_check' : 'supported', claims: results as unknown as Json }, checkedAt: ctx.now }; continue; }
      const why = bad.map((r) => `${r.ref} is ${r.status === null ? 'unknown to the knowledge service' : `${r.status.factual}${r.status.stale ? ', stale' : ''}${r.status.blocked ? ', blocked' : ''}`}`).join('; ');
      if (o.unsupportedFacts !== 'downgrade') throw new DomainError('invalid_basis', `block ${b.id}: verified_fact needs a supported factual assessment (${why}). Relabel the block, or save with unsupportedFacts: "downgrade"`);
      const to = o.downgradeTo ?? 'allegation';
      invariant(DOWNGRADE_TARGETS.includes(to), 'invalid_input', `downgradeTo must be one of ${DOWNGRADE_TARGETS.join(', ')}`);
      b.downgraded = { from: 'verified_fact', reason: why.slice(0, 1000) }; b.basis = to;
      b.verification = { knowledge: { mode: 'port', status: 'downgraded', claims: results as unknown as Json }, checkedAt: ctx.now };
      checkBasisRules(b, { projectKind, isFactSource: isFact, isTestimonySource: isTestimony });
    }
    // Testimony-based material: adapt decision from E11.
    const decisions = new Map<string, Json>();
    for (const b of changed) {
      const vp = b.viewpointId === undefined ? undefined : viewpoints.get(b.viewpointId);
      const subjects = vp !== undefined ? [vp.body.participantRef, ...vp.body.testimonyRefs] : b.basis === 'attributed_testimony' ? b.sources.filter(isTestimony) : [];
      if (subjects.length === 0) continue;
      const key = [...subjects].sort().join('|');
      if (!decisions.has(key)) decisions.set(key, await useDecision(ctx, subjects, 'adapt'));
      b.verification = { ...(b.verification ?? {}), useDecision: decisions.get(key) as Json, checkedAt: ctx.now };
    }
    for (const b of body.blocks) links.push(...blockLinks(b));
    const gen = body.meta.generatedFrom;
    if (isRec(gen) && typeof gen.package === 'string') { try { parseUref(gen.package); links.push({ blockId: '', role: 'package', ref: gen.package }); } catch { /* not a reference */ } }
    if (body.translationOf !== undefined) links.push({ blockId: '', role: 'translation_of', ref: uref(EID, 'document', body.translationOf.documentId, body.translationOf.revision) });
    return { body: clean(body), links, cols: { editorialProjectId: body.editorialProjectId, parentDocumentId: body.translationOf?.documentId ?? null, language: body.language, docType: body.docType }, search: [body.title, ...body.blocks.flatMap((b) => [b.text, b.attribution ?? '', b.disclosure ?? ''])].join('\n').slice(0, 500_000) };
  }

  async function prepare(tx: Sql, ctx: ServiceContext, kind: Kind, raw: unknown, o: SaveOptions, prior: Loaded | null): Promise<Prepared> {
    if (kind === 'document') return prepareDocument(tx, ctx, raw, o, prior);
    const body = normalizeBody(kind, raw, formats);
    const links: Link[] = [];
    let cols: Prepared['cols'] = noCols;
    if (kind === 'editorial_project') {
      const b = body as ProjectBody;
      if (prior !== null) { const p = prior.r.body as ProjectBody; invariant(p.projectKind === b.projectKind && p.publishingIdentity === b.publishingIdentity, 'invalid_input', 'projectKind and publishingIdentity are fixed when an editorial project is created; start a separate project instead'); }
      for (const c of b.credits) invariant(await load(tx, ctx, 'collaborator', c.collaboratorId) !== null, 'invalid_reference', 'Unknown collaborator in credits');
      for (const ref of b.investigationRefs) links.push({ blockId: '', role: 'investigation', ref });
      cols = { ...noCols, language: b.language };
    } else if (kind === 'series') {
      const b = body as SeriesBody;
      if (prior !== null) invariant((prior.r.body as SeriesBody).projectKind === b.projectKind, 'invalid_input', 'A series keeps its projectKind');
      for (const it of b.items) {
        const p = await load(tx, ctx, 'editorial_project', it.editorialProjectId);
        invariant(p !== null, 'invalid_reference', 'Unknown editorial project in series');
        invariant((p.r.body as ProjectBody).projectKind === b.projectKind, 'invalid_input', `A ${b.projectKind} series cannot contain a ${(p.r.body as ProjectBody).projectKind} project: satirical, campaign and factual work are kept in separate series`);
      }
    } else if (kind === 'collection') {
      for (const it of (body as CollectionBody).items) {
        const p = parseUref(it.ref);
        invariant(p.engine === EID && (KINDS as readonly string[]).includes(p.kind) && await load(tx, ctx, p.kind as Kind, p.id) !== null, 'invalid_reference', `Collection item ${it.ref} is not an editorial object in this project`);
      }
    } else if (kind === 'viewpoint') {
      const b = body as ViewpointBody;
      const refs = [b.participantRef, b.consentRef, ...b.testimonyRefs];
      const w = await isWithdrawn(tx, ctx, refs);
      if (w !== null) throw new DomainError('consent_denied', `Permission for ${w} was withdrawn`);
      await useDecision(ctx, [b.participantRef, ...b.testimonyRefs], 'adapt');
      links.push({ blockId: '', role: 'participant', ref: b.participantRef }, { blockId: '', role: 'consent', ref: b.consentRef }, ...b.testimonyRefs.map((ref) => ({ blockId: '', role: 'testimony', ref })));
    } else if (kind === 'asset') {
      const b = body as AssetBody;
      const refs = [b.targetRef, b.rightsRef, ...(b.approvalRef === undefined ? [] : [b.approvalRef])];
      const w = await isWithdrawn(tx, ctx, refs);
      if (w !== null) throw new DomainError('consent_denied', `Permission for ${w} was withdrawn`);
      links.push({ blockId: '', role: 'target', ref: b.targetRef }, { blockId: '', role: 'rights', ref: b.rightsRef }, ...(b.approvalRef === undefined ? [] : [{ blockId: '', role: 'approval', ref: b.approvalRef }]));
    }
    const text = kind === 'viewpoint' ? [(body as ViewpointBody).label, (body as ViewpointBody).summary ?? ''] : kind === 'collaborator' ? [(body as CollaboratorBody).name, (body as CollaboratorBody).creditLine] : [titleOf(kind, body), String((body as { description?: string }).description ?? ''), String((body as { brief?: string }).brief ?? '')];
    return { body: clean(body), links, cols, search: text.join('\n') };
  }

  // ───────────────────────────── flags and dependents ─────────────────────────────
  type FlagMode = 'stale' | 'blocked';
  /** Flags every current block/object that depends on `refs`, and marks approvals of affected revisions needs_renewal. Never edits a revision. */
  async function flagDependents(tx: Sql, ctx: ServiceContext, refs: readonly string[], mode: FlagMode, reason: string, cause: string, changeKind: string, excludeObject?: string): Promise<string[]> {
    const affected: string[] = [];
    const invalidated = new Set<string>();
    for (const ref of refs) {
      const p = parseUref(ref);
      const rows = await tx.query<{ object_id: string; revision: number; block_id: string; kind: Kind; current_revision: number; approval_id: string | null }>(
        `select distinct l.object_id, l.revision, l.block_id, o.kind, o.revision as current_revision,
           (select a.id::text from ${S}.approvals a where a.tenant_id=l.tenant_id and a.project_id=l.project_id and a.object_id=l.object_id and a.revision=l.revision and a.status='active' limit 1) as approval_id
         from ${S}.links l join ${S}.objects o on o.tenant_id=l.tenant_id and o.project_id=l.project_id and o.id=l.object_id
         where l.tenant_id=$1 and l.project_id=$2 and l.ref_engine=$3 and l.ref_kind=$4 and l.ref_id=$5 and ($6::int is null or l.ref_rev is null or l.ref_rev <= $6)
         order by l.object_id, l.revision, l.block_id`, [...scope(ctx), p.engine, p.kind, p.id, p.revision ?? null]);
      for (const r of rows) {
        if (r.object_id === excludeObject) continue;
        if (r.revision === r.current_revision) {
          const inserted = await tx.query(`insert into ${S}.flags (tenant_id, project_id, id, object_id, block_id, revision, kind, reason, cause, ref, change_kind, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict do nothing returning id`,
            [...scope(ctx), randomUUID(), r.object_id, r.block_id, r.revision, mode, reason.slice(0, 2000), cause, ref, changeKind, ctx.now]);
          if (inserted.length > 0) {
            const subject = r.block_id === '' ? uref(EID, r.kind, r.object_id, r.revision) : blockRef(r.object_id, r.block_id, r.revision);
            await emitEvent(tx, S, ctx, `editorial.${r.block_id === '' ? 'object' : 'block'}_${mode}`, subject, { reason, cause, ref, changeKind, object: uref(EID, r.kind, r.object_id, r.revision) });
            if (!affected.includes(subject)) affected.push(subject);
          }
        }
        if (r.approval_id !== null && !invalidated.has(r.approval_id)) {
          invalidated.add(r.approval_id);
          await tx.query(`update ${S}.approvals set status='needs_renewal', invalidated_reason=$4, invalidated_cause=$5, invalidated_at=$6 where tenant_id=$1 and project_id=$2 and id=$3 and status='active'`, [...scope(ctx), r.approval_id, reason.slice(0, 2000), cause, ctx.now]);
          const subject = uref(EID, r.kind, r.object_id, r.revision);
          await emitEvent(tx, S, ctx, 'editorial.approval_invalidated', subject, { approval: uref(EID, 'approval', r.approval_id), reason, cause, ref, changeKind, mode });
          await appendAudit(tx, S, ctx, 'approval.needs_renewal', uref(EID, r.kind, r.object_id), { revision: r.revision, approval: r.approval_id, cause, ref });
          affected.push(uref(EID, 'approval', r.approval_id));
          if (!affected.includes(subject)) affected.push(subject);
        }
      }
    }
    return affected;
  }
  async function resolveFlagRow(tx: Sql, ctx: ServiceContext, flagId: string, resolution: string, note: string | null): Promise<void> {
    await tx.query(`update ${S}.flags set status='resolved', resolved_at=$4, resolved_by=$5, resolution=$6, note=$7 where tenant_id=$1 and project_id=$2 and id=$3 and status='open'`, [...scope(ctx), flagId, ctx.now, ctx.actor.id, resolution, note]);
  }

  // ───────────────────────────── revision writer ─────────────────────────────
  async function write<K extends Kind>(tx: Sql, ctx: ServiceContext, kind: K, id: string | null, expectedRevision: number | null, raw: unknown, o: SaveOptions & { compartment?: string; restoredFrom?: number }): Promise<Stored<K>> {
    const prior = id === null ? null : await load(tx, ctx, kind, id) ?? notFound();
    if (prior !== null) { posInt(expectedRevision, 'expectedRevision'); invariant(prior.o.revision === expectedRevision, 'revision_conflict', `The ${kind} is at revision ${prior.o.revision}; reload and reapply the change`); }
    const prep = await prepare(tx, ctx, kind, raw, o, prior);
    const digest = bodyDigest(prep.body);
    const title = titleOf(kind, prep.body);
    let objectId: string, revision: number;
    if (prior === null) {
      objectId = randomUUID(); revision = 1;
      const compartment = optStr(o.compartment, 'compartment', 200) ?? null;
      if (compartment !== null && !ctx.compartments.includes(compartment)) throw new DomainError('forbidden', 'Cannot create an object in a compartment the caller does not hold');
      await tx.query(`insert into ${S}.objects (tenant_id, project_id, id, kind, revision, state, title, compartment, editorial_project_id, parent_document_id, language, doc_type, search_text, created_at, created_by, updated_at) values ($1,$2,$3,$4,1,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$12)`,
        [...scope(ctx), objectId, kind, title, compartment, prep.cols.editorialProjectId, prep.cols.parentDocumentId, prep.cols.language, prep.cols.docType, prep.search, ctx.now, ctx.actor.id]);
    } else {
      objectId = prior.o.id;
      const locked = await load(tx, ctx, kind, objectId, { lock: true }) ?? notFound();
      invariant(locked.o.revision === expectedRevision, 'revision_conflict', `The ${kind} is at revision ${locked.o.revision}; reload and reapply the change`);
      invariant(digest !== locked.r.digest || o.restoredFrom !== undefined, 'invalid_input', 'The revision is identical to the current one');
      revision = locked.o.revision + 1;
      await tx.query(`update ${S}.objects set revision=$4, state='draft', title=$5, language=$6, search_text=$7, updated_at=$8 where tenant_id=$1 and project_id=$2 and id=$3`, [...scope(ctx), objectId, revision, title, prep.cols.language, prep.search, ctx.now]);
    }
    await tx.query(`insert into ${S}.revisions (tenant_id, project_id, object_id, revision, body, digest, summary, restored_from, actor_id, at) values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
      [...scope(ctx), objectId, revision, JSON.stringify(prep.body), digest, optStr(o.summary, 'summary', 1000) ?? null, o.restoredFrom ?? null, ctx.actor.id, ctx.now]);
    const seen = new Set<string>();
    const links = prep.links.filter((l) => { const k = `${l.blockId}|${l.role}|${l.ref}`; if (seen.has(k)) return false; seen.add(k); return true; });
    if (links.length > 0) {
      const parsed = links.map((l) => parseUref(l.ref));
      await tx.query(`insert into ${S}.links (tenant_id, project_id, object_id, revision, block_id, role, ref, ref_engine, ref_kind, ref_id, ref_rev)
        select $1,$2,$3,$4,* from unnest($5::text[],$6::text[],$7::text[],$8::text[],$9::text[],$10::text[],$11::int[])`,
        [...scope(ctx), objectId, revision, links.map((l) => l.blockId), links.map((l) => l.role), links.map((l) => l.ref), parsed.map((p) => p.engine), parsed.map((p) => p.kind), parsed.map((p) => p.id), parsed.map((p) => p.revision ?? null)]);
    }
    const selfRef = uref(EID, kind, objectId, revision);
    if (prior !== null) {
      // Existing flags: follow the block. Removed blocks and dropped references close their flags; staleness is closed only on the author's word.
      const flags = await openFlags(tx, ctx, objectId);
      const blockIds = kind === 'document' ? new Set((prep.body as DocumentBody).blocks.map((b) => b.id)) : new Set<string>();
      const bareRefs = (blockId: string): Set<string> => new Set(links.filter((l) => l.blockId === blockId).map((l) => l.ref.split('@')[0] as string));
      for (const f of flags) {
        const bid = f.blockId ?? '';
        if (f.blockId !== null && !blockIds.has(f.blockId)) await resolveFlagRow(tx, ctx, f.id, 'block_removed', null);
        else if (f.changeKind !== 'translation_source_changed' && !bareRefs(bid).has(f.ref.split('@')[0] as string)) await resolveFlagRow(tx, ctx, f.id, 'reference_removed', null);
        else if (f.kind === 'stale' && (o.resolveFlagIds ?? []).includes(f.id)) await resolveFlagRow(tx, ctx, f.id, 'revised', null);
      }
      for (const fid of o.resolveFlagIds ?? []) invariant(flags.some((f) => f.id === fid && f.kind === 'stale'), 'invalid_input', 'resolveFlagIds must name open stale flags of this object (a blocked flag closes only when the withdrawn reference is removed)');
    }
    if (kind === 'document') {
      const body = prep.body as DocumentBody;
      if (body.translationOf !== undefined) {
        // A translation re-pinned to a newer source revision: flags close for blocks that now match the current source.
        const src = await load(tx, ctx, 'document', body.translationOf.documentId, { system: true });
        const cur = new Map((src === null ? [] : (src.r.body as DocumentBody).blocks).map((b) => [b.id, blockHash(b)]));
        for (const f of await openFlags(tx, ctx, objectId)) {
          if (f.changeKind !== 'translation_source_changed' || f.blockId === null) continue;
          const b = body.blocks.find((x) => x.id === f.blockId);
          if (b !== undefined && b.translates !== undefined && b.sourceHash === cur.get(b.translates)) await resolveFlagRow(tx, ctx, f.id, 'translation_updated', null);
        }
      } else if (prior !== null) {
        const now = new Map(body.blocks.map((b) => [b.id, blockHash(b)]));
        const translations = await tx.query<{ id: string; revision: number; body: DocumentBody }>(`select o.id, o.revision, r.body from ${S}.objects o join ${S}.revisions r on r.tenant_id=o.tenant_id and r.project_id=o.project_id and r.object_id=o.id and r.revision=o.revision where o.tenant_id=$1 and o.project_id=$2 and o.parent_document_id=$3`, [...scope(ctx), objectId]);
        for (const t of translations) for (const b of t.body.blocks) {
          if (b.translates === undefined || b.sourceHash === now.get(b.translates)) continue;
          const reason = now.has(b.translates) ? 'The source block changed after this translation was made' : 'The source block was removed from the source document';
          const inserted = await tx.query(`insert into ${S}.flags (tenant_id, project_id, id, object_id, block_id, revision, kind, reason, cause, ref, change_kind, created_at) values ($1,$2,$3,$4,$5,$6,'stale',$7,$8,$9,'translation_source_changed',$10) on conflict do nothing returning id`,
            [...scope(ctx), randomUUID(), t.id, b.id, t.revision, reason, selfRef, blockRef(objectId, b.translates), ctx.now]);
          if (inserted.length > 0) await emitEvent(tx, S, ctx, 'editorial.translation_stale', blockRef(t.id, b.id, t.revision), { reason, cause: selfRef, sourceBlock: blockRef(objectId, b.translates, revision), translation: uref(EID, 'document', t.id, t.revision) });
        }
      }
    }
    if (prior !== null && (kind === 'viewpoint' || kind === 'asset')) await flagDependents(tx, ctx, [uref(EID, kind, objectId)], 'stale', `The ${kind} was revised; check passages that rely on it`, selfRef, 'content_changed', objectId);
    await appendAudit(tx, S, ctx, `${kind}.${prior === null ? 'created' : o.restoredFrom === undefined ? 'revised' : 'restored'}`, uref(EID, kind, objectId), { revision, digest, ...(o.restoredFrom === undefined ? {} : { restoredFrom: o.restoredFrom }) });
    await emitEvent(tx, S, ctx, kind === 'document' ? 'editorial.document_revised' : 'editorial.object_revised', selfRef, { kind, revision, digest, previousRevision: prior === null ? null : revision - 1, ...(kind === 'document' ? { docType: prep.cols.docType, editorialProject: uref(EID, 'editorial_project', prep.cols.editorialProjectId as string) } : {}) });
    return stored<K>(tx, ctx, await load(tx, ctx, kind, objectId, { system: true }) ?? notFound());
  }

  function kindOf(v: unknown): Kind { return oneOf(v, 'kind', KINDS); }
  const summaryOf = (o: ObjRow & { stale: boolean; blocked: boolean }): Summary => ({ ref: uref(EID, o.kind, o.id, o.revision), id: o.id, kind: o.kind, revision: o.revision, state: o.state, title: o.title, docType: o.doc_type, language: o.language, editorialProjectId: o.editorial_project_id, translationOf: o.parent_document_id, stale: o.stale, blocked: o.blocked, updatedAt: iso(o.updated_at) });
  const toApproval = (r: Record<string, unknown>, kind: Kind): Approval => ({ id: r.id as string, ref: uref(EID, 'approval', r.id as string), objectRef: uref(EID, kind, r.object_id as string, r.revision as number), revision: r.revision as number, digest: r.digest as string, status: r.status as Approval['status'], approverId: r.approver_id as string, note: (r.note as string | null) ?? null, at: iso(r.at), invalidatedReason: (r.invalidated_reason as string | null) ?? null, invalidatedCause: (r.invalidated_cause as string | null) ?? null });

  async function exportView(q: Sql, ctx: ServiceContext, l: Loaded): Promise<{ doc: ExportDocument; project: Loaded; viewpoints: Map<string, ViewpointBody> }> {
    const body = l.r.body as DocumentBody;
    const project = await load(q, ctx, 'editorial_project', body.editorialProjectId, { system: true }) ?? notFound();
    const pb = project.r.body as ProjectBody;
    const credits: ExportDocument['credits'] = [];
    for (const c of pb.credits) { const col = await load(q, ctx, 'collaborator', c.collaboratorId, { system: true }); if (col !== null) credits.push({ name: (col.r.body as CollaboratorBody).name, role: c.role, creditLine: c.creditLine ?? (col.r.body as CollaboratorBody).creditLine }); }
    const viewpoints = new Map<string, ViewpointBody>();
    for (const id of new Set(body.blocks.map((b) => b.viewpointId).filter((x): x is string => x !== undefined))) { const v = await load(q, ctx, 'viewpoint', id, { system: true }); if (v !== null) viewpoints.set(id, v.r.body as ViewpointBody); }
    const blocks: ExportBlock[] = body.blocks.map((b) => { const v = b.viewpointId === undefined ? undefined : viewpoints.get(b.viewpointId); return v === undefined ? b : { ...b, viewpoint: { id: b.viewpointId as string, label: v.label, attribution: v.attribution } }; });
    const n = pb.projectKind === 'satire' ? notice(body.language, 'satire') : pb.projectKind === 'campaign' ? notice(body.language, 'campaign').replace('{identity}', pb.publishingIdentity) : null;
    return { project, viewpoints, doc: {
      document: { ref: uref(EID, 'document', l.o.id, l.r.revision), id: l.o.id, revision: l.r.revision, title: body.title, docType: body.docType, language: body.language, reviewState: l.r.review_state, translationOf: body.translationOf === undefined ? null : { ref: uref(EID, 'document', body.translationOf.documentId, body.translationOf.revision) } },
      labels: { projectKind: pb.projectKind, format: pb.format, publishingIdentity: pb.publishingIdentity, projectTitle: pb.title, notice: n },
      credits, blocks, disclosures: collectDisclosures(body.blocks), sources: [...new Set(body.blocks.flatMap((b) => b.sources))],
    } };
  }
  function applyProposal(body: DocumentBody, p: SuggestionProposal, block: Block): DocumentBody {
    const blocks = [...body.blocks];
    if (p.mode === 'replace') { const i = blocks.findIndex((b) => b.id === p.blockId); invariant(i >= 0, 'invalid_state', 'The block this suggestion replaces no longer exists'); blocks[i] = { ...block, id: p.blockId as string }; }
    else { invariant(!blocks.some((b) => b.id === block.id), 'invalid_state', 'A block with the suggested id already exists'); const i = p.afterBlockId === undefined ? blocks.length - 1 : blocks.findIndex((b) => b.id === p.afterBlockId); blocks.splice(i < 0 ? blocks.length : i + 1, 0, block); }
    return { ...body, blocks };
  }

  const engine = {
    manifest,

    // ── revisioned objects (kind: series | collection | editorial_project | collaborator | viewpoint | asset | document) ──
    async create<K extends Kind>(ctx: ServiceContext, kind: K, input: { body: unknown; compartment?: string } & SaveOptions): Promise<Stored<K>> {
      requireCapability(ctx, 'editorial:write'); kindOf(kind);
      const { idempotencyKey, ...rest } = input;
      return sql.tx((tx) => idem(tx, ctx, idempotencyKey, { op: 'create', kind, ...rest }, () => write(tx, ctx, kind, null, null, input.body, rest)));
    },
    async revise<K extends Kind>(ctx: ServiceContext, kind: K, id: string, input: { expectedRevision: number; body: unknown } & SaveOptions): Promise<Stored<K>> {
      requireCapability(ctx, 'editorial:write'); kindOf(kind);
      const { idempotencyKey, ...rest } = input;
      return sql.tx((tx) => idem(tx, ctx, idempotencyKey, { op: 'revise', kind, id, ...rest }, () => write(tx, ctx, kind, id, input.expectedRevision, input.body, rest)));
    },
    async get<K extends Kind>(ctx: ServiceContext, kind: K, id: string, revision?: number): Promise<Stored<K>> {
      requireCapability(ctx, 'editorial:read'); kindOf(kind);
      return stored<K>(sql, ctx, await load(sql, ctx, kind, id, revision === undefined ? {} : { revision }) ?? notFound());
    },
    async list(ctx: ServiceContext, kind: Kind, filter: { editorialProjectId?: string; state?: string; docType?: string; translationOf?: string; limit?: number; offset?: number } = {}): Promise<Summary[]> {
      requireCapability(ctx, 'editorial:read'); kindOf(kind);
      const rows = await sql.query<ObjRow & { stale: boolean; blocked: boolean }>(`select o.*,
          exists (select 1 from ${S}.flags f where f.tenant_id=o.tenant_id and f.project_id=o.project_id and f.object_id=o.id and f.status='open' and f.kind='stale') as stale,
          exists (select 1 from ${S}.flags f where f.tenant_id=o.tenant_id and f.project_id=o.project_id and f.object_id=o.id and f.status='open' and f.kind='blocked') as blocked
        from ${S}.objects o where o.tenant_id=$1 and o.project_id=$2 and o.kind=$3 and (o.compartment is null or o.compartment = any($4::text[]))
          and ($5::uuid is null or o.editorial_project_id=$5) and ($6::text is null or o.state=$6) and ($7::text is null or o.doc_type=$7) and ($8::uuid is null or o.parent_document_id=$8)
        order by o.created_at, o.id limit $9 offset $10`,
        [...scope(ctx), kind, [...ctx.compartments], filter.editorialProjectId === undefined ? null : uuid(filter.editorialProjectId, 'editorialProjectId'), filter.state ?? null, filter.docType ?? null, filter.translationOf === undefined ? null : uuid(filter.translationOf, 'translationOf'), Math.min(Math.max(Math.trunc(filter.limit ?? 100) || 100, 1), 500), Math.max(Math.trunc(filter.offset ?? 0) || 0, 0)]);
      return rows.map(summaryOf);
    },
    async history(ctx: ServiceContext, kind: Kind, id: string): Promise<RevisionInfo[]> {
      requireCapability(ctx, 'editorial:read');
      await need(sql, ctx, kindOf(kind), id);
      return (await sql.query(`select revision, at, actor_id, summary, review_state, digest, restored_from from ${S}.revisions where tenant_id=$1 and project_id=$2 and object_id=$3 order by revision`, [...scope(ctx), id]))
        .map((r) => ({ revision: r.revision as number, at: iso(r.at), actorId: r.actor_id as string, summary: (r.summary as string | null) ?? null, reviewState: r.review_state as string, digest: r.digest as string, restoredFrom: (r.restored_from as number | null) ?? null }));
    },
    async diff(ctx: ServiceContext, kind: Kind, id: string, from: number, to: number): Promise<DiffResult> {
      requireCapability(ctx, 'editorial:read'); kindOf(kind);
      const a = await need(sql, ctx, kind, id, { revision: from }), b = await need(sql, ctx, kind, id, { revision: to });
      if (kind !== 'document') return { ref: uref(EID, kind, id), from, to, fields: diffJson(a.r.body, b.r.body), blocks: null };
      const { blocks: ba, ...ra } = a.r.body as DocumentBody, { blocks: bb, ...rb } = b.r.body as DocumentBody;
      return { ref: uref(EID, kind, id), from, to, fields: diffJson(ra, rb), blocks: diffBlocks(ba, bb) };
    },
    /** Restores an earlier revision as a NEW revision (history is never rewritten). The restored content is validated again. */
    async restore<K extends Kind>(ctx: ServiceContext, kind: K, id: string, input: { revision: number; expectedRevision: number } & SaveOptions): Promise<Stored<K>> {
      requireCapability(ctx, 'editorial:write'); kindOf(kind);
      const { idempotencyKey, revision, expectedRevision, ...rest } = input;
      return sql.tx((tx) => idem(tx, ctx, idempotencyKey, { op: 'restore', kind, id, revision, expectedRevision, ...rest }, async () => {
        const old = await need(tx, ctx, kind, id, { revision });
        return write(tx, ctx, kind, id, expectedRevision, old.r.body, { ...rest, summary: rest.summary ?? `Restored revision ${revision}`, restoredFrom: revision });
      }));
    },

    // ── review and approval ──
    async requestReview(ctx: ServiceContext, kind: Kind, id: string, input: { expectedRevision: number; note?: string; idempotencyKey?: string }): Promise<Stored> {
      requireCapability(ctx, 'editorial:write'); kindOf(kind);
      return sql.tx((tx) => idem(tx, ctx, input.idempotencyKey, { op: 'requestReview', kind, id, expectedRevision: input.expectedRevision, note: input.note }, async () => {
        const l = await need(tx, ctx, kind, id, { lock: true });
        invariant(l.o.revision === input.expectedRevision, 'revision_conflict', `The ${kind} is at revision ${l.o.revision}`);
        invariant(l.r.review_state === 'draft', 'invalid_state', `Revision ${l.r.revision} is ${l.r.review_state}, not draft`);
        await tx.query(`update ${S}.revisions set review_state='in_review' where tenant_id=$1 and project_id=$2 and object_id=$3 and revision=$4`, [...scope(ctx), id, l.r.revision]);
        await tx.query(`update ${S}.objects set state='in_review', updated_at=$4 where tenant_id=$1 and project_id=$2 and id=$3`, [...scope(ctx), id, ctx.now]);
        await appendAudit(tx, S, ctx, `${kind}.review_requested`, uref(EID, kind, id), { revision: l.r.revision });
        await emitEvent(tx, S, ctx, 'editorial.review_requested', uref(EID, kind, id, l.r.revision), { kind, revision: l.r.revision, ...(input.note === undefined ? {} : { note: str(input.note, 'note', 1000) }) });
        return stored(tx, ctx, await need(tx, ctx, kind, id));
      }));
    },
    async returnToDraft(ctx: ServiceContext, kind: Kind, id: string, input: { revision: number; note: string; idempotencyKey?: string }): Promise<Stored> {
      requireCapability(ctx, 'editorial:approve'); kindOf(kind);
      return sql.tx((tx) => idem(tx, ctx, input.idempotencyKey, { op: 'returnToDraft', kind, id, revision: input.revision, note: input.note }, async () => {
        const l = await need(tx, ctx, kind, id, { lock: true, revision: input.revision });
        invariant(l.r.review_state === 'in_review', 'invalid_state', `Revision ${l.r.revision} is ${l.r.review_state}, not in review`);
        await tx.query(`update ${S}.revisions set review_state='draft' where tenant_id=$1 and project_id=$2 and object_id=$3 and revision=$4`, [...scope(ctx), id, l.r.revision]);
        if (l.o.revision === l.r.revision) await tx.query(`update ${S}.objects set state='draft', updated_at=$4 where tenant_id=$1 and project_id=$2 and id=$3`, [...scope(ctx), id, ctx.now]);
        await appendAudit(tx, S, ctx, `${kind}.review_returned`, uref(EID, kind, id), { revision: l.r.revision });
        await emitEvent(tx, S, ctx, 'editorial.review_returned', uref(EID, kind, id, l.r.revision), { kind, revision: l.r.revision, note: str(input.note, 'note', 1000) });
        return stored(tx, ctx, await need(tx, ctx, kind, id, { revision: input.revision }));
      }));
    },
    /** Approves exactly one revision (bound to its content digest). Also renews an approval that needs renewal once its flags are resolved. */
    async approve(ctx: ServiceContext, kind: Kind, id: string, input: { revision: number; note?: string; idempotencyKey?: string }): Promise<Approval> {
      requireCapability(ctx, 'editorial:approve'); kindOf(kind);
      if (ports.authorization !== undefined) { const a = await ports.authorization.authorize(ctx, { capability: 'editorial:approve', resource: uref(EID, kind, UUID.test(id) ? id : 'unknown') }); if (!a.allowed) throw new DomainError('forbidden', 'Approval is not authorized'); }
      return sql.tx((tx) => idem(tx, ctx, input.idempotencyKey, { op: 'approve', kind, id, revision: input.revision, note: input.note }, async () => {
        const l = await need(tx, ctx, kind, id, { lock: true, revision: posInt(input.revision, 'revision') });
        const prior = (await tx.query(`select * from ${S}.approvals where tenant_id=$1 and project_id=$2 and object_id=$3 and revision=$4 and status in ('active','needs_renewal')`, [...scope(ctx), id, l.r.revision]))[0];
        invariant(l.r.review_state === 'in_review' || (l.r.review_state === 'approved' && prior?.status === 'needs_renewal'), 'invalid_state', `Revision ${l.r.revision} is ${l.r.review_state}; only a revision in review (or an approval needing renewal) can be approved`);
        if (cfg.allowSelfApproval !== true) invariant(l.r.actor_id !== ctx.actor.id, 'forbidden', 'The author of a revision cannot approve it');
        const blockIds = kind === 'document' ? new Set((l.r.body as DocumentBody).blocks.map((b) => b.id)) : new Set<string>();
        const open = (await openFlags(tx, ctx, id)).filter((f) => f.blockId === null || blockIds.has(f.blockId));
        invariant(open.length === 0, 'invalid_state', `Revision ${l.r.revision} has ${open.length} open stale/blocked flag(s); resolve them before approval`);
        await tx.query(`update ${S}.approvals set status='superseded' where tenant_id=$1 and project_id=$2 and object_id=$3 and status in ('active','needs_renewal')`, [...scope(ctx), id]);
        await tx.query(`update ${S}.revisions set review_state='superseded' where tenant_id=$1 and project_id=$2 and object_id=$3 and review_state='approved' and revision<>$4`, [...scope(ctx), id, l.r.revision]);
        await tx.query(`update ${S}.revisions set review_state='approved' where tenant_id=$1 and project_id=$2 and object_id=$3 and revision=$4`, [...scope(ctx), id, l.r.revision]);
        if (l.o.revision === l.r.revision) await tx.query(`update ${S}.objects set state='approved', updated_at=$4 where tenant_id=$1 and project_id=$2 and id=$3`, [...scope(ctx), id, ctx.now]);
        const approvalId = randomUUID();
        const row = (await tx.query(`insert into ${S}.approvals (tenant_id, project_id, id, object_id, revision, digest, status, approver_id, note, at) values ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9) returning *`, [...scope(ctx), approvalId, id, l.r.revision, l.r.digest, ctx.actor.id, optStr(input.note, 'note', 2000) ?? null, ctx.now]))[0] as Record<string, unknown>;
        await appendAudit(tx, S, ctx, `${kind}.approved`, uref(EID, kind, id), { revision: l.r.revision, digest: l.r.digest, approval: approvalId, renewed: prior !== undefined });
        await emitEvent(tx, S, ctx, 'editorial.approved', uref(EID, kind, id, l.r.revision), { kind, revision: l.r.revision, digest: l.r.digest, approval: uref(EID, 'approval', approvalId) });
        return toApproval(row, kind);
      }));
    },
    async listApprovals(ctx: ServiceContext, kind: Kind, id: string): Promise<Approval[]> {
      requireCapability(ctx, 'editorial:read');
      await need(sql, ctx, kindOf(kind), id);
      return (await sql.query(`select * from ${S}.approvals where tenant_id=$1 and project_id=$2 and object_id=$3 order by at, id`, [...scope(ctx), id])).map((r) => toApproval(r, kind));
    },

    // ── comments, suggestions, assignments ──
    async addComment(ctx: ServiceContext, kind: Kind, id: string, input: { body: string; blockId?: string; idempotencyKey?: string }): Promise<Comment> {
      requireCapability(ctx, 'editorial:comment'); kindOf(kind);
      return sql.tx((tx) => idem(tx, ctx, input.idempotencyKey, { op: 'comment', kind, id, body: input.body, blockId: input.blockId }, async () => {
        const l = await need(tx, ctx, kind, id);
        const blockId = optStr(input.blockId, 'blockId', 64) ?? null;
        invariant(blockId === null || (kind === 'document' && (l.r.body as DocumentBody).blocks.some((b) => b.id === blockId)), 'invalid_input', 'blockId names no block of the current revision');
        const row = (await tx.query(`insert into ${S}.comments (tenant_id, project_id, id, object_id, revision, block_id, kind, body, origin, author_id, created_at) values ($1,$2,$3,$4,$5,$6,'comment',$7,'human',$8,$9) returning *`, [...scope(ctx), randomUUID(), id, l.o.revision, blockId, str(input.body, 'body', 10_000), ctx.actor.id, ctx.now]))[0] as Record<string, unknown>;
        await appendAudit(tx, S, ctx, `${kind}.commented`, uref(EID, kind, id), { comment: row.id as string, revision: l.o.revision });
        return toComment(row);
      }));
    },
    /** A proposed block (replacement or insertion). Nothing changes in the document until a writer accepts it. */
    async suggest(ctx: ServiceContext, documentId: string, input: { block: unknown; blockId?: string; afterBlockId?: string; note?: string; idempotencyKey?: string }): Promise<Comment> {
      requireCapability(ctx, 'editorial:comment');
      return sql.tx((tx) => idem(tx, ctx, input.idempotencyKey, { op: 'suggest', documentId, block: input.block, blockId: input.blockId, afterBlockId: input.afterBlockId, note: input.note }, async () => {
        const l = await need(tx, ctx, 'document', documentId);
        const has = (b: string | undefined): boolean => b === undefined || l.r.body.blocks.some((x) => x.id === b);
        invariant(has(input.blockId) && has(input.afterBlockId), 'invalid_input', 'The suggestion targets no block of the current revision');
        const block = normalizeBlock(isRec(input.block) && input.blockId !== undefined ? { ...input.block, id: input.blockId } : input.block, 'block');
        const proposal: SuggestionProposal = pack({ mode: input.blockId === undefined ? 'insert' as const : 'replace' as const, blockId: input.blockId, afterBlockId: input.afterBlockId, block });
        const row = (await tx.query(`insert into ${S}.comments (tenant_id, project_id, id, object_id, revision, block_id, kind, body, proposal, origin, author_id, created_at) values ($1,$2,$3,$4,$5,$6,'suggestion',$7,$8::jsonb,'human',$9,$10) returning *`, [...scope(ctx), randomUUID(), documentId, l.o.revision, input.blockId ?? null, optStr(input.note, 'note', 10_000) ?? 'Suggested change', JSON.stringify(proposal), ctx.actor.id, ctx.now]))[0] as Record<string, unknown>;
        await appendAudit(tx, S, ctx, 'document.suggestion_added', uref(EID, 'document', documentId), { comment: row.id as string, origin: 'human' });
        await emitEvent(tx, S, ctx, 'editorial.suggestion_proposed', uref(EID, 'document', documentId, l.o.revision), { suggestion: row.id as string, origin: 'human' });
        return toComment(row);
      }));
    },
    async listComments(ctx: ServiceContext, kind: Kind, id: string, filter: { status?: string; kind?: 'comment' | 'suggestion' } = {}): Promise<Comment[]> {
      requireCapability(ctx, 'editorial:read');
      await need(sql, ctx, kindOf(kind), id);
      return (await sql.query(`select * from ${S}.comments where tenant_id=$1 and project_id=$2 and object_id=$3 and ($4::text is null or status=$4) and ($5::text is null or kind=$5) order by created_at, id`, [...scope(ctx), id, filter.status ?? null, filter.kind ?? null])).map(toComment);
    },
    async resolveComment(ctx: ServiceContext, commentId: string, input: { status: 'resolved' | 'rejected'; note?: string }): Promise<Comment> {
      requireCapability(ctx, 'editorial:comment');
      return sql.tx(async (tx) => {
        const c = (await tx.query(`select * from ${S}.comments where tenant_id=$1 and project_id=$2 and id=$3 for update`, [...scope(ctx), uuid(commentId, 'commentId')]))[0] ?? notFound();
        await (load(tx, ctx, null, c.object_id as string)) ?? notFound();
        invariant(c.status === 'open', 'invalid_state', `The ${String(c.kind)} is already ${String(c.status)}`);
        const row = (await tx.query(`update ${S}.comments set status=$4, resolved_by=$5, resolved_at=$6, resolution_note=$7 where tenant_id=$1 and project_id=$2 and id=$3 returning *`, [...scope(ctx), commentId, oneOf(input.status, 'status', ['resolved', 'rejected'] as const), ctx.actor.id, ctx.now, optStr(input.note, 'note', 2000) ?? null]))[0] as Record<string, unknown>;
        await appendAudit(tx, S, ctx, 'comment.closed', uref(EID, 'document', c.object_id as string), { comment: commentId, status: input.status });
        return toComment(row);
      });
    },
    /** Applies a suggestion as a new revision through the same label and source rules as any save. `relabel` lets the human set basis, sources, attribution and disclosure. */
    async acceptSuggestion(ctx: ServiceContext, suggestionId: string, input: { expectedRevision: number; relabel?: Record<string, unknown> } & SaveOptions): Promise<Stored<'document'>> {
      requireCapability(ctx, 'editorial:write');
      const { idempotencyKey, expectedRevision, relabel, ...rest } = input;
      return sql.tx((tx) => idem(tx, ctx, idempotencyKey, { op: 'acceptSuggestion', suggestionId, expectedRevision, relabel, ...rest }, async () => {
        const c = (await tx.query(`select * from ${S}.comments where tenant_id=$1 and project_id=$2 and id=$3 and kind='suggestion' for update`, [...scope(ctx), uuid(suggestionId, 'suggestionId')]))[0] ?? notFound();
        invariant(c.status === 'open', 'invalid_state', `The suggestion is already ${String(c.status)}`);
        const l = await need(tx, ctx, 'document', c.object_id as string);
        const p = c.proposal as SuggestionProposal;
        const merged = relabel === undefined ? p.block : (() => { const r = rec(relabel, 'relabel', ['basis', 'sources', 'sourceSelectors', 'attribution', 'disclosure', 'text', 'viewpointId', 'note']); const out: Record<string, unknown> = { ...p.block, ...r }; for (const k of Object.keys(r)) if (r[k] === null) delete out[k]; if (c.origin === 'model' && r.basis !== undefined && r.basis !== p.block.basis && r.disclosure === undefined) delete out.disclosure; return normalizeBlock(out, 'block'); })();
        const saved = await write(tx, ctx, 'document', l.o.id, expectedRevision, applyProposal(l.r.body, p, merged), { ...rest, summary: rest.summary ?? `Accepted suggestion ${suggestionId}` });
        await tx.query(`update ${S}.comments set status='accepted', resolved_by=$4, resolved_at=$5, applied_revision=$6 where tenant_id=$1 and project_id=$2 and id=$3`, [...scope(ctx), suggestionId, ctx.actor.id, ctx.now, saved.revision]);
        return saved;
      }));
    },
    async assign(ctx: ServiceContext, kind: Kind, id: string, input: { assigneeId: string; role: string; blockId?: string; note?: string; dueAt?: string; idempotencyKey?: string }): Promise<Assignment> {
      requireCapability(ctx, 'editorial:write'); kindOf(kind);
      return sql.tx((tx) => idem(tx, ctx, input.idempotencyKey, { op: 'assign', kind, id, assigneeId: input.assigneeId, role: input.role, blockId: input.blockId, note: input.note, dueAt: input.dueAt }, async () => {
        await need(tx, ctx, kind, id);
        const due = input.dueAt === undefined ? null : (invariant(Number.isFinite(Date.parse(input.dueAt)), 'invalid_time', 'Invalid dueAt'), new Date(input.dueAt).toISOString());
        const row = (await tx.query(`insert into ${S}.assignments (tenant_id, project_id, id, object_id, block_id, assignee_id, role, note, due_at, created_by, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning *`, [...scope(ctx), randomUUID(), id, optStr(input.blockId, 'blockId', 64) ?? null, str(input.assigneeId, 'assigneeId', 200), str(input.role, 'role', 100), optStr(input.note, 'note', 2000) ?? null, due, ctx.actor.id, ctx.now]))[0] as Record<string, unknown>;
        await appendAudit(tx, S, ctx, `${kind}.assigned`, uref(EID, kind, id), { assignment: row.id as string, assigneeId: input.assigneeId, role: input.role });
        return toAssignment(row);
      }));
    },
    async listAssignments(ctx: ServiceContext, filter: { objectId?: string; assigneeId?: string; status?: string } = {}): Promise<Assignment[]> {
      requireCapability(ctx, 'editorial:read');
      const rows = await sql.query(`select a.* from ${S}.assignments a join ${S}.objects o on o.tenant_id=a.tenant_id and o.project_id=a.project_id and o.id=a.object_id
        where a.tenant_id=$1 and a.project_id=$2 and (o.compartment is null or o.compartment = any($3::text[])) and ($4::uuid is null or a.object_id=$4) and ($5::text is null or a.assignee_id=$5) and ($6::text is null or a.status=$6) order by a.created_at, a.id limit 1000`,
        [...scope(ctx), [...ctx.compartments], filter.objectId === undefined ? null : uuid(filter.objectId, 'objectId'), filter.assigneeId ?? null, filter.status ?? null]);
      return rows.map(toAssignment);
    },
    async updateAssignment(ctx: ServiceContext, assignmentId: string, input: { status: 'open' | 'done' | 'cancelled' }): Promise<Assignment> {
      requireCapability(ctx, 'editorial:write');
      return sql.tx(async (tx) => {
        const a = (await tx.query(`select * from ${S}.assignments where tenant_id=$1 and project_id=$2 and id=$3 for update`, [...scope(ctx), uuid(assignmentId, 'assignmentId')]))[0] ?? notFound();
        await load(tx, ctx, null, a.object_id as string) ?? notFound();
        const row = (await tx.query(`update ${S}.assignments set status=$4, updated_at=$5 where tenant_id=$1 and project_id=$2 and id=$3 returning *`, [...scope(ctx), assignmentId, oneOf(input.status, 'status', ['open', 'done', 'cancelled'] as const), ctx.now]))[0] as Record<string, unknown>;
        await appendAudit(tx, S, ctx, 'assignment.updated', uref(EID, 'document', a.object_id as string), { assignment: assignmentId, status: input.status });
        return toAssignment(row);
      });
    },

    // ── stale / blocked flags ──
    async listFlags(ctx: ServiceContext, filter: { objectId?: string; status?: 'open' | 'resolved'; kind?: 'stale' | 'blocked' } = {}): Promise<Flag[]> {
      requireCapability(ctx, 'editorial:read');
      return (await sql.query(`select f.* from ${S}.flags f join ${S}.objects o on o.tenant_id=f.tenant_id and o.project_id=f.project_id and o.id=f.object_id
        where f.tenant_id=$1 and f.project_id=$2 and (o.compartment is null or o.compartment = any($3::text[])) and ($4::uuid is null or f.object_id=$4) and ($5::text is null or f.status=$5) and ($6::text is null or f.kind=$6) order by f.created_at, f.id limit 2000`,
        [...scope(ctx), [...ctx.compartments], filter.objectId === undefined ? null : uuid(filter.objectId, 'objectId'), filter.status ?? null, filter.kind ?? null])).map(toFlag);
    },
    /** Closes a stale flag on a human's recorded judgement. A blocked flag closes only when the withdrawn reference is gone from the block (by revising). */
    async resolveFlag(ctx: ServiceContext, flagId: string, input: { resolution: 'reviewed_still_accurate' | 'revised'; note: string }): Promise<Flag> {
      requireCapability(ctx, 'editorial:write');
      return sql.tx(async (tx) => {
        const f = (await tx.query(`select * from ${S}.flags where tenant_id=$1 and project_id=$2 and id=$3 for update`, [...scope(ctx), uuid(flagId, 'flagId')]))[0] ?? notFound();
        const l = await load(tx, ctx, null, f.object_id as string) ?? notFound();
        invariant(f.status === 'open', 'invalid_state', 'The flag is already resolved');
        invariant(f.kind === 'stale', 'invalid_state', 'A blocked flag cannot be dismissed: remove the withdrawn material in a new revision');
        await resolveFlagRow(tx, ctx, flagId, oneOf(input.resolution, 'resolution', ['reviewed_still_accurate', 'revised'] as const), str(input.note, 'note', 2000));
        await appendAudit(tx, S, ctx, 'flag.resolved', uref(EID, l.o.kind, l.o.id), { flag: flagId, resolution: input.resolution, cause: f.cause as string });
        return toFlag((await tx.query(`select * from ${S}.flags where tenant_id=$1 and project_id=$2 and id=$3`, [...scope(ctx), flagId]))[0] as Record<string, unknown>);
      });
    },

    // ── translations ──
    /** Creates a translation variant pinned to a source revision. Blocks name the source block they translate; labels and sources are inherited. */
    async createTranslation(ctx: ServiceContext, input: { sourceDocumentId: string; sourceRevision?: number; language: string; title: string; blocks: readonly unknown[]; compartment?: string } & SaveOptions): Promise<Stored<'document'>> {
      requireCapability(ctx, 'editorial:write');
      const { idempotencyKey, sourceDocumentId, sourceRevision, language, title, blocks, ...rest } = input;
      return sql.tx((tx) => idem(tx, ctx, idempotencyKey, { op: 'createTranslation', sourceDocumentId, sourceRevision, language, title, blocks, ...rest }, async () => {
        const src = await need(tx, ctx, 'document', sourceDocumentId, sourceRevision === undefined ? {} : { revision: sourceRevision });
        return write(tx, ctx, 'document', null, null, { title, language, editorialProjectId: src.r.body.editorialProjectId, docType: src.r.body.docType, translationOf: { documentId: sourceDocumentId, revision: src.r.revision }, blocks, meta: {} }, { ...rest, ...(rest.compartment === undefined && src.o.compartment !== null ? { compartment: src.o.compartment } : {}) });
      }));
    },
    /** Block-by-block state of every translation of a source document against its current revision. */
    async translationStatus(ctx: ServiceContext, sourceDocumentId: string): Promise<{ source: string; translations: { ref: string; id: string; language: string; pinnedRevision: number; blocks: { blockId: string; translates: string; state: 'current' | 'stale' | 'source_removed' }[]; untranslated: string[] }[] }> {
      requireCapability(ctx, 'editorial:read');
      const src = await need(sql, ctx, 'document', sourceDocumentId);
      const cur = new Map(src.r.body.blocks.map((b) => [b.id, blockHash(b)]));
      const out = [];
      for (const s of await engine.list(ctx, 'document', { translationOf: sourceDocumentId, limit: 500 })) {
        const t = await need(sql, ctx, 'document', s.id);
        const tb = t.r.body.blocks.filter((b) => b.translates !== undefined);
        out.push({ ref: s.ref, id: s.id, language: t.r.body.language, pinnedRevision: (t.r.body.translationOf as { revision: number }).revision,
          blocks: tb.map((b) => ({ blockId: b.id, translates: b.translates as string, state: !cur.has(b.translates as string) ? 'source_removed' as const : cur.get(b.translates as string) === b.sourceHash ? 'current' as const : 'stale' as const })),
          untranslated: [...cur.keys()].filter((k) => !tb.some((b) => b.translates === k)) });
      }
      return { source: uref(EID, 'document', src.o.id, src.o.revision), translations: out };
    },

    // ── fact-check ledger ──
    /** Every factual statement with its sources, selectors and status, plus unsourced statements and declared non-factual blocks. */
    async factCheck(ctx: ServiceContext, documentId: string, revision?: number): Promise<FactCheck> {
      requireCapability(ctx, 'editorial:read');
      const l = await need(sql, ctx, 'document', documentId, revision === undefined ? {} : { revision });
      const flags = await openFlags(sql, ctx, documentId);
      const cache = new Map<string, ClaimStatus | null>();
      const statements: FactStatement[] = []; const declared: FactCheck['declared'] = []; const byBasis: Record<string, number> = {};
      for (const b of l.r.body.blocks) {
        byBasis[b.basis] = (byBasis[b.basis] ?? 0) + 1;
        if (!FACTUAL_BASES.includes(b.basis) && b.basis !== 'inference') { declared.push({ blockId: b.id, basis: b.basis, disclosure: b.disclosure ?? null, generatedRole: b.generated?.role ?? null }); continue; }
        const sources: FactStatement['sources'] = [];
        for (const ref of b.sources) {
          const claim = isFact(ref) && parseUref(ref).engine === 'E07';
          let current: FactStatement['sources'][number]['current'] = null;
          if (claim) { if (ports.knowledge === undefined) current = 'not_checked'; else { if (!cache.has(ref)) cache.set(ref, await ports.knowledge.getClaimStatus(ctx, ref)); current = cache.get(ref) ?? 'unknown_claim'; } }
          sources.push({ ref, selector: b.sourceSelectors?.[ref] ?? null, role: isFact(ref) ? 'fact' : isTestimony(ref) ? 'testimony' : 'other', current });
        }
        const mine = flags.filter((f) => f.blockId === b.id);
        const claims = sources.filter((s) => s.current !== null);
        const status: FactStatement['status'] = mine.length > 0 ? 'attention'
          : b.basis === 'verified_fact' ? (claims.some((s) => s.current === 'unknown_claim' || (typeof s.current === 'object' && s.current !== null && !claimOk(s.current))) ? 'attention' : ports.knowledge === undefined || claims.length === 0 ? 'not_checked' : 'supported')
          : b.sources.length === 0 ? 'unsourced' : 'sourced';
        statements.push({ blockId: b.id, ref: blockRef(documentId, b.id, l.r.revision), type: b.type, basis: b.basis, text: b.text, attribution: b.attribution ?? null, uncertainty: b.note ?? null, status, sources, saved: (b.verification ?? null) as Json | null, flags: mine });
      }
      const unsourced = statements.filter((s) => s.status === 'unsourced').map((s) => s.blockId);
      return { document: uref(EID, 'document', documentId, l.r.revision), revision: l.r.revision, knowledge: ports.knowledge === undefined ? 'standalone_not_checked' : 'port',
        summary: { blocks: l.r.body.blocks.length, byBasis, factual: statements.filter((s) => FACTUAL_BASES.includes(s.basis)).length, unsourced: unsourced.length, attention: statements.filter((s) => s.status === 'attention').length }, statements, unsourced, declared };
    },

    // ── exports for E10 / E12 ──
    /** Exports exactly one revision with a manifest of everything it depends on. Refused while withdrawn or blocked material is in that revision. */
    async exportDocument(ctx: ServiceContext, documentId: string, revision: number, options: { formats?: readonly ExportFormat[]; requireApproved?: boolean; intendedUse?: 'adapt' | 'publish'; audience?: string; territory?: string; destination?: string; idempotencyKey?: string } = {}): Promise<ExportResult> {
      requireCapability(ctx, 'editorial:export');
      if (ports.authorization !== undefined) { const a = await ports.authorization.authorize(ctx, { capability: 'editorial:export', resource: uref(EID, 'document', UUID.test(documentId) ? documentId : 'unknown') }); if (!a.allowed) throw new DomainError('forbidden', 'Export is not authorized'); }
      const { idempotencyKey, ...rest } = options;
      return sql.tx((tx) => idem(tx, ctx, idempotencyKey, { op: 'export', documentId, revision, ...rest }, async () => {
        const l = await need(tx, ctx, 'document', documentId, { revision: posInt(revision, 'revision') });
        const body = l.r.body;
        const formatsWanted = [...new Set(options.formats === undefined ? defaultFormats(body.docType) : options.formats.map((f) => oneOf(f, 'format', EXPORT_FORMATS)))];
        const linkRows = await tx.query<{ block_id: string; role: string; ref: string }>(`select block_id, role, ref from ${S}.links where tenant_id=$1 and project_id=$2 and object_id=$3 and revision=$4`, [...scope(ctx), documentId, l.r.revision]);
        const w = await isWithdrawn(tx, ctx, linkRows.map((r) => r.ref));
        if (w !== null) throw new DomainError('consent_denied', `Revision ${l.r.revision} uses material whose permission was withdrawn (${w}); it cannot be exported`);
        const blockIds = new Set(body.blocks.map((b) => b.id));
        const flags = (await openFlags(tx, ctx, documentId)).filter((f) => f.blockId === null || blockIds.has(f.blockId));
        if (flags.some((f) => f.kind === 'blocked')) throw new DomainError('consent_denied', `Revision ${l.r.revision} contains blocked material; it cannot be exported`);
        const approvalRow = (await tx.query(`select * from ${S}.approvals where tenant_id=$1 and project_id=$2 and object_id=$3 and revision=$4 order by at desc limit 1`, [...scope(ctx), documentId, l.r.revision]))[0];
        const approval = approvalRow === undefined ? null : toApproval(approvalRow, 'document');
        if (options.requireApproved === true) invariant(approval !== null && approval.status === 'active' && approval.digest === l.r.digest, 'approval_invalid', approval === null ? `Revision ${l.r.revision} has no approval` : `The approval of revision ${l.r.revision} is ${approval.status}`);
        const view = await exportView(tx, ctx, l);
        const intendedUse: UseAction = options.intendedUse === 'publish' ? 'publish' : 'adapt';
        const useDecisions: Json[] = []; const asked = new Set<string>();
        for (const b of body.blocks) {
          const v = b.viewpointId === undefined ? undefined : view.viewpoints.get(b.viewpointId);
          const subjects = v !== undefined ? [v.participantRef, ...v.testimonyRefs] : b.basis === 'attributed_testimony' ? b.sources.filter(isTestimony) : [];
          const key = [...subjects].sort().join('|');
          if (subjects.length === 0 || asked.has(key)) continue; asked.add(key);
          const d = await useDecision(ctx, subjects, intendedUse, pack({ audience: options.audience, territory: options.territory, destination: options.destination }));
          if (intendedUse === 'publish' && isRec(d) && d.decision === 'review') throw new DomainError('consent_denied', `Publishing block ${b.id} requires a consent review that has not been completed`);
          useDecisions.push(d);
        }
        const renderings: ExportResult['renderings'] = {};
        if (formatsWanted.includes('markdown')) renderings.markdown = renderMarkdown(view.doc);
        if (formatsWanted.includes('fountain')) renderings.fountain = renderFountain(view.doc);
        if (formatsWanted.includes('lyric_sheet')) renderings.lyricSheet = renderLyricSheet(view.doc);
        if (formatsWanted.includes('graph')) { invariant(body.docType === 'interactive_story', 'invalid_input', 'The graph format applies to interactive stories'); renderings.graph = renderGraph(view.doc); }
        const exportId = randomUUID();
        const byRole = (roles: string[]): string[] => [...new Set(linkRows.filter((r) => roles.includes(r.role)).map((r) => r.ref))].sort();
        const scopeKey = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
        const objectKey = deps.objects !== undefined && scopeKey.test(ctx.tenantId) && scopeKey.test(ctx.projectId) ? `${ctx.tenantId}/${ctx.projectId}/exports/${documentId}/${exportId}.json` : null;
        const manifestOut: ExportManifest = {
          exportId, engine: EID, engineVersion: manifest.version, document: view.doc.document.ref, revision: l.r.revision, contentDigest: l.r.digest, reviewState: l.r.review_state,
          approval: approval === null ? null : { id: approval.id, status: approval.status, approverId: approval.approverId, at: approval.at }, formats: formatsWanted,
          renderingDigests: Object.fromEntries(Object.entries(renderings).map(([k, v]) => [k, sha(typeof v === 'string' ? v : JSON.stringify(v))])),
          sourceRefs: byRole(['source']), assetRefs: byRole(['asset', 'asset_dep']), viewpointRefs: byRole(['viewpoint', 'viewpoint_dep']), packageRefs: byRole(['package']), translationOf: view.doc.document.translationOf?.ref ?? null,
          labels: view.doc.labels, credits: view.doc.credits, disclosures: view.doc.disclosures, openFlags: flags.map((f) => ({ blockId: f.blockId, kind: f.kind, reason: f.reason, cause: f.cause })),
          useDecisions, intendedUse, exportedAt: ctx.now, exportedBy: ctx.actor.id, objectKey,
        };
        const result: ExportResult = { manifest: manifestOut, document: view.doc, renderings };
        if (objectKey !== null && deps.objects !== undefined) await deps.objects.put(objectKey, new TextEncoder().encode(JSON.stringify(clean(result))));
        await tx.query(`insert into ${S}.exports (tenant_id, project_id, id, object_id, revision, formats, manifest, digest, object_key, actor_id, at) values ($1,$2,$3,$4,$5,$6::text[],$7::jsonb,$8,$9,$10,$11)`, [...scope(ctx), exportId, documentId, l.r.revision, formatsWanted, JSON.stringify(clean(manifestOut)), l.r.digest, objectKey, ctx.actor.id, ctx.now]);
        await appendAudit(tx, S, ctx, 'document.exported', uref(EID, 'document', documentId), { export: exportId, revision: l.r.revision, digest: l.r.digest, formats: formatsWanted, intendedUse });
        await emitEvent(tx, S, ctx, 'editorial.exported', view.doc.document.ref, { export: uref(EID, 'export', exportId), revision: l.r.revision, digest: l.r.digest, formats: formatsWanted });
        return result;
      }));
    },
    async listExports(ctx: ServiceContext, documentId: string): Promise<ExportManifest[]> {
      requireCapability(ctx, 'editorial:read');
      await need(sql, ctx, 'document', documentId);
      return (await sql.query<{ manifest: ExportManifest }>(`select manifest from ${S}.exports where tenant_id=$1 and project_id=$2 and object_id=$3 order by at, id`, [...scope(ctx), documentId])).map((r) => r.manifest);
    },

    // ── authoring help ──
    /** Builds a first draft from an E08 investigation package. Labels and sources come from the package; the draft is saved through the normal rules. */
    async generate(ctx: ServiceContext, input: { generator: GeneratorName; editorialProjectId: string; package: unknown; viewpointIds?: readonly string[]; title?: string; language?: string; lineSyllables?: number; compartment?: string } & SaveOptions): Promise<{ document: Stored<'document'>; omitted: { ref: string; reason: string }[] }> {
      requireCapability(ctx, 'editorial:write');
      const { idempotencyKey, ...rest } = input;
      return sql.tx((tx) => idem(tx, ctx, idempotencyKey, { op: 'generate', ...rest }, async () => {
        const name = oneOf(input.generator, 'generator', GENERATORS);
        const project = await load(tx, ctx, 'editorial_project', input.editorialProjectId);
        invariant(project !== null, 'invalid_reference', 'Unknown editorial project');
        const lang = input.language === undefined ? (project.r.body as ProjectBody).language : languageTag(input.language);
        const viewpoints = [];
        for (const id of strList(input.viewpointIds, 'viewpointIds', 50)) { const v = await load(tx, ctx, 'viewpoint', id); invariant(v !== null, 'invalid_reference', 'Unknown viewpoint'); viewpoints.push({ id, body: v.r.body as ViewpointBody }); }
        const templates = templatesFor(lang);
        const pkg = parsePackage(input.package, { templates, isTestimonySource: isTestimony });
        const g = runGenerator(name, pkg, viewpoints, pack({ templates, isTestimonySource: isTestimony, language: lang, languages: cfg.languages, lineSyllables: input.lineSyllables }));
        const document = await write(tx, ctx, 'document', null, null, { title: optStr(input.title, 'title', 300) ?? g.title, editorialProjectId: input.editorialProjectId, docType: g.docType, language: lang, blocks: g.blocks, meta: { generatedFrom: { package: g.packageRef, generator: name, viewpoints: viewpoints.map((v) => v.id) } } },
          pack({ summary: input.summary ?? `Generated ${name} from ${g.packageRef}`, unsupportedFacts: input.unsupportedFacts, downgradeTo: input.downgradeTo, compartment: input.compartment }));
        return { document, omitted: g.omitted };
      }));
    },
    /** Asks the configured language model for draft proposals. They are stored as suggestions labelled invention (or inference) with no sources. */
    async proposeDrafts(ctx: ServiceContext, documentId: string, input: { instruction: string; blockIds?: readonly string[]; mode?: 'creative' | 'analytical'; count?: number; idempotencyKey?: string }): Promise<{ suggestions: Comment[]; model: string | null }> {
      requireCapability(ctx, 'editorial:write');
      if (ports.model === undefined) throw new DomainError('unavailable', 'No language model is configured (ModelPort); drafts can still be written by hand or generated from a package');
      const model = ports.model;
      const { idempotencyKey, ...rest } = input;
      return sql.tx((tx) => idem(tx, ctx, idempotencyKey, { op: 'propose', documentId, ...rest }, async () => {
        const l = await need(tx, ctx, 'document', documentId);
        const body = l.r.body;
        const mode = input.mode === undefined ? 'creative' : oneOf(input.mode, 'mode', ['creative', 'analytical'] as const);
        const ids = strList(input.blockIds, 'blockIds', 50, 64);
        const selected = ids.length === 0 ? body.blocks.slice(0, 50) : body.blocks.filter((b) => ids.includes(b.id));
        invariant(selected.length === ids.length || ids.length === 0, 'invalid_input', 'blockIds names a block that is not in the current revision');
        const max = Math.min(Math.max(Math.trunc(input.count ?? 3) || 3, 1), 10);
        const answer = await model.propose(ctx, { task: 'draft', mode, instruction: str(input.instruction, 'instruction', 4000), language: body.language, docType: body.docType, title: body.title, blocks: selected.map((b) => ({ id: b.id, type: b.type, basis: b.basis, text: b.text })), maxProposals: max });
        const defaults: Record<string, [Block['type'], Record<string, Json>]> = { outline: ['outline_node', { level: 1 }], treatment: ['treatment_section', {}], lyrics: ['lyric_section', { part: 'verse' }], script: ['script_element', { element: 'action' }], storyboard: ['scene', { purpose: 'Proposed scene', participants: [], panels: [] }], interview_plan: ['interview_question', { sensitivities: [], consentPrerequisites: [], followUps: [] }] };
        const suggestions: Comment[] = [];
        for (const raw of (Array.isArray(answer?.proposals) ? answer.proposals : []).slice(0, max)) {
          // Model output is data: only its text is used. Labels, sources and targets outside the request are ignored.
          if (!isRec(raw) || typeof raw.text !== 'string') continue;
          // eslint-disable-next-line no-control-regex
          const text = raw.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 20_000);
          if (text.trim() === '') continue;
          const target = typeof raw.targetBlockId === 'string' && ids.includes(raw.targetBlockId) ? body.blocks.find((b) => b.id === raw.targetBlockId) : undefined;
          if (target === undefined && body.docType === 'interactive_story') continue;
          const [type, data] = target !== undefined ? [target.type, target.data] as const : defaults[body.docType] ?? ['passage', {}] as const;
          const id = randomUUID();
          const block = normalizeBlock({ id: target?.id ?? `m-${id.slice(0, 8)}`, type, text, basis: mode === 'creative' ? 'invention' : 'inference', sources: [], ...(mode === 'creative' ? { disclosure: notice(body.language, 'modelDisclosure') } : {}), note: mode === 'analytical' ? notice(body.language, 'modelDisclosure') : undefined, generated: { by: 'model', role: 'content', ...(typeof answer.model === 'string' ? { name: answer.model.slice(0, 100) } : {}) }, data });
          const proposal: SuggestionProposal = target !== undefined ? { mode: 'replace', blockId: target.id, block } : { mode: 'insert', block };
          const row = (await tx.query(`insert into ${S}.comments (tenant_id, project_id, id, object_id, revision, block_id, kind, body, proposal, origin, author_id, created_at) values ($1,$2,$3,$4,$5,$6,'suggestion',$7,$8::jsonb,'model',$9,$10) returning *`, [...scope(ctx), id, documentId, l.o.revision, target?.id ?? null, typeof raw.rationale === 'string' && raw.rationale.trim() !== '' ? raw.rationale.slice(0, 2000) : 'Machine-proposed draft', JSON.stringify(proposal), ctx.actor.id, ctx.now]))[0] as Record<string, unknown>;
          await emitEvent(tx, S, ctx, 'editorial.suggestion_proposed', uref(EID, 'document', documentId, l.o.revision), { suggestion: id, origin: 'model' });
          suggestions.push(toComment(row));
        }
        await appendAudit(tx, S, ctx, 'document.model_proposals', uref(EID, 'document', documentId), { revision: l.o.revision, mode, proposals: suggestions.length });
        return { suggestions, model: typeof answer?.model === 'string' ? answer.model.slice(0, 100) : null };
      }));
    },
    async analyzeLyrics(ctx: ServiceContext, input: { text: string; language: string; meter?: string }): Promise<LyricAnalysis> {
      requireCapability(ctx, 'editorial:read');
      return analyze(str(input.text, 'text', 50_000), languageTag(input.language), pack({ meter: optStr(input.meter, 'meter', 200), languages: cfg.languages }));
    },
    /** Rhyme candidates come from the caller, the named document and the deployment lexicon for the language; there is no built-in dictionary. */
    async suggestRhymes(ctx: ServiceContext, input: { word: string; language: string; candidates?: readonly string[]; documentId?: string; limit?: number }): Promise<RhymeSuggestion[]> {
      requireCapability(ctx, 'editorial:read');
      const lang = languageTag(input.language);
      const pool = [...strList(input.candidates, 'candidates', 5000, 100), ...(cfg.lexicons?.[lang] ?? cfg.lexicons?.[lang.split('-')[0] as string] ?? [])];
      if (input.documentId !== undefined) pool.push(...vocabulary((await need(sql, ctx, 'document', input.documentId)).r.body.blocks.map((b) => b.text), lang, cfg.languages));
      return rhymes(str(input.word, 'word', 100), pool, lang, pack({ limit: input.limit, languages: cfg.languages }));
    },
    /** Where a registered asset or a viewpoint is used (current revisions). */
    async usage(ctx: ServiceContext, kind: 'asset' | 'viewpoint', id: string): Promise<{ ref: string; usedBy: { document: string; title: string; blockIds: string[] }[] }> {
      requireCapability(ctx, 'editorial:read');
      await need(sql, ctx, oneOf(kind, 'kind', ['asset', 'viewpoint'] as const), id);
      const rows = await sql.query<{ id: string; revision: number; title: string; blocks: string[] }>(`select o.id, o.revision, o.title, array_agg(distinct l.block_id) as blocks from ${S}.links l join ${S}.objects o on o.tenant_id=l.tenant_id and o.project_id=l.project_id and o.id=l.object_id and o.revision=l.revision
        where l.tenant_id=$1 and l.project_id=$2 and l.ref_engine=$3 and l.ref_kind=$4 and l.ref_id=$5 and (o.compartment is null or o.compartment = any($6::text[])) group by o.id, o.revision, o.title order by o.title, o.id`, [...scope(ctx), EID, kind, id, [...ctx.compartments]]);
      return { ref: uref(EID, kind, id), usedBy: rows.map((r) => ({ document: uref(EID, 'document', r.id, r.revision), title: r.title, blockIds: r.blocks.filter((b) => b !== '') })) };
    },
    /** Catalog route POST /v1/scenes: appends (or inserts) one scene block as a new document revision. */
    async addScene(ctx: ServiceContext, input: { documentId: string; expectedRevision: number; scene: unknown; afterBlockId?: string } & SaveOptions): Promise<Stored<'document'>> {
      requireCapability(ctx, 'editorial:write');
      const { documentId, expectedRevision, scene, afterBlockId, ...rest } = input;
      const l = await need(sql, ctx, 'document', documentId);
      const block = normalizeBlock(isRec(scene) ? { type: 'scene', ...scene } : scene, 'scene');
      invariant(block.type === 'scene', 'invalid_input', 'scene must be a scene block');
      return engine.revise(ctx, 'document', documentId, { ...rest, expectedRevision, body: applyProposal(l.r.body, pack({ mode: 'insert' as const, afterBlockId, block }), block) });
    },

    // ── standard surface ──
    async inspect(ctx: ServiceContext, ref: string): Promise<Inspection | null> {
      requireCapability(ctx, 'editorial:read');
      let p: ReturnType<typeof parseUref>;
      try { p = parseUref(ref); } catch { return null; }
      if (p.engine !== EID) return null;
      const [objectId, blockId] = p.kind === 'block' ? [p.id.slice(0, 36), p.id.slice(37)] : [p.id, null];
      const kind = p.kind === 'block' ? 'document' : p.kind;
      if (!(KINDS as readonly string[]).includes(kind)) return null;
      const l = await load(sql, ctx, kind as Kind, objectId, p.revision === undefined ? {} : { revision: p.revision });
      if (l === null) return null;
      const block = blockId === null ? null : (l.r.body as DocumentBody).blocks.find((b) => b.id === blockId) ?? null;
      if (blockId !== null && block === null) return null;
      const flags = (await openFlags(sql, ctx, objectId)).filter((f) => blockId === null || f.blockId === blockId);
      const links = await sql.query<{ block_id: string; role: string; ref: string }>(`select block_id, role, ref from ${S}.links where tenant_id=$1 and project_id=$2 and object_id=$3 and revision=$4 and ($5::text is null or block_id=$5)`, [...scope(ctx), objectId, l.r.revision, blockId]);
      const versions = await engine.history(ctx, kind as Kind, objectId);
      const approvals = (await sql.query(`select * from ${S}.approvals where tenant_id=$1 and project_id=$2 and object_id=$3 order by at`, [...scope(ctx), objectId])).map((r) => toApproval(r, kind as Kind));
      const dependents = blockId !== null ? [] : [
        ...(await sql.query<{ id: string; kind: Kind; revision: number }>(`select distinct o.id, o.kind, o.revision from ${S}.links l join ${S}.objects o on o.tenant_id=l.tenant_id and o.project_id=l.project_id and o.id=l.object_id and o.revision=l.revision where l.tenant_id=$1 and l.project_id=$2 and l.ref_engine=$3 and l.ref_kind=$4 and l.ref_id=$5 and (o.compartment is null or o.compartment = any($6::text[]))`, [...scope(ctx), EID, kind, objectId, [...ctx.compartments]])).map((r) => uref(EID, r.kind, r.id, r.revision)),
        ...(await sql.query<{ id: string; revision: number }>(`select id, revision from ${S}.exports where tenant_id=$1 and project_id=$2 and object_id=$3 and revision=$4`, [...scope(ctx), objectId, l.r.revision])).map((r) => uref(EID, 'export', r.id)),
      ];
      const history = (await listAudit(sql, S, ctx, { subject: uref(EID, kind, objectId), limit: 500 })).map((a) => ({ at: a.at, actorId: a.actorId, action: a.action, detail: a.detail }));
      const body = l.r.body;
      let data: Json; const permissions: Json[] = [];
      if (block !== null) { data = clean({ block, document: uref(EID, 'document', objectId, l.r.revision) }) as unknown as Json; if (isRec(block.verification) && block.verification.useDecision !== undefined) permissions.push(block.verification.useDecision as Json); }
      else if (kind === 'document') { const d = body as DocumentBody; const counts: Record<string, number> = {}; for (const b of d.blocks) counts[b.basis] = (counts[b.basis] ?? 0) + 1; data = clean({ docType: d.docType, language: d.language, editorialProject: uref(EID, 'editorial_project', d.editorialProjectId), translationOf: d.translationOf ?? null, blocks: d.blocks.length, byBasis: counts, meta: d.meta, flaggedBlocks: [...new Set(flags.map((f) => f.blockId).filter((x) => x !== null))] }) as unknown as Json; }
      else { data = body as unknown as Json; if (kind === 'viewpoint') permissions.push({ consentRef: (body as ViewpointBody).consentRef, restrictions: (body as ViewpointBody).restrictions }); if (kind === 'asset') permissions.push({ rightsRef: (body as AssetBody).rightsRef, restrictions: (body as AssetBody).restrictions }); }
      return {
        ref: block === null ? uref(EID, kind, objectId, l.r.revision) : blockRef(objectId, block.id, l.r.revision), kind: block === null ? kind : 'block', title: block === null ? titleOf(kind as Kind, body) : block.text.slice(0, 120),
        state: block === null ? l.r.review_state : block.basis, stale: flags.some((f) => f.kind === 'stale'), blocked: flags.some((f) => f.kind === 'blocked'), staleReasons: flags.map((f) => `${f.kind}: ${f.reason} (cause ${f.cause}; ${f.ref})`),
        versions: versions.map((v) => ({ revision: v.revision, at: v.at, actorId: v.actorId, ...(v.summary === null ? {} : { summary: v.summary }) })),
        sources: [...new Set(links.map((x) => x.ref))].sort(), dependents, permissions, decisions: approvals as unknown as Json[], history, data,
      };
    },
    async search(ctx: ServiceContext, query: { q: string; limit?: number }): Promise<SearchHit[]> {
      requireCapability(ctx, 'editorial:read');
      const q = typeof query?.q === 'string' ? query.q.trim().toLowerCase() : '';
      if (q === '' || q.length > 200) return [];
      const rows = await sql.query<ObjRow & { search_text: string }>(`select * from ${S}.objects where tenant_id=$1 and project_id=$2 and (compartment is null or compartment = any($3::text[])) and position($4 in lower(search_text)) > 0 order by updated_at desc, id limit $5`, [...scope(ctx), [...ctx.compartments], q, Math.min(Math.max(Math.trunc(query.limit ?? 20) || 20, 1), 100)]);
      return rows.map((r) => { const i = r.search_text.toLowerCase().indexOf(q); return { ref: uref(EID, r.kind, r.id, r.revision), kind: r.kind, title: r.title, snippet: r.search_text.slice(Math.max(0, i - 60), i + q.length + 100).replace(/\s+/g, ' ').trim(), state: r.state }; });
    },
    async audit(ctx: ServiceContext, options: { after?: string; limit?: number; subject?: string } = {}): Promise<AuditRecord[]> {
      requireCapability(ctx, 'editorial:read');
      return listAudit(sql, S, ctx, options);
    },
    async events(ctx: ServiceContext, options: { after?: string; limit?: number } = {}): Promise<EngineEvent[]> {
      requireCapability(ctx, 'editorial:events');
      const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
      const out: EngineEvent[] = []; let after = options.after ?? '0';
      for (;;) {
        const page = await readEvents(sql, S, { after, limit: 1000, tenantId: ctx.tenantId });
        for (const e of page) { if (e.projectId === ctx.projectId && out.length < limit) out.push({ ...e, engine: EID }); }
        if (page.length < 1000 || out.length >= limit) break;
        after = (page[page.length - 1] as EngineEvent).id;
      }
      return out;
    },
    /**
     * Marks dependents stale (or blocked for permission_withdrawn). Matching ignores the revision of the changed object:
     * a block citing any revision up to the changed one is affected. Approved revisions keep their text; their approval
     * becomes needs_renewal. Idempotent by eventId.
     */
    async applyUpstreamChange(ctx: ServiceContext, change: UpstreamChange): Promise<{ affected: string[] }> {
      requireCapability(ctx, 'editorial:events');
      const c = rec(change, 'change', ['eventId', 'kind', 'refs', 'reason']);
      const eventId = str(c.eventId, 'eventId', 300), kind = oneOf(c.kind, 'kind', manifest.consumes), reason = str(c.reason, 'reason', 2000);
      invariant(Array.isArray(c.refs) && c.refs.length > 0 && c.refs.length <= 1000, 'invalid_input', 'refs must list 1 to 1000 references');
      const refs = (c.refs as unknown[]).map((r) => { invariant(typeof r === 'string', 'invalid_reference', 'Invalid reference'); parseUref(r); return r; });
      return sql.tx(async (tx) => {
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`e09-upstream:${ctx.tenantId}:${ctx.projectId}:${eventId}`]);
        const done = (await tx.query<{ result: { affected: string[] } }>(`select result from ${S}.upstream_events where tenant_id=$1 and project_id=$2 and event_id=$3`, [...scope(ctx), eventId]))[0];
        if (done !== undefined) return done.result;
        const mode: FlagMode = kind === 'permission_withdrawn' ? 'blocked' : 'stale';
        if (kind === 'permission_withdrawn') for (const ref of refs) { const p = parseUref(ref); await tx.query(`insert into ${S}.withdrawn_refs (tenant_id, project_id, ref_engine, ref_kind, ref_id, cause, reason, at) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`, [...scope(ctx), p.engine, p.kind, p.id, eventId, reason, ctx.now]); }
        if (kind === 'permission_changed' && ports.useDecisions !== undefined) for (const ref of refs) {
          // A changed permission lifts an earlier withdrawal only when E11 now allows adaptation. Existing blocked flags still need a new revision or review.
          const d = await ports.useDecisions.decide(ctx, { subjects: [ref], action: 'adapt', purpose: ctx.purpose });
          const p = parseUref(ref);
          if (d.decision === 'allow') await tx.query(`delete from ${S}.withdrawn_refs where tenant_id=$1 and project_id=$2 and ref_engine=$3 and ref_kind=$4 and ref_id=$5`, [...scope(ctx), p.engine, p.kind, p.id]);
        }
        const affected = await flagDependents(tx, ctx, refs, mode, reason, eventId, kind);
        const result = { affected };
        await tx.query(`insert into ${S}.upstream_events (tenant_id, project_id, event_id, kind, result, at) values ($1,$2,$3,$4,$5::jsonb,$6)`, [...scope(ctx), eventId, kind, JSON.stringify(result), ctx.now]);
        await appendAudit(tx, S, ctx, 'upstream_change.applied', uref(EID, 'upstream_change', sha(eventId).slice(0, 32)), { eventId, kind, refs, affected: affected.length });
        return result;
      });
    },
    async health(): Promise<{ ok: boolean; detail: Json }> {
      try { await sql.query('select 1'); return { ok: true, detail: { database: 'ok', ports: { knowledge: ports.knowledge !== undefined, useDecisions: ports.useDecisions !== undefined, authorization: ports.authorization !== undefined, model: ports.model !== undefined }, standalone: { knowledge: cfg.standalone?.knowledge === true, useDecisions: cfg.standalone?.useDecisions === true }, objectStore: deps.objects !== undefined } }; }
      catch { return { ok: false, detail: { database: 'unavailable' } }; }
    },
  };
  const _check: StandardEngine = engine; void _check;
  return engine;
}

// ───────────────────────────── HTTP ─────────────────────────────
const SEGMENTS: Readonly<Record<string, Kind>> = { series: 'series', collections: 'collection', projects: 'editorial_project', collaborators: 'collaborator', viewpoints: 'viewpoint', assets: 'asset', documents: 'document' };
export function routes(engine: EditorialEngine): Route[] {
  // Request bodies are untyped JSON; every service method validates its input at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Loose = any;
  type H = (r: { params: Readonly<Record<string, string>>; query: URLSearchParams; body: Loose; ctx: ServiceContext }) => Promise<unknown>;
  const route = (method: Route['method'], path: string, h: H, status = 200): Route => ({ method, path, handler: async (r): Promise<HttpResponse> => {
    const raw = r.body === undefined || r.body === null ? {} : r.body;
    invariant(isRec(raw), 'invalid_input', 'The request body must be a JSON object');
    const key = r.headers['idempotency-key'];
    const body = typeof key === 'string' && raw.idempotencyKey === undefined && method !== 'GET' ? { ...raw, idempotencyKey: key } : raw;
    try { return { status, json: await h({ params: r.params, query: r.query, body, ctx: r.ctx }) }; }
    catch (error) {
      // The kit answers 500 for 5xx domain errors; a missing collaborator is an explicit, named 503 here.
      if (error instanceof DomainError && error.code === 'unavailable') return { status: 503, json: { error: { code: 'unavailable', message: error.message } } };
      throw error;
    }
  } });
  const num = (v: string | null): number | undefined => (v === null ? undefined : Number(v));
  const opt = (q: URLSearchParams, names: string[]): Loose => Object.fromEntries(names.filter((n) => q.get(n) !== null).map((n) => [n, q.get(n)]));
  const out: Route[] = [...standardRoutes(engine)];
  for (const [seg, kind] of Object.entries(SEGMENTS)) {
    out.push(
      route('POST', `/v1/${seg}`, (r) => engine.create(r.ctx, kind, r.body), 201),
      route('GET', `/v1/${seg}`, (r) => engine.list(r.ctx, kind, { ...opt(r.query, ['editorialProjectId', 'state', 'docType', 'translationOf']), ...(r.query.get('limit') === null ? {} : { limit: num(r.query.get('limit')) }), ...(r.query.get('offset') === null ? {} : { offset: num(r.query.get('offset')) }) })),
      route('GET', `/v1/${seg}/:id`, (r) => engine.get(r.ctx, kind, r.params.id as string, num(r.query.get('revision')))),
      route('POST', `/v1/${seg}/:id/revisions`, (r) => engine.revise(r.ctx, kind, r.params.id as string, r.body), 201),
      route('GET', `/v1/${seg}/:id/revisions`, (r) => engine.history(r.ctx, kind, r.params.id as string)),
      route('GET', `/v1/${seg}/:id/diff`, (r) => engine.diff(r.ctx, kind, r.params.id as string, Number(r.query.get('from')), Number(r.query.get('to')))),
      route('POST', `/v1/${seg}/:id/restore`, (r) => engine.restore(r.ctx, kind, r.params.id as string, r.body), 201),
      route('POST', `/v1/${seg}/:id/review`, (r) => engine.requestReview(r.ctx, kind, r.params.id as string, r.body)),
      route('POST', `/v1/${seg}/:id/return`, (r) => engine.returnToDraft(r.ctx, kind, r.params.id as string, r.body)),
      route('POST', `/v1/${seg}/:id/approvals`, (r) => engine.approve(r.ctx, kind, r.params.id as string, r.body), 201),
      route('GET', `/v1/${seg}/:id/approvals`, (r) => engine.listApprovals(r.ctx, kind, r.params.id as string)),
      route('POST', `/v1/${seg}/:id/comments`, (r) => engine.addComment(r.ctx, kind, r.params.id as string, r.body), 201),
      route('GET', `/v1/${seg}/:id/comments`, (r) => engine.listComments(r.ctx, kind, r.params.id as string, opt(r.query, ['status', 'kind']))),
      route('POST', `/v1/${seg}/:id/assignments`, (r) => engine.assign(r.ctx, kind, r.params.id as string, r.body), 201),
    );
  }
  out.push(
    route('POST', '/v1/documents/:id/suggestions', (r) => engine.suggest(r.ctx, r.params.id as string, r.body), 201),
    route('POST', '/v1/suggestions/:id/accept', (r) => engine.acceptSuggestion(r.ctx, r.params.id as string, r.body), 201),
    route('POST', '/v1/comments/:id/resolve', (r) => engine.resolveComment(r.ctx, r.params.id as string, r.body)),
    route('GET', '/v1/assignments', (r) => engine.listAssignments(r.ctx, opt(r.query, ['objectId', 'assigneeId', 'status']))),
    route('PATCH', '/v1/assignments/:id', (r) => engine.updateAssignment(r.ctx, r.params.id as string, r.body)),
    route('GET', '/v1/flags', (r) => engine.listFlags(r.ctx, opt(r.query, ['objectId', 'status', 'kind']))),
    route('POST', '/v1/flags/:id/resolve', (r) => engine.resolveFlag(r.ctx, r.params.id as string, r.body)),
    route('POST', '/v1/documents/:id/translations', (r) => engine.createTranslation(r.ctx, { ...r.body, sourceDocumentId: r.params.id as string }), 201),
    route('GET', '/v1/documents/:id/translations', (r) => engine.translationStatus(r.ctx, r.params.id as string)),
    route('GET', '/v1/documents/:id/fact-check', (r) => engine.factCheck(r.ctx, r.params.id as string, num(r.query.get('revision')))),
    route('POST', '/v1/documents/:id/exports', (r) => { const { revision, ...rest } = r.body; return engine.exportDocument(r.ctx, r.params.id as string, revision, rest); }, 201),
    route('GET', '/v1/documents/:id/exports', (r) => engine.listExports(r.ctx, r.params.id as string)),
    route('POST', '/v1/documents/:id/proposals', (r) => engine.proposeDrafts(r.ctx, r.params.id as string, r.body), 201),
    route('POST', '/v1/generate', (r) => engine.generate(r.ctx, r.body), 201),
    route('POST', '/v1/lyrics/analyze', (r) => engine.analyzeLyrics(r.ctx, r.body)),
    route('POST', '/v1/lyrics/rhymes', (r) => engine.suggestRhymes(r.ctx, r.body)),
    route('GET', '/v1/assets/:id/usage', (r) => engine.usage(r.ctx, 'asset', r.params.id as string)),
    route('GET', '/v1/viewpoints/:id/usage', (r) => engine.usage(r.ctx, 'viewpoint', r.params.id as string)),
    // Routes named in the engine catalog, mapped onto the same service methods.
    route('POST', '/v1/creative/projects', (r) => engine.create(r.ctx, 'editorial_project', r.body), 201),
    route('POST', '/v1/stories/:id/versions', (r) => engine.revise(r.ctx, 'document', r.params.id as string, r.body), 201),
    route('POST', '/v1/scenes', (r) => engine.addScene(r.ctx, r.body), 201),
    route('GET', '/v1/stories/:id/fact-map', (r) => engine.factCheck(r.ctx, r.params.id as string, num(r.query.get('revision')))),
  );
  return out;
}
