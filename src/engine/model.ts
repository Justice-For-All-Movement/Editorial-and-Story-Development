// Editorial model: vocabularies, body and block normalisation, basis-label rules, hashing and diffs. Pure functions.
import { createHash } from 'node:crypto';
import { DomainError, canonical, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { parseUref } from '../service-kit.ts';

export const BASES = ['verified_fact', 'attributed_testimony', 'allegation', 'inference', 'reconstruction', 'satire', 'invention', 'unknown_acknowledged'] as const;
export type Basis = typeof BASES[number];
/** Bases whose text is not a factual account and therefore must carry a visible disclosure into every export. */
export const DISCLOSED_BASES: readonly Basis[] = ['reconstruction', 'satire', 'invention'];
/** Bases that assert something about the world and therefore appear in the fact-check ledger as factual statements. */
export const FACTUAL_BASES: readonly Basis[] = ['verified_fact', 'attributed_testimony', 'allegation'];
export const DOWNGRADE_TARGETS: readonly Basis[] = ['allegation', 'inference', 'unknown_acknowledged'];

export const KINDS = ['series', 'collection', 'editorial_project', 'collaborator', 'viewpoint', 'asset', 'document'] as const;
export type Kind = typeof KINDS[number];
export const PROJECT_KINDS = ['factual', 'artistic', 'satire', 'campaign'] as const;
export type ProjectKind = typeof PROJECT_KINDS[number];
export const DEFAULT_FORMATS = ['article', 'report', 'book', 'song', 'album', 'documentary', 'short_film', 'animation', 'audio_piece', 'interactive_story', 'satire', 'campaign_piece', 'other'] as const;
export const DOC_TYPES = ['outline', 'treatment', 'article', 'book_section', 'narrative', 'lyrics', 'script', 'storyboard', 'interview_plan', 'interactive_story', 'notes'] as const;
export type DocType = typeof DOC_TYPES[number];
export const BLOCK_TYPES = ['outline_node', 'treatment_section', 'passage', 'lyric_section', 'script_element', 'scene', 'interview_question', 'story_node'] as const;
export type BlockType = typeof BLOCK_TYPES[number];
export const LYRIC_PARTS = ['intro', 'verse', 'pre_chorus', 'chorus', 'refrain', 'hook', 'bridge', 'outro', 'spoken'] as const;
export const SCRIPT_ELEMENTS = ['scene_heading', 'action', 'dialogue', 'narration', 'on_screen_text', 'parenthetical', 'transition'] as const;
export const ASSET_PROVENANCE = ['archival', 'original_production', 'generated', 'reconstruction'] as const;
export const REVIEW_STATES = ['draft', 'in_review', 'approved', 'superseded'] as const;

export type Generated = { by: 'generator' | 'model'; role: 'content' | 'connective'; name?: string | undefined };
export type Block = {
  id: string; type: BlockType; text: string; basis: Basis; sources: string[];
  sourceSelectors?: Record<string, Json> | undefined; attribution?: string | undefined; disclosure?: string | undefined;
  viewpointId?: string | undefined; note?: string | undefined; generated?: Generated | undefined;
  downgraded?: { from: Basis; reason: string } | undefined;
  translates?: string | undefined;
  /** Server-managed: hash of the translated source block at the pinned source revision. */
  sourceHash?: string | undefined;
  /** Server-managed: knowledge and use-decision results recorded when the block was last saved in changed form. */
  verification?: Record<string, Json> | undefined;
  data: Record<string, Json>;
};
export type Panel = { id: string; description: string; framing?: string; durationSeconds?: number; audioNotes?: string; assetRefs: string[]; disclosure?: string };
export type DocumentBody = { title: string; editorialProjectId: string; docType: DocType; language: string; blocks: Block[]; translationOf?: { documentId: string; revision: number } | undefined; meta: Record<string, Json> };
export type SeriesBody = { title: string; description?: string; projectKind: ProjectKind; publishingIdentity: string; language?: string; status: string; items: { editorialProjectId: string; label?: string }[] };
export type CollectionBody = { title: string; description?: string; items: { ref: string; note?: string }[] };
export type ProjectBody = { title: string; format: string; projectKind: ProjectKind; publishingIdentity: string; language: string; audience?: string; aim?: string; constraints?: string; brief?: string; credits: { collaboratorId: string; role: string; creditLine?: string }[]; investigationRefs: string[] };
export type CollaboratorBody = { name: string; roles: string[]; creditLine: string; actorId?: string; bio?: string; languages: string[] };
export type ViewpointBody = { label: string; participantRef: string; testimonyRefs: string[]; consentRef: string; attribution: string; summary?: string; perspective?: string; dignityNotes: string[]; restrictions: string[] };
export type AssetBody = { title: string; targetRef: string; mediaKind: string; provenance: typeof ASSET_PROVENANCE[number]; rightsRef: string; approvalRef?: string; description?: string; usageNotes?: string; restrictions: string[]; tags: string[] };
export type Bodies = { series: SeriesBody; collection: CollectionBody; editorial_project: ProjectBody; collaborator: CollaboratorBody; viewpoint: ViewpointBody; asset: AssetBody; document: DocumentBody };

// ───────────────────────────── input helpers ─────────────────────────────
export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
export function rec(v: unknown, label: string, allowed: readonly string[]): Rec {
  invariant(isRec(v), 'invalid_input', `${label} must be an object`);
  for (const k of Object.keys(v)) invariant(allowed.includes(k), 'invalid_input', `${label}: unknown property ${k}`);
  return v;
}
export function str(v: unknown, label: string, max = 2000): string {
  invariant(typeof v === 'string' && v.trim().length > 0 && v.length <= max, 'invalid_input', `${label} must be a non-empty string of at most ${max} characters`);
  return v;
}
export function optStr(v: unknown, label: string, max = 2000): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return str(v, label, max);
}
export function strList(v: unknown, label: string, maxItems = 200, max = 1000): string[] {
  if (v === undefined || v === null) return [];
  invariant(Array.isArray(v) && v.length <= maxItems, 'invalid_input', `${label} must be an array of at most ${maxItems} items`);
  return v.map((x, i) => str(x, `${label}[${i}]`, max));
}
export function oneOf<T extends string>(v: unknown, label: string, values: readonly T[]): T {
  invariant(typeof v === 'string' && (values as readonly string[]).includes(v), 'invalid_input', `${label} must be one of: ${values.join(', ')}`);
  return v as T;
}
export function refStr(v: unknown, label: string): string {
  invariant(typeof v === 'string' && v.length <= 300, 'invalid_reference', `${label} must be a universal reference`);
  parseUref(v);
  return v;
}
export function refList(v: unknown, label: string, maxItems = 100): string[] {
  if (v === undefined || v === null) return [];
  invariant(Array.isArray(v) && v.length <= maxItems, 'invalid_input', `${label} must be an array of at most ${maxItems} references`);
  return [...new Set(v.map((x, i) => refStr(x, `${label}[${i}]`)))];
}
export function uuid(v: unknown, label: string): string {
  invariant(typeof v === 'string' && UUID.test(v), 'invalid_input', `${label} must be an object id`);
  return v;
}
function optNum(v: unknown, label: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  invariant(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max, 'invalid_input', `${label} must be a number between ${min} and ${max}`);
  return v;
}
export function posInt(v: unknown, label: string): number {
  invariant(Number.isSafeInteger(v) && (v as number) > 0, 'invalid_input', `${label} must be a positive integer`);
  return v as number;
}
function json(v: unknown, label: string, maxBytes = 20_000): Json {
  let text: string;
  try { text = JSON.stringify(v); } catch { throw new DomainError('invalid_input', `${label} must be JSON`); }
  invariant(typeof text === 'string' && text.length <= maxBytes, 'invalid_input', `${label} is too large or not JSON`);
  return JSON.parse(text) as Json;
}
/** Removes undefined properties so the value is plain JSON (canonical hashing, jsonb storage). */
export function clean<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
/** clean() for object literals with optional members: the result type is asserted by the caller. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pack(v: object): any { return JSON.parse(JSON.stringify(v)); }
export function language(v: unknown, label = 'language'): string {
  invariant(typeof v === 'string' && LANG.test(v), 'invalid_input', `${label} must be a language tag such as en or pt-BR`);
  return v;
}
const basisErr = (message: string): never => { throw new DomainError('invalid_basis', message); };

// ───────────────────────────── blocks ─────────────────────────────
function blockData(type: BlockType, raw: unknown, at: string): Record<string, Json> {
  const d = raw === undefined || raw === null ? {} : raw;
  switch (type) {
    case 'outline_node': { const r = rec(d, at, ['level', 'parentId']); return pack({ level: optNum(r.level, `${at}.level`, 1, 6) ?? 1, parentId: optStr(r.parentId, `${at}.parentId`, 64) }); }
    case 'treatment_section': { const r = rec(d, at, ['heading']); return pack({ heading: optStr(r.heading, `${at}.heading`, 300) }); }
    case 'passage': { const r = rec(d, at, ['heading', 'role']); return pack({ heading: optStr(r.heading, `${at}.heading`, 300), role: optStr(r.role, `${at}.role`, 40) }); }
    case 'lyric_section': {
      const r = rec(d, at, ['part', 'label', 'meter', 'syllables', 'rhymeScheme', 'melodyHint', 'tempoBpm', 'key']);
      const syl = r.syllables === undefined || r.syllables === null ? undefined : (invariant(Array.isArray(r.syllables) && r.syllables.length <= 400 && r.syllables.every((n) => Number.isSafeInteger(n) && n >= 0 && n < 200), 'invalid_input', `${at}.syllables must be an array of counts`), r.syllables as number[]);
      return pack({ part: oneOf(r.part, `${at}.part`, LYRIC_PARTS), label: optStr(r.label, `${at}.label`, 100), meter: optStr(r.meter, `${at}.meter`, 200), syllables: syl, rhymeScheme: optStr(r.rhymeScheme, `${at}.rhymeScheme`, 100), melodyHint: optStr(r.melodyHint, `${at}.melodyHint`, 1000), tempoBpm: optNum(r.tempoBpm, `${at}.tempoBpm`, 20, 400), key: optStr(r.key, `${at}.key`, 40) });
    }
    case 'script_element': {
      const r = rec(d, at, ['element', 'character', 'parenthetical', 'sceneRef']);
      const element = oneOf(r.element, `${at}.element`, SCRIPT_ELEMENTS);
      const character = optStr(r.character, `${at}.character`, 200);
      invariant(element !== 'dialogue' || character !== undefined, 'invalid_input', `${at}.character is required for dialogue`);
      return pack({ element, character, parenthetical: optStr(r.parenthetical, `${at}.parenthetical`, 300), sceneRef: optStr(r.sceneRef, `${at}.sceneRef`, 64) });
    }
    case 'scene': {
      const r = rec(d, at, ['purpose', 'location', 'time', 'participants', 'panels']);
      invariant(r.panels === undefined || (Array.isArray(r.panels) && r.panels.length <= 200), 'invalid_input', `${at}.panels must be an array`);
      const ids = new Set<string>();
      const panels = ((r.panels as unknown[] | undefined) ?? []).map((p, i) => {
        const pr = rec(p, `${at}.panels[${i}]`, ['id', 'description', 'framing', 'durationSeconds', 'audioNotes', 'assetRefs', 'disclosure']);
        const id = str(pr.id, `${at}.panels[${i}].id`, 64);
        invariant(BLOCK_ID.test(id) && !ids.has(id), 'invalid_input', `${at}.panels[${i}].id must be unique within the scene`); ids.add(id);
        return pack({ id, description: str(pr.description, `${at}.panels[${i}].description`, 4000), framing: optStr(pr.framing, 'framing', 300), durationSeconds: optNum(pr.durationSeconds, 'durationSeconds', 0, 86_400), audioNotes: optStr(pr.audioNotes, 'audioNotes', 2000), assetRefs: refList(pr.assetRefs, 'assetRefs', 50), disclosure: optStr(pr.disclosure, 'disclosure', 1000) });
      });
      return pack({ purpose: str(r.purpose, `${at}.purpose`, 2000), location: optStr(r.location, `${at}.location`, 500), time: optStr(r.time, `${at}.time`, 200), participants: strList(r.participants, `${at}.participants`, 100, 300), panels }) as Record<string, Json>;
    }
    case 'interview_question': { const r = rec(d, at, ['sensitivities', 'consentPrerequisites', 'followUps']); return { sensitivities: strList(r.sensitivities, `${at}.sensitivities`, 50), consentPrerequisites: strList(r.consentPrerequisites, `${at}.consentPrerequisites`, 50), followUps: strList(r.followUps, `${at}.followUps`, 50) }; }
    case 'story_node': {
      const r = rec(d, at, ['key', 'start', 'ending', 'choices']);
      const key = str(r.key, `${at}.key`, 64); invariant(BLOCK_ID.test(key), 'invalid_input', `${at}.key must be a slug`);
      invariant(r.choices === undefined || (Array.isArray(r.choices) && r.choices.length <= 20), 'invalid_input', `${at}.choices must be an array of at most 20`);
      const choices = ((r.choices as unknown[] | undefined) ?? []).map((c, i) => {
        const cr = rec(c, `${at}.choices[${i}]`, ['label', 'to', 'condition', 'effects']);
        let condition: Json | undefined;
        if (cr.condition !== undefined && cr.condition !== null) {
          const co = rec(cr.condition, 'condition', ['var', 'op', 'value']);
          condition = pack({ var: str(co.var, 'condition.var', 64), op: oneOf(co.op, 'condition.op', ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'set', 'unset'] as const), value: co.value === undefined ? undefined : json(co.value, 'condition.value', 200) }) as Json;
        }
        let effects: Json | undefined;
        if (cr.effects !== undefined && cr.effects !== null) {
          invariant(isRec(cr.effects) && Object.values(cr.effects).every((x) => ['string', 'number', 'boolean'].includes(typeof x)), 'invalid_input', 'effects must map variables to scalar values');
          effects = json(cr.effects, 'effects', 2000);
        }
        return pack({ label: str(cr.label, 'choice.label', 300), to: str(cr.to, 'choice.to', 64), condition, effects });
      });
      invariant(r.start === undefined || typeof r.start === 'boolean', 'invalid_input', `${at}.start must be boolean`);
      return pack({ key, start: r.start === true ? true : undefined, ending: optStr(r.ending, `${at}.ending`, 200), choices }) as Record<string, Json>;
    }
  }
}

const BLOCK_KEYS = ['id', 'type', 'text', 'basis', 'sources', 'sourceSelectors', 'attribution', 'disclosure', 'viewpointId', 'note', 'generated', 'downgraded', 'translates', 'sourceHash', 'verification', 'data'];
/** Shape validation only. `basis` is required and has no default; rule checks are in checkBasisRules. */
export function normalizeBlock(raw: unknown, at = 'block'): Block {
  const r = rec(raw, at, BLOCK_KEYS);
  const id = str(r.id, `${at}.id`, 64); invariant(BLOCK_ID.test(id), 'invalid_input', `${at}.id may contain letters, digits, _ and -`);
  const type = oneOf(r.type, `${at}.type`, BLOCK_TYPES);
  if (r.basis === undefined || r.basis === null || r.basis === '') basisErr(`${at}: a basis label is required (${BASES.join(', ')})`);
  if (typeof r.basis !== 'string' || !(BASES as readonly string[]).includes(r.basis)) basisErr(`${at}: unknown basis label`);
  const sources = refList(r.sources, `${at}.sources`, 50);
  let sourceSelectors: Record<string, Json> | undefined;
  if (r.sourceSelectors !== undefined && r.sourceSelectors !== null) {
    invariant(isRec(r.sourceSelectors), 'invalid_input', `${at}.sourceSelectors must map source references to selectors`);
    for (const k of Object.keys(r.sourceSelectors)) invariant(sources.includes(k), 'invalid_input', `${at}.sourceSelectors: ${k} is not one of the block's sources`);
    sourceSelectors = json(r.sourceSelectors, `${at}.sourceSelectors`) as Record<string, Json>;
  }
  let generated: Generated | undefined;
  if (r.generated !== undefined && r.generated !== null) {
    const g = rec(r.generated, `${at}.generated`, ['by', 'role', 'name']);
    generated = pack({ by: oneOf(g.by, 'generated.by', ['generator', 'model'] as const), role: oneOf(g.role, 'generated.role', ['content', 'connective'] as const), name: optStr(g.name, 'generated.name', 100) });
  }
  let downgraded: Block['downgraded'];
  if (r.downgraded !== undefined && r.downgraded !== null) { const g = rec(r.downgraded, `${at}.downgraded`, ['from', 'reason']); downgraded = { from: oneOf(g.from, 'downgraded.from', BASES), reason: str(g.reason, 'downgraded.reason', 1000) }; }
  return pack({
    id, type, text: str(r.text, `${at}.text`, 20_000), basis: r.basis as Basis, sources, sourceSelectors,
    attribution: optStr(r.attribution, `${at}.attribution`, 500), disclosure: optStr(r.disclosure, `${at}.disclosure`, 1000),
    viewpointId: r.viewpointId === undefined || r.viewpointId === null ? undefined : uuid(r.viewpointId, `${at}.viewpointId`),
    note: optStr(r.note, `${at}.note`, 4000), generated, downgraded, translates: optStr(r.translates, `${at}.translates`, 64),
    data: blockData(type, r.data, `${at}.data`),
  });
}

export type RuleContext = Readonly<{ projectKind: ProjectKind; isFactSource: (ref: string) => boolean; isTestimonySource: (ref: string) => boolean; viewpointTestimony?: readonly string[] | undefined }>;
/** Basis-label rules that need no collaborator. Throws DomainError('invalid_basis'). */
export function checkBasisRules(b: Block, c: RuleContext): void {
  const at = `block ${b.id}`;
  if (b.basis === 'verified_fact' && !b.sources.some(c.isFactSource)) basisErr(`${at}: verified_fact requires at least one claim or finding source`);
  if (b.basis === 'attributed_testimony') {
    if (b.attribution === undefined) basisErr(`${at}: attributed_testimony requires an attribution`);
    const vt = c.viewpointTestimony ?? [];
    if (!b.sources.some((s) => c.isTestimonySource(s) || vt.includes(s))) basisErr(`${at}: attributed_testimony requires a testimony source`);
  }
  if (b.basis === 'allegation' && b.attribution === undefined && b.sources.length === 0) basisErr(`${at}: an allegation requires an attribution or a source`);
  if (DISCLOSED_BASES.includes(b.basis) && b.disclosure === undefined) basisErr(`${at}: ${b.basis} requires a disclosure that will appear in every export`);
  if (b.basis === 'satire' && c.projectKind !== 'satire') basisErr(`${at}: satire belongs in an editorial project of kind satire, not ${c.projectKind}`);
}

export function panelsOf(b: Block): Panel[] { return b.type === 'scene' ? ((b.data.panels as unknown as Panel[] | undefined) ?? []) : []; }
/** Content identity of a block: what a reader, translator or fact-checker would consider "the same block". */
export function blockHash(b: Block): string {
  return createHash('sha256').update(canonical(pack({ type: b.type, text: b.text, basis: b.basis, sources: [...b.sources].sort(), sourceSelectors: b.sourceSelectors ?? null, attribution: b.attribution ?? null, disclosure: b.disclosure ?? null, viewpointId: b.viewpointId ?? null, data: b.data }))).digest('hex');
}
export function bodyDigest(body: unknown): string { return createHash('sha256').update(canonical(clean(body))).digest('hex'); }

function validateStructure(blocks: readonly Block[], docType: DocType): void {
  const ids = new Set<string>();
  for (const b of blocks) { invariant(!ids.has(b.id), 'invalid_input', `Duplicate block id ${b.id}`); ids.add(b.id); }
  const seen = new Set<string>();
  for (const b of blocks) {
    if (b.type === 'outline_node' && typeof b.data.parentId === 'string') invariant(seen.has(b.data.parentId), 'invalid_input', `block ${b.id}: parentId must name an earlier outline node`);
    if (b.type === 'script_element' && typeof b.data.sceneRef === 'string') invariant(ids.has(b.data.sceneRef), 'invalid_input', `block ${b.id}: sceneRef names no block`);
    invariant(b.type !== 'story_node' || docType === 'interactive_story', 'invalid_input', `block ${b.id}: story nodes belong in an interactive_story document`);
    if (b.type === 'outline_node') seen.add(b.id);
  }
  const nodes = blocks.filter((b) => b.type === 'story_node');
  if (nodes.length > 0) storyGraph(blocks);
}
export type StoryGraph = { start: string; nodes: { key: string; blockId: string; ending: string | null; choices: { label: string; to: string; condition?: Json; effects?: Json }[] }[]; endings: string[]; variables: string[] };
/** Validates an interactive story: unique keys, one start, resolvable choices, no dead ends, everything reachable. */
export function storyGraph(blocks: readonly Block[]): StoryGraph {
  const nodes = blocks.filter((b) => b.type === 'story_node').map((b) => ({ key: b.data.key as string, blockId: b.id, ending: (b.data.ending as string | undefined) ?? null, start: b.data.start === true, choices: (b.data.choices as unknown as StoryGraph['nodes'][number]['choices']) ?? [] }));
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  invariant(byKey.size === nodes.length, 'invalid_input', 'Story node keys must be unique');
  const starts = nodes.filter((n) => n.start);
  invariant(starts.length === 1, 'invalid_input', 'An interactive story needs exactly one start node');
  const variables = new Set<string>();
  for (const n of nodes) {
    invariant(n.ending !== null || n.choices.length > 0, 'invalid_input', `Story node ${n.key} is a dead end: give it choices or mark it as an ending`);
    invariant(n.ending === null || n.choices.length === 0, 'invalid_input', `Story node ${n.key} is an ending and cannot offer choices`);
    for (const c of n.choices) {
      invariant(byKey.has(c.to), 'invalid_input', `Story node ${n.key}: choice leads to unknown node ${c.to}`);
      if (isRec(c.condition)) variables.add(c.condition.var as string);
      if (isRec(c.effects)) for (const k of Object.keys(c.effects)) variables.add(k);
    }
  }
  const start = (starts[0] as { key: string }).key;
  const reached = new Set<string>([start]); const queue = [start];
  while (queue.length > 0) for (const c of (byKey.get(queue.pop() as string) as { choices: { to: string }[] }).choices) if (!reached.has(c.to)) { reached.add(c.to); queue.push(c.to); }
  for (const n of nodes) invariant(reached.has(n.key), 'invalid_input', `Story node ${n.key} cannot be reached from the start`);
  const endings = nodes.filter((n) => n.ending !== null).map((n) => n.key);
  invariant(endings.length > 0, 'invalid_input', 'An interactive story needs at least one ending');
  return { start, nodes: nodes.map(({ start: _s, ...n }) => n), endings, variables: [...variables].sort() };
}

// ───────────────────────────── bodies ─────────────────────────────
export function normalizeBody<K extends Kind>(kind: K, raw: unknown, formats: readonly string[] = DEFAULT_FORMATS): Bodies[K] {
  const out = ((): Bodies[Kind] => {
    switch (kind as Kind) {
      case 'series': {
        const r = rec(raw, 'series', ['title', 'description', 'projectKind', 'publishingIdentity', 'language', 'status', 'items']);
        invariant(r.items === undefined || (Array.isArray(r.items) && r.items.length <= 2000), 'invalid_input', 'items must be an array');
        const items = ((r.items as unknown[] | undefined) ?? []).map((x, i) => { const it = rec(x, `items[${i}]`, ['editorialProjectId', 'label']); return pack({ editorialProjectId: uuid(it.editorialProjectId, `items[${i}].editorialProjectId`), label: optStr(it.label, 'label', 300) }); });
        invariant(new Set(items.map((i) => i.editorialProjectId)).size === items.length, 'invalid_input', 'A series lists each editorial project once');
        return pack({ title: str(r.title, 'title', 300), description: optStr(r.description, 'description', 4000), projectKind: oneOf(r.projectKind, 'projectKind', PROJECT_KINDS), publishingIdentity: str(r.publishingIdentity, 'publishingIdentity', 300), language: r.language === undefined || r.language === null ? undefined : language(r.language), status: r.status === undefined ? 'active' : oneOf(r.status, 'status', ['active', 'paused', 'concluded'] as const), items }) as SeriesBody;
      }
      case 'collection': {
        const r = rec(raw, 'collection', ['title', 'description', 'items']);
        invariant(r.items === undefined || (Array.isArray(r.items) && r.items.length <= 5000), 'invalid_input', 'items must be an array');
        const items = ((r.items as unknown[] | undefined) ?? []).map((x, i) => { const it = rec(x, `items[${i}]`, ['ref', 'note']); return pack({ ref: refStr(it.ref, `items[${i}].ref`), note: optStr(it.note, 'note', 1000) }); });
        return pack({ title: str(r.title, 'title', 300), description: optStr(r.description, 'description', 4000), items }) as CollectionBody;
      }
      case 'editorial_project': {
        const r = rec(raw, 'editorial project', ['title', 'format', 'projectKind', 'publishingIdentity', 'language', 'audience', 'aim', 'constraints', 'brief', 'credits', 'investigationRefs']);
        invariant(r.credits === undefined || (Array.isArray(r.credits) && r.credits.length <= 500), 'invalid_input', 'credits must be an array');
        const credits = ((r.credits as unknown[] | undefined) ?? []).map((x, i) => { const it = rec(x, `credits[${i}]`, ['collaboratorId', 'role', 'creditLine']); return pack({ collaboratorId: uuid(it.collaboratorId, `credits[${i}].collaboratorId`), role: str(it.role, 'role', 100), creditLine: optStr(it.creditLine, 'creditLine', 300) }); });
        const projectKind = oneOf(r.projectKind, 'projectKind', PROJECT_KINDS);
        const format = oneOf(r.format, 'format', formats);
        invariant(format !== 'satire' || projectKind === 'satire', 'invalid_input', 'The satire format requires projectKind satire');
        invariant(format !== 'campaign_piece' || projectKind === 'campaign', 'invalid_input', 'The campaign_piece format requires projectKind campaign');
        return pack({ title: str(r.title, 'title', 300), format, projectKind, publishingIdentity: str(r.publishingIdentity, 'publishingIdentity', 300), language: language(r.language), audience: optStr(r.audience, 'audience', 1000), aim: optStr(r.aim, 'aim', 2000), constraints: optStr(r.constraints, 'constraints', 4000), brief: optStr(r.brief, 'brief', 20_000), credits, investigationRefs: refList(r.investigationRefs, 'investigationRefs') }) as ProjectBody;
      }
      case 'collaborator': {
        const r = rec(raw, 'collaborator', ['name', 'roles', 'creditLine', 'actorId', 'bio', 'languages']);
        return pack({ name: str(r.name, 'name', 300), roles: strList(r.roles, 'roles', 30, 100), creditLine: str(r.creditLine, 'creditLine', 300), actorId: optStr(r.actorId, 'actorId', 200), bio: optStr(r.bio, 'bio', 4000), languages: strList(r.languages, 'languages', 30, 40) }) as CollaboratorBody;
      }
      case 'viewpoint': {
        const r = rec(raw, 'viewpoint', ['label', 'participantRef', 'testimonyRefs', 'consentRef', 'attribution', 'summary', 'perspective', 'dignityNotes', 'restrictions']);
        const testimonyRefs = refList(r.testimonyRefs, 'testimonyRefs', 50);
        invariant(testimonyRefs.length > 0, 'invalid_input', 'A viewpoint is based on at least one testimony reference');
        return pack({ label: str(r.label, 'label', 300), participantRef: refStr(r.participantRef, 'participantRef'), testimonyRefs, consentRef: refStr(r.consentRef, 'consentRef'), attribution: str(r.attribution, 'attribution', 500), summary: optStr(r.summary, 'summary', 10_000), perspective: optStr(r.perspective, 'perspective', 4000), dignityNotes: strList(r.dignityNotes, 'dignityNotes', 50, 2000), restrictions: strList(r.restrictions, 'restrictions', 50, 1000) }) as ViewpointBody;
      }
      case 'asset': {
        const r = rec(raw, 'asset', ['title', 'targetRef', 'mediaKind', 'provenance', 'rightsRef', 'approvalRef', 'description', 'usageNotes', 'restrictions', 'tags']);
        const targetRef = refStr(r.targetRef, 'targetRef'); const provenance = oneOf(r.provenance, 'provenance', ASSET_PROVENANCE);
        invariant(provenance !== 'archival' || parseUref(targetRef).engine === 'E05', 'invalid_input', 'An archival asset must reference preserved evidence (E05); generated or produced material cannot be registered as archival');
        return pack({ title: str(r.title, 'title', 300), targetRef, mediaKind: str(r.mediaKind, 'mediaKind', 60), provenance, rightsRef: refStr(r.rightsRef, 'rightsRef'), approvalRef: r.approvalRef === undefined || r.approvalRef === null ? undefined : refStr(r.approvalRef, 'approvalRef'), description: optStr(r.description, 'description', 4000), usageNotes: optStr(r.usageNotes, 'usageNotes', 4000), restrictions: strList(r.restrictions, 'restrictions', 50), tags: strList(r.tags, 'tags', 50, 80) }) as AssetBody;
      }
      case 'document': {
        const r = rec(raw, 'document', ['title', 'editorialProjectId', 'docType', 'language', 'blocks', 'translationOf', 'meta']);
        invariant(Array.isArray(r.blocks) && r.blocks.length <= 5000, 'invalid_input', 'blocks must be an array of at most 5000 blocks');
        const docType = oneOf(r.docType, 'docType', DOC_TYPES);
        const blocks = (r.blocks as unknown[]).map((b, i) => normalizeBlock(b, `blocks[${i}]`));
        validateStructure(blocks, docType);
        let translationOf: DocumentBody['translationOf'];
        if (r.translationOf !== undefined && r.translationOf !== null) { const t = rec(r.translationOf, 'translationOf', ['documentId', 'revision']); translationOf = { documentId: uuid(t.documentId, 'translationOf.documentId'), revision: posInt(t.revision, 'translationOf.revision') }; }
        for (const b of blocks) invariant(b.translates === undefined || translationOf !== undefined, 'invalid_input', `block ${b.id}: translates is only valid in a translation document`);
        const meta = r.meta === undefined || r.meta === null ? {} : (invariant(isRec(r.meta), 'invalid_input', 'meta must be an object'), json(r.meta, 'meta', 50_000) as Record<string, Json>);
        return pack({ title: str(r.title, 'title', 300), editorialProjectId: uuid(r.editorialProjectId, 'editorialProjectId'), docType, language: language(r.language), blocks, translationOf, meta }) as DocumentBody;
      }
    }
  })();
  return out as Bodies[K];
}
export function titleOf(kind: Kind, body: Bodies[Kind]): string { return kind === 'collaborator' ? (body as CollaboratorBody).name : kind === 'viewpoint' ? (body as ViewpointBody).label : (body as { title: string }).title; }

// ───────────────────────────── diffs ─────────────────────────────
export type TextOp = { op: 'eq' | 'add' | 'del'; text: string };
/** Word-level diff (longest common subsequence). Very large inputs fall back to whole-text replacement. */
export function diffText(a: string, b: string): TextOp[] {
  if (a === b) return a === '' ? [] : [{ op: 'eq', text: a }];
  const ta = a.split(/(\s+)/).filter((s) => s !== ''), tb = b.split(/(\s+)/).filter((s) => s !== '');
  const n = ta.length, m = tb.length;
  if (n * m > 4_000_000) return [{ op: 'del', text: a }, { op: 'add', text: b }];
  const w = m + 1; const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = ta[i] === tb[j] ? (dp[(i + 1) * w + j + 1] as number) + 1 : Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
  const out: TextOp[] = [];
  const push = (op: TextOp['op'], text: string): void => { const last = out[out.length - 1]; if (last !== undefined && last.op === op) last.text += text; else out.push({ op, text }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) { push('eq', ta[i] as string); i++; j++; }
    else if ((dp[(i + 1) * w + j] as number) >= (dp[i * w + j + 1] as number)) push('del', ta[i++] as string);
    else push('add', tb[j++] as string);
  }
  while (i < n) push('del', ta[i++] as string);
  while (j < m) push('add', tb[j++] as string);
  return out;
}
export type FieldChange = { path: string; from: Json | null; to: Json | null };
export function diffJson(a: unknown, b: unknown, path = ''): FieldChange[] {
  if (isRec(a) && isRec(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((k) => diffJson(a[k], b[k], path === '' ? k : `${path}.${k}`));
  return canonical(clean(a ?? null)) === canonical(clean(b ?? null)) ? [] : [{ path, from: (a ?? null) as Json, to: (b ?? null) as Json }];
}
export type BlockDiff = { added: { id: string; position: number; basis: Basis }[]; removed: { id: string; position: number; basis: Basis }[]; moved: { id: string; from: number; to: number }[]; changed: { id: string; fields: string[]; basis?: { from: Basis; to: Basis }; text?: TextOp[] }[]; unchanged: number };
export function diffBlocks(a: readonly Block[], b: readonly Block[]): BlockDiff {
  const ia = new Map(a.map((x, i) => [x.id, i])), ib = new Map(b.map((x, i) => [x.id, i]));
  const out: BlockDiff = { added: [], removed: [], moved: [], changed: [], unchanged: 0 };
  a.forEach((x, i) => { if (!ib.has(x.id)) out.removed.push({ id: x.id, position: i, basis: x.basis }); });
  b.forEach((x, i) => { if (!ia.has(x.id)) out.added.push({ id: x.id, position: i, basis: x.basis }); });
  // Blocks whose relative order among the common blocks changed: those outside a longest increasing run.
  const common = b.filter((x) => ia.has(x.id)).map((x) => ia.get(x.id) as number);
  const tails: number[] = [], prev: number[] = [], idx: number[] = [];
  common.forEach((v, i) => { let lo = 0, hi = tails.length; while (lo < hi) { const mid = (lo + hi) >> 1; if ((tails[mid] as number) < v) lo = mid + 1; else hi = mid; } tails[lo] = v; idx[lo] = i; prev[i] = lo > 0 ? (idx[lo - 1] as number) : -1; });
  const keep = new Set<number>(); for (let k = tails.length > 0 ? (idx[tails.length - 1] as number) : -1; k >= 0; k = prev[k] as number) keep.add(common[k] as number);
  for (const x of b) {
    const from = ia.get(x.id); if (from === undefined) continue;
    const old = a[from] as Block;
    if (!keep.has(from)) out.moved.push({ id: x.id, from, to: ib.get(x.id) as number });
    const fields = (['type', 'text', 'basis', 'sources', 'sourceSelectors', 'attribution', 'disclosure', 'viewpointId', 'note', 'data', 'translates'] as const).filter((f) => canonical(clean(old[f] ?? null)) !== canonical(clean(x[f] ?? null)));
    if (fields.length === 0) { out.unchanged++; continue; }
    out.changed.push({ id: x.id, fields: [...fields], ...(old.basis === x.basis ? {} : { basis: { from: old.basis, to: x.basis } }), ...(old.text === x.text ? {} : { text: diffText(old.text, x.text) }) });
  }
  return out;
}
