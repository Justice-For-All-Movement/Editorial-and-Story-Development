// Export renderings: Markdown, Fountain-style script, lyric sheet and interactive graph. Pure functions over the
// structured export document. Basis labels, attributions and disclosures are always written into the visible text.
import type { Json } from '../contracts.ts';
import { DISCLOSED_BASES, panelsOf, storyGraph } from './model.ts';
import type { Block, DocType } from './model.ts';

export type ExportBlock = Block & { viewpoint?: { id: string; label: string; attribution: string } };
export type ExportDocument = {
  document: { ref: string; id: string; revision: number; title: string; docType: DocType; language: string; reviewState: string; translationOf: { ref: string } | null };
  labels: { projectKind: string; format: string; publishingIdentity: string; projectTitle: string; notice: string | null };
  credits: { name: string; role: string; creditLine: string }[];
  blocks: ExportBlock[];
  disclosures: { blockId: string; basis: string; disclosure: string }[];
  sources: string[];
};
export const EXPORT_FORMATS = ['json', 'markdown', 'fountain', 'lyric_sheet', 'graph'] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];
export function defaultFormats(docType: DocType): ExportFormat[] {
  return ['json', 'markdown', ...(docType === 'script' || docType === 'storyboard' ? ['fountain' as const] : []), ...(docType === 'lyrics' ? ['lyric_sheet' as const] : []), ...(docType === 'interactive_story' ? ['graph' as const] : [])];
}
const one = (s: string): string => s.replace(/\s*\r?\n\s*/g, ' ').trim();
const tag = (b: ExportBlock): string => `[${b.basis}${b.attribution === undefined ? '' : ` — ${one(b.attribution)}`}]`;
const disclosureLine = (b: ExportBlock): string | null => (b.disclosure === undefined ? null : `Disclosure (${b.basis}): ${one(b.disclosure)}`);

export function renderMarkdown(d: ExportDocument): string {
  const out: string[] = [`# ${one(d.document.title)}`, ''];
  if (d.labels.notice !== null) out.push(`> **${one(d.labels.notice)}**`, '');
  out.push(`*${d.labels.format} · ${d.labels.projectKind} · published as ${one(d.labels.publishingIdentity)} · ${d.document.ref} · ${d.document.reviewState}*`, '');
  const cite = (b: ExportBlock): string => (b.sources.length === 0 ? '' : ` ${b.sources.map((s) => `[^${d.sources.indexOf(s) + 1}]`).join('')}`);
  for (const b of d.blocks) {
    const heading = typeof b.data.heading === 'string' ? b.data.heading : null;
    if (b.type === 'outline_node') out.push(`${'  '.repeat(Math.max(0, Number(b.data.level ?? 1) - 1))}- ${one(b.text)} ${tag(b)}${cite(b)}`);
    else if (b.type === 'lyric_section') out.push(`**${String(b.data.label ?? b.data.part)}** ${tag(b)}${cite(b)}`, '', ...b.text.split(/\r?\n/).map((l) => `${l}  `));
    else if (b.type === 'script_element') out.push(b.data.element === 'scene_heading' ? `### ${one(b.text)} ${tag(b)}` : `${b.data.character === undefined ? '' : `**${String(b.data.character)}** `}(${String(b.data.element)}) ${b.text} ${tag(b)}${cite(b)}`);
    else if (b.type === 'scene') {
      out.push(`### Scene: ${one(String(b.data.purpose))} ${tag(b)}${cite(b)}`, '', `${[b.data.location, b.data.time].filter((x) => typeof x === 'string').join(' · ')}`, '', b.text, '');
      panelsOf(b).forEach((p, i) => out.push(`${i + 1}. ${one(p.description)}${p.framing === undefined ? '' : ` — ${p.framing}`}${p.durationSeconds === undefined ? '' : ` — ${p.durationSeconds}s`}${p.audioNotes === undefined ? '' : ` — audio: ${one(p.audioNotes)}`}${p.assetRefs.length === 0 ? '' : ` — assets: ${p.assetRefs.join(', ')}`}${p.disclosure === undefined ? '' : ` — Disclosure: ${one(p.disclosure)}`}`));
    } else if (b.type === 'story_node') out.push(`### Node ${String(b.data.key)}${b.data.ending === undefined ? '' : ' (ending)'} ${tag(b)}${cite(b)}`, '', b.text, '', ...((b.data.choices as { label: string; to: string }[] | undefined) ?? []).map((c) => `- ${one(c.label)} → ${c.to}`));
    else out.push(...(heading === null ? [] : [`## ${one(heading)}`, '']), `${b.text} ${tag(b)}${cite(b)}`);
    const disc = disclosureLine(b); if (disc !== null) out.push('', `> ${disc}`);
    if (b.type !== 'outline_node' || disc !== null) out.push('');
  }
  if (d.sources.length > 0) { out.push('', '## Sources', ''); d.sources.forEach((s, i) => out.push(`[^${i + 1}]: ${s}`)); }
  if (d.credits.length > 0) { out.push('', '## Credits', ''); for (const c of d.credits) out.push(`- ${one(c.creditLine)} (${one(c.role)})`); }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/** Fountain-style screenplay text. Disclosures are forced action lines (printed), labels and sources are notes. */
export function renderFountain(d: ExportDocument): string {
  const out: string[] = [`Title: ${one(d.document.title)}`, `Credit: ${d.credits.map((c) => one(c.creditLine)).join('; ') || one(d.labels.publishingIdentity)}`, `Source: ${d.document.ref}`, `Notes: ${one(d.labels.notice ?? `${d.labels.projectKind} work published as ${d.labels.publishingIdentity}`)}`, ''];
  const note = (b: ExportBlock): string => `[[${b.basis}${b.attribution === undefined ? '' : `; attributed: ${one(b.attribution)}`}${b.sources.length === 0 ? '' : `; sources: ${b.sources.join(', ')}`}]]`;
  const cue = (name: string, ext = ''): string => `@${one(name).toUpperCase()}${ext}`;
  for (const b of d.blocks) {
    const disc = disclosureLine(b);
    const element = b.type === 'script_element' ? String(b.data.element) : b.type;
    if (element === 'scene_heading') out.push(`.${one(b.text).toUpperCase()}`, '');
    else if (element === 'dialogue') out.push(cue(String(b.data.character)), ...(typeof b.data.parenthetical === 'string' ? [`(${one(b.data.parenthetical)})`] : []), one(b.text), '');
    else if (element === 'narration') out.push(cue(String(b.data.character ?? 'Narrator'), ' (V.O.)'), one(b.text), '');
    else if (element === 'on_screen_text') out.push(`!SUPER: ${one(b.text)}`, '');
    else if (element === 'transition') out.push(`> ${one(b.text).toUpperCase()}`, '');
    else if (element === 'parenthetical') out.push(`!(${one(b.text)})`, '');
    else if (b.type === 'scene') {
      out.push(`.${one([b.data.location, b.data.time].filter((x) => typeof x === 'string').join(' — ') || String(b.data.purpose)).toUpperCase()}`, '', `!${one(b.text)}`, '');
      panelsOf(b).forEach((p, i) => { out.push(`!SHOT ${i + 1}${p.framing === undefined ? '' : ` — ${one(p.framing)}`}${p.durationSeconds === undefined ? '' : ` — ${p.durationSeconds}s`}: ${one(p.description)}`); if (p.audioNotes !== undefined) out.push(`!AUDIO: ${one(p.audioNotes)}`); if (p.disclosure !== undefined) out.push(`!DISCLOSURE: ${one(p.disclosure)}`); if (p.assetRefs.length > 0) out.push(`[[assets: ${p.assetRefs.join(', ')}]]`); out.push(''); });
    } else out.push(`!${one(b.text)}`, '');
    if (disc !== null) out.push(`!${disc.toUpperCase().startsWith('DISCLOSURE') ? disc : `Disclosure: ${disc}`}`, '');
    out.push(note(b), '');
  }
  return out.join('\n');
}

export function renderLyricSheet(d: ExportDocument): string {
  const out: string[] = [one(d.document.title).toUpperCase(), one(d.labels.notice ?? `${d.labels.projectKind} · ${d.labels.publishingIdentity}`), ''];
  for (const b of d.blocks) {
    if (b.type !== 'lyric_section') { out.push(`(${b.type}) ${one(b.text)} [${b.basis}]`, ''); continue; }
    const hints = [typeof b.data.meter === 'string' ? `meter ${b.data.meter}` : null, typeof b.data.tempoBpm === 'number' ? `${b.data.tempoBpm} bpm` : null, typeof b.data.key === 'string' ? `key ${b.data.key}` : null, typeof b.data.melodyHint === 'string' ? `melody: ${one(b.data.melodyHint)}` : null].filter((x) => x !== null);
    out.push(`[${String(b.data.label ?? b.data.part)}] (${b.basis}${b.attribution === undefined ? '' : ` — ${one(b.attribution)}`})${hints.length === 0 ? '' : ` {${hints.join('; ')}}`}`);
    const syl = Array.isArray(b.data.syllables) ? (b.data.syllables as number[]) : [];
    b.text.split(/\r?\n/).filter((l) => l.trim() !== '').forEach((l, i) => out.push(`${l}${syl[i] === undefined ? '' : `  (${syl[i]})`}`));
    const disc = disclosureLine(b); if (disc !== null) out.push(`(${disc})`);
    if (b.sources.length > 0) out.push(`Sources: ${b.sources.join(', ')}`);
    out.push('');
  }
  if (d.credits.length > 0) out.push('Credits: ' + d.credits.map((c) => `${one(c.creditLine)} (${one(c.role)})`).join('; '), '');
  return out.join('\n');
}

export function renderGraph(d: ExportDocument): Json {
  const g = storyGraph(d.blocks);
  const byId = new Map(d.blocks.map((b) => [b.id, b]));
  return { document: d.document.ref, labels: d.labels as unknown as Json, start: g.start, endings: g.endings, variables: g.variables,
    nodes: g.nodes.map((n) => { const b = byId.get(n.blockId) as ExportBlock; return { key: n.key, blockId: n.blockId, text: b.text, basis: b.basis, sources: b.sources, attribution: b.attribution ?? null, disclosure: b.disclosure ?? null, ending: n.ending, choices: n.choices as unknown as Json }; }) };
}
export function collectDisclosures(blocks: readonly Block[]): ExportDocument['disclosures'] {
  return blocks.flatMap((b) => [
    ...(b.disclosure !== undefined && (DISCLOSED_BASES.includes(b.basis) || b.disclosure !== '') ? [{ blockId: b.id, basis: b.basis as string, disclosure: b.disclosure }] : []),
    ...panelsOf(b).filter((p) => p.disclosure !== undefined).map((p) => ({ blockId: `${b.id}/${p.id}`, basis: b.basis as string, disclosure: p.disclosure as string })),
  ]);
}
