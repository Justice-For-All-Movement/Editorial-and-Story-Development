// Deterministic first-draft generators over an E08 investigation package (schema investigation-package/v1).
// Nothing here writes prose of its own beyond short, configurable connective templates, and those are labelled as
// generated connective text with a disclosure. Every statement taken from the package keeps its label and its sources.
import { invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { parseUref } from '../service-kit.ts';
import { isRec } from './model.ts';
import type { Basis, Block, DocType, ViewpointBody } from './model.ts';
import { languageData, syllablesInWord, wordsOf, wrapBySyllables } from './lyrics.ts';
import type { LanguageSet } from './lyrics.ts';

export const GENERATORS = ['outline', 'treatment', 'narrative', 'lyrics', 'script', 'storyboard', 'interactive', 'interview_plan'] as const;
export type GeneratorName = typeof GENERATORS[number];
export const GENERATOR_DOC_TYPE: Readonly<Record<GeneratorName, DocType>> = { outline: 'outline', treatment: 'treatment', narrative: 'narrative', lyrics: 'lyrics', script: 'script', storyboard: 'storyboard', interactive: 'interactive_story', interview_plan: 'interview_plan' };

export const DEFAULT_TEMPLATES: Readonly<Record<string, string>> = {
  connectiveDisclosure: 'Generated connective text. It organises the material and is not a statement of fact.',
  scaffoldDisclosure: 'Generated scaffold line taken from the working title. An artistic choice is still to be made here.',
  opening: 'Working draft built from the investigation package "{title}".',
  established: 'What is established', disputed: 'What is disputed', unknown: 'What is not known', chronology: 'Chronology', undated: 'Undated', viewpoints: 'Points of view', account: 'The original account',
  disputedAttribution: 'Disputed in the investigation record', accountAttribution: 'The original account, as received', recordAttribution: 'Attributed in the investigation record',
  contradictedNote: 'Contradicting sources are on record for this statement ({count}).', openQuestion: 'Open question: {text}', unknownWhy: '{description} — {why}',
  sceneHeading: 'SCENE {n} — {label}', interviewHeading: 'INTERVIEW — {label}', narrator: 'NARRATOR', scenePurpose: 'Present this point of the record: {label}', panelPending: 'Visual treatment to be decided.',
  startNode: 'Choose a thread of the record to follow.', endNode: 'End of this thread.', continue: 'Continue', backToStart: 'Return to the start', finish: 'Finish',
  askAbout: 'What can you tell us about the following? {text}',
};
export type Templates = Readonly<Record<string, string>>;
const fill = (t: string, vars: Record<string, string | number>): string => t.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ''));

export type PackageItem = { key: string; group: 'established' | 'disputed' | 'unknown'; text: string; basis: Basis; sources: string[]; sourceSelectors: Record<string, Json>; attribution?: string; note?: string; date?: string; claimIds: string[] };
export type ParsedPackage = { ref: string; title: string; items: PackageItem[]; dated: PackageItem[]; account: PackageItem | null; omitted: { ref: string; reason: string }[] };
export type GeneratorViewpoint = { id: string; body: ViewpointBody };
export type GenerateOptions = Readonly<{ templates?: Templates; isTestimonySource: (ref: string) => boolean; language: string; languages?: LanguageSet; lineSyllables?: number }>;

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRec) : []);
const validRef = (v: unknown): v is string => { if (typeof v !== 'string') return false; try { parseUref(v); return true; } catch { return false; } };
const bare = (ref: string): string => ref.split('@')[0] as string;

/** Reads an E08 package ({ ref, content } as returned by E08) into labelled items. Unknown fields are ignored; malformed entries are reported as omitted. */
export function parsePackage(raw: unknown, o: Pick<GenerateOptions, 'templates' | 'isTestimonySource'>): ParsedPackage {
  const t = { ...DEFAULT_TEMPLATES, ...o.templates };
  invariant(isRec(raw) && validRef(raw.ref) && isRec(raw.content), 'invalid_input', 'package must be an investigation package with ref and content');
  const c = raw.content;
  invariant(c.schema === 'investigation-package/v1', 'invalid_input', 'Unsupported investigation package schema');
  const title = isRec(c.investigation) && typeof c.investigation.title === 'string' ? c.investigation.title : 'Untitled';
  const omitted: ParsedPackage['omitted'] = []; const items: PackageItem[] = [];
  const links = (list: unknown, into: { sources: string[]; sel: Record<string, Json> }): number => { let n = 0; for (const l of arr(list)) if (validRef(l.ref)) { n++; if (!into.sources.includes(l.ref)) into.sources.push(l.ref); if (l.selector !== null && l.selector !== undefined) into.sel[l.ref] = l.selector as Json; } return n; };
  for (const f of arr(c.findings)) {
    const ref = validRef(f.ref) ? f.ref : null;
    if (ref === null || typeof f.statement !== 'string' || f.statement.trim() === '') { omitted.push({ ref: String(f.ref ?? 'finding'), reason: 'malformed finding' }); continue; }
    if (f.stale === true) { omitted.push({ ref, reason: 'finding is stale and awaits renewed review' }); continue; }
    if (f.classification === 'refuted') { omitted.push({ ref, reason: 'finding is classified refuted; it is not presented as part of the account' }); continue; }
    const acc = { sources: [ref], sel: {} as Record<string, Json> };
    links(f.supporting, acc); const contra = links(f.contradicting, acc);
    const limits = Array.isArray(f.limitations) ? f.limitations.filter((x): x is string => typeof x === 'string') : [];
    const notes = [...limits]; if (contra > 0) notes.push(fill(t.contradictedNote as string, { count: contra }));
    const base = { key: ref, text: f.statement, sources: acc.sources, sourceSelectors: acc.sel, claimIds: acc.sources.filter((s) => s.startsWith('E07:')).map(bare), ...(notes.length > 0 ? { note: notes.join(' ') } : {}) };
    if (f.classification === 'established') items.push({ ...base, group: 'established', basis: 'verified_fact' });
    else if (f.classification === 'unknown') items.push({ ...base, group: 'unknown', basis: 'unknown_acknowledged' });
    else if (f.classification === 'disputed') {
      const testimony = f.label === 'attributed_testimony' && acc.sources.some(o.isTestimonySource);
      items.push({ ...base, group: 'disputed', basis: testimony ? 'attributed_testimony' : 'allegation', attribution: (testimony ? t.recordAttribution : t.disputedAttribution) as string });
    } else omitted.push({ ref, reason: 'unrecognised classification' });
  }
  for (const u of arr(c.unknowns)) if (typeof u.description === 'string' && u.status !== 'resolved') items.push({ key: String(u.ref ?? u.id), group: 'unknown', basis: 'unknown_acknowledged', text: typeof u.whyUnknown === 'string' && u.whyUnknown !== '' ? fill(t.unknownWhy as string, { description: u.description, why: u.whyUnknown }) : u.description, sources: validRef(u.ref) ? [u.ref] : [], sourceSelectors: {}, claimIds: [] });
  for (const q of arr(c.questionTree)) if ((q.status === 'open' || q.status === 'in_progress') && typeof q.text === 'string') items.push({ key: String(q.ref ?? q.id), group: 'unknown', basis: 'unknown_acknowledged', text: fill(t.openQuestion as string, { text: q.text }), sources: validRef(q.ref) ? [q.ref] : [], sourceSelectors: {}, claimIds: [] });
  // Chronology: a dated entry reuses the approved finding about the same claim when there is one, so its label and sources stay those of the finding.
  const dated: PackageItem[] = [];
  const chrono = isRec(c.chronology) && c.chronology.available === true ? arr(c.chronology.entries) : [];
  for (const e of [...chrono].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    if (typeof e.at !== 'string' || typeof e.description !== 'string' || !validRef(e.claimRef)) continue;
    const finding = items.find((i) => i.claimIds.includes(bare(e.claimRef as string)) && i.key.startsWith('E08:finding'));
    if (finding !== undefined) { if (!dated.includes(finding)) { finding.date = e.at; dated.push(finding); } continue; }
    const sources = [e.claimRef, ...(Array.isArray(e.sources) ? e.sources.filter(validRef) : [])].filter((s, i, a) => a.indexOf(s) === i);
    const label = e.label === 'established' ? 'established' : e.label === 'disputed' ? 'disputed' : 'unknown';
    dated.push({ key: `${e.claimRef}#${e.at}`, group: label, basis: label === 'established' ? 'verified_fact' : label === 'disputed' ? 'allegation' : 'unknown_acknowledged', text: e.description, sources, sourceSelectors: {}, claimIds: [bare(e.claimRef)], date: e.at, ...(label === 'disputed' ? { attribution: t.disputedAttribution as string } : {}) });
  }
  let account: PackageItem | null = null;
  if (isRec(c.originalAccount) && typeof c.originalAccount.summary === 'string' && c.originalAccount.summary.trim() !== '') {
    const ref = validRef(c.originalAccount.ref) ? c.originalAccount.ref : null;
    const testimony = ref !== null && o.isTestimonySource(ref) && c.originalAccount.label === 'attributed_testimony';
    account = { key: 'account', group: 'disputed', basis: testimony ? 'attributed_testimony' : 'allegation', text: c.originalAccount.summary, sources: ref === null ? [] : [ref], sourceSelectors: {}, attribution: t.accountAttribution as string, claimIds: [] };
  }
  return { ref: raw.ref, title, items, dated, account, omitted };
}

type Draft = Omit<Block, 'id'>;
const item = (i: PackageItem, type: Block['type'], data: Record<string, Json>, name: string, text = i.text): Draft => ({
  type, text, basis: i.basis, sources: [...i.sources], ...(Object.keys(i.sourceSelectors).length > 0 ? { sourceSelectors: i.sourceSelectors } : {}),
  ...(i.attribution === undefined ? {} : { attribution: i.attribution }), ...(i.note === undefined ? {} : { note: i.note }), generated: { by: 'generator', role: 'content', name }, data,
});
function viewpointDraft(v: GeneratorViewpoint, type: Block['type'], data: Record<string, Json>, name: string): Draft | null {
  if (v.body.summary === undefined) return null;
  return { type, text: v.body.summary, basis: 'attributed_testimony', sources: [...v.body.testimonyRefs], attribution: v.body.attribution, viewpointId: v.id, generated: { by: 'generator', role: 'content', name }, data };
}

export type GeneratedDocument = { docType: DocType; title: string; blocks: Block[]; omitted: ParsedPackage['omitted']; packageRef: string };
/** Builds the blocks of a first draft. Deterministic: the same package, viewpoints and options give the same blocks and ids. */
export function generate(name: GeneratorName, pkg: ParsedPackage, viewpoints: readonly GeneratorViewpoint[], o: GenerateOptions): GeneratedDocument {
  const t = { ...DEFAULT_TEMPLATES, ...o.templates } as Record<string, string>;
  const drafts: { id?: string; d: Draft }[] = [];
  const connective = (type: Block['type'], text: string, data: Record<string, Json>, disclosure = t.connectiveDisclosure as string): Draft => ({ type, text, basis: 'invention', sources: [], disclosure, generated: { by: 'generator', role: 'connective', name }, data });
  const add = (d: Draft | null, id?: string): void => { if (d !== null) drafts.push(id === undefined ? { d } : { id, d }); };
  const groups = (['established', 'disputed', 'unknown'] as const).map((g) => ({ g, items: pkg.items.filter((i) => i.group === g) })).filter((x) => x.items.length > 0);
  const undated = pkg.items.filter((i) => !pkg.dated.includes(i));
  const ordered = [...pkg.dated, ...undated];
  const withSummary = viewpoints.filter((v) => v.body.summary !== undefined);

  if (name === 'outline') {
    add(connective('outline_node', fill(t.opening as string, { title: pkg.title }), { level: 1 }));
    for (const { g, items } of groups) {
      const head = `h-${g}`; add(connective('outline_node', t[g] as string, { level: 1 }), head);
      for (const i of items) add(item(i, 'outline_node', { level: 2, parentId: head }, name));
    }
    if (withSummary.length > 0) { add(connective('outline_node', t.viewpoints as string, { level: 1 }), 'h-viewpoints'); for (const v of withSummary) add(viewpointDraft(v, 'outline_node', { level: 2, parentId: 'h-viewpoints' }, name)); }
  } else if (name === 'treatment') {
    add(connective('treatment_section', fill(t.opening as string, { title: pkg.title }), {}));
    if (pkg.account !== null) add(item(pkg.account, 'treatment_section', { heading: t.account as string }, name));
    for (const { g, items } of groups) for (const i of items) add(item(i, 'treatment_section', { heading: t[g] as string }, name));
    for (const v of withSummary) add(viewpointDraft(v, 'treatment_section', { heading: `${t.viewpoints}: ${v.body.label}` }, name));
  } else if (name === 'narrative') {
    add(connective('passage', fill(t.opening as string, { title: pkg.title }), { role: 'lede' }));
    for (const i of ordered) add(item(i, 'passage', { heading: i.date ?? (t.undated as string) }, name));
    for (const v of withSummary) add(viewpointDraft(v, 'passage', { heading: v.body.label, role: 'quote' }, name));
  } else if (name === 'lyrics') {
    const { data } = languageData(o.language, o.languages);
    const target = o.lineSyllables ?? 8;
    const section = (i: PackageItem, part: string, label: string): Draft => item(i, 'lyric_section', { part, label }, name, wrapBySyllables(i.text, target, data).join('\n'));
    const chorus = (): Draft => connective('lyric_section', wrapBySyllables(pkg.title, target, data).join('\n'), { part: 'chorus', label: 'Chorus' }, t.scaffoldDisclosure as string);
    const verses = ordered.filter((i) => i.group !== 'unknown');
    verses.forEach((i, n) => { add(section(i, 'verse', `Verse ${n + 1}`)); if (n === 0) add(chorus(), 'chorus-1'); });
    pkg.items.filter((i) => i.group === 'unknown').forEach((i, n) => add(section(i, 'bridge', `Bridge ${n + 1}`)));
    if (verses.length > 1) add(chorus(), 'chorus-2');
  } else if (name === 'script' || name === 'storyboard') {
    const scenes = new Map<string, PackageItem[]>();
    for (const i of ordered) { const k = i.date ?? (t.undated as string); scenes.set(k, [...(scenes.get(k) ?? []), i]); }
    let n = 0;
    for (const [label, items] of scenes) {
      n++;
      if (name === 'script') {
        add(connective('script_element', fill(t.sceneHeading as string, { n, label }), { element: 'scene_heading' }), `scene-${n}`);
        for (const i of items) add(item(i, 'script_element', { element: 'narration', character: t.narrator as string, sceneRef: `scene-${n}` }, name));
      } else for (const i of items) add(item(i, 'scene', { purpose: fill(t.scenePurpose as string, { label }), time: label, participants: [], panels: [{ id: 'p1', description: t.panelPending as string, assetRefs: [] }] }, name));
    }
    for (const v of withSummary) {
      n++;
      if (name === 'script') { add(connective('script_element', fill(t.interviewHeading as string, { label: v.body.label }), { element: 'scene_heading' }), `scene-${n}`); add(viewpointDraft(v, 'script_element', { element: 'dialogue', character: v.body.label, sceneRef: `scene-${n}` }, name)); }
      else add(viewpointDraft(v, 'scene', { purpose: fill(t.scenePurpose as string, { label: v.body.label }), participants: [v.body.label], panels: [{ id: 'p1', description: t.panelPending as string, assetRefs: [] }] }, name));
    }
  } else if (name === 'interactive') {
    const threads = groups.map(({ g, items }) => ({ g, keys: items.map((_i, n) => `${g}-${n + 1}`), items }));
    add(connective('story_node', t.startNode as string, { key: 'start', start: true, choices: threads.length === 0 ? [{ label: t.finish as string, to: 'end' }] : threads.map((th) => ({ label: t[th.g] as string, to: th.keys[0] as string })) }), 'start');
    for (const th of threads) th.items.forEach((i, n) => add(item(i, 'story_node', { key: th.keys[n] as string, choices: n + 1 < th.items.length ? [{ label: t.continue as string, to: th.keys[n + 1] as string }] : [{ label: t.backToStart as string, to: 'start' }, { label: t.finish as string, to: 'end' }] }, name), th.keys[n] as string));
    add(connective('story_node', t.endNode as string, { key: 'end', ending: 'end' }), 'end');
  } else {
    const v = viewpoints[0];
    const data = { sensitivities: v === undefined ? [] : [...v.body.dignityNotes], consentPrerequisites: v === undefined ? [] : [v.body.consentRef], followUps: [] };
    for (const i of pkg.items.filter((x) => x.group !== 'established')) add({ ...item(i, 'interview_question', data, name, fill(t.askAbout as string, { text: i.text })), basis: i.basis === 'attributed_testimony' ? 'allegation' : i.basis, attribution: i.attribution ?? (t.recordAttribution as string) });
    invariant(drafts.length > 0, 'invalid_input', 'The package has no disputed or unknown points to build interview questions from');
  }
  invariant(drafts.length > 0, 'invalid_input', 'The package has nothing to generate from');
  let n = 0;
  const blocks = drafts.map(({ id, d }) => ({ id: id ?? `g${++n}`, ...d }) as Block);
  return { docType: GENERATOR_DOC_TYPE[name], title: pkg.title, blocks, omitted: pkg.omitted, packageRef: pkg.ref };
}
/** Words of a set of texts, for rhyme candidates. */
export function vocabulary(texts: readonly string[], lang: string, languages?: LanguageSet): string[] {
  const { data } = languageData(lang, languages);
  return [...new Set(texts.flatMap((x) => wordsOf(x)).map((w) => w.toLowerCase()))].filter((w) => syllablesInWord(w, data) > 0);
}
