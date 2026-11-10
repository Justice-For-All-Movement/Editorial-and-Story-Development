// Lyrics helper: syllable counting, line/meter analysis and rhyme matching from spelling rules.
// The approach is orthographic (rules over letters), not a pronouncing dictionary: counts are estimates for irregular
// words and no stress pattern is derived. Every language is data (LanguageData); deployments add or replace entries.

export type LanguageData = Readonly<{
  /** vowel_groups: one syllable per run of vowels; each_vowel: one per vowel letter; strong_weak: one per strong vowel in a run (weak vowels glide). */
  mode: 'vowel_groups' | 'each_vowel' | 'strong_weak';
  vowels: string;
  /** strong_weak only: vowels that always form their own syllable nucleus. */
  strong?: string;
  /** Regular expressions removed from the word before counting (e.g. a silent final letter). */
  drop?: readonly string[];
  /** Regular expressions that each remove / add one syllable when they match the lower-cased word. */
  subtract?: readonly string[];
  add?: readonly string[];
  exceptions?: Readonly<Record<string, number>>;
  /** [pattern, replacement] spelling rewrites applied before the rhyme key is taken. */
  rhymeRewrites?: readonly (readonly [string, string])[];
}>;

export const BUILTIN_LANGUAGES: Readonly<Record<string, LanguageData>> = {
  en: {
    mode: 'vowel_groups', vowels: 'aeiouy', drop: ['e$'],
    subtract: ['cial', 'tia', 'cius', 'cious', 'giu', 'ion', 'iou', 'sia$', '.ely$', '[^aeioutdy]ed$', '[^aeiousxzh]es$'],
    add: ['ia', 'riet', 'dien', 'iu', 'io', 'ii', '[aeiouym]bl$', '[aeiou]{3}', '^mc', 'ism$', '([^aeiouy])\\1l$', '[^l]lien', '^coa[dglx].', '[^gq]ua[^auieo]', 'dnt$'],
    exceptions: { the: 1, one: 1, once: 1, are: 1, were: 1, where: 1, there: 1, here: 1, give: 1, have: 1, some: 1, come: 1, done: 1, gone: 1, love: 1, move: 1, fire: 1, hour: 1, our: 1, every: 2, evening: 2, different: 2, business: 2, people: 2, being: 2, doing: 2, going: 2, idea: 3, area: 3, real: 1, poem: 2, quiet: 2, science: 2, create: 2, created: 3, eye: 1, eyes: 1, queue: 1, something: 2, sometimes: 2, somewhere: 2, everyone: 3, everything: 3, family: 3, evidence: 3, justice: 2, silence: 2, promise: 2, office: 2, notice: 2, answer: 2, minute: 2, beautiful: 3, beauty: 2 },
    rhymeRewrites: [['ight$', 'ite'], ['eigh', 'ay'], ['tion$', 'shun'], ['sion$', 'shun'], ['ck', 'k'], ['ph', 'f'], ['([^aeiou])y([^aeiou])e$', '$1i$2e'], ['ey$', 'ay'], ['ea([dt])$', 'ee$1'], ['oo', 'u'], ['ould$', 'ood'], ['ough$', 'o'], ['aid$', 'ade'], ['ain$', 'ane'], ['ail$', 'ale'], ['ow$', 'o'], ['ew$', 'u'], ['ue$', 'u']],
  },
  es: { mode: 'strong_weak', vowels: 'aeiouáéíóúüy', strong: 'aeoáéóíú', rhymeRewrites: [['v', 'b'], ['z', 's'], ['ll', 'y'], ['á', 'a'], ['é', 'e'], ['í', 'i'], ['ó', 'o'], ['ú', 'u']] },
  uk: { mode: 'each_vowel', vowels: 'аеєиіїоуюя' },
};
/** Fallback for unconfigured languages: runs of any Latin, Cyrillic or Greek vowel letter. */
export const GENERIC_LANGUAGE: LanguageData = { mode: 'vowel_groups', vowels: 'aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿāēīōūăĕĭŏŭąęįųœаеёиоуыэюяєіїαεηιουω' };

export type LanguageSet = Readonly<Record<string, LanguageData>>;
export function languageData(lang: string, custom: LanguageSet = {}): { data: LanguageData; resolved: string } {
  const base = lang.split('-')[0] as string;
  for (const key of [lang, base]) { const d = custom[key] ?? BUILTIN_LANGUAGES[key]; if (d !== undefined) return { data: d, resolved: key }; }
  return { data: GENERIC_LANGUAGE, resolved: 'generic' };
}
const letters = (word: string): string => word.toLowerCase().normalize('NFC').replace(/[^\p{L}]/gu, '');
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
function safeRegex(pattern: string): RegExp | null { try { return pattern.length <= 100 ? new RegExp(pattern, 'u') : null; } catch { return null; } }

export function syllablesInWord(word: string, d: LanguageData): number {
  let w = letters(word);
  if (w === '') return 0;
  const known = d.exceptions?.[w]; if (known !== undefined) return known;
  for (const p of d.drop ?? []) { const r = safeRegex(p); if (r !== null) w = w.replace(r, ''); }
  const v = esc(d.vowels);
  let count: number;
  if (d.mode === 'each_vowel') count = (w.match(new RegExp(`[${v}]`, 'gu')) ?? []).length;
  else {
    const runs = w.match(new RegExp(`[${v}]+`, 'gu')) ?? [];
    if (d.mode === 'vowel_groups') count = runs.length;
    else { const strong = d.strong ?? d.vowels; count = runs.reduce((n, run) => n + Math.max(1, [...run].filter((c) => strong.includes(c)).length), 0); }
  }
  for (const p of d.subtract ?? []) { const r = safeRegex(p); if (r !== null && r.test(w)) count--; }
  for (const p of d.add ?? []) { const r = safeRegex(p); if (r !== null && r.test(w)) count++; }
  return Math.max(1, count);
}
export const wordsOf = (text: string): string[] => text.match(/[\p{L}][\p{L}'’-]*/gu) ?? [];
export function countSyllables(text: string, d: LanguageData): number { return wordsOf(text).reduce((n, w) => n + syllablesInWord(w, d), 0); }

/** Spelling-based rhyme key: the last vowel run of the word and everything after it, after the language's rewrites. */
export function rhymeKey(word: string, d: LanguageData): string {
  let w = letters(word);
  for (const [p, rep] of d.rhymeRewrites ?? []) { const r = safeRegex(p); if (r !== null) w = w.replace(r, rep); }
  const stripped = (d.drop ?? []).reduce((acc, p) => { const r = safeRegex(p); const next = r === null ? acc : acc.replace(r, ''); return new RegExp(`[${esc(d.vowels)}]`, 'u').test(next) ? next : acc; }, w);
  const m = new RegExp(`[${esc(d.vowels)}]+[^${esc(d.vowels)}]*$`, 'u').exec(stripped);
  return m === null ? stripped : m[0];
}
function nucleus(key: string, d: LanguageData): string { return (new RegExp(`^[${esc(d.vowels)}]+`, 'u').exec(key) ?? [''])[0]; }

export type LineAnalysis = { text: string; syllables: number; words: { word: string; syllables: number }[]; endWord: string | null; rhymeKey: string | null; rhyme: string | null };
export type LyricAnalysis = { language: string; rules: string; lines: LineAnalysis[]; syllablePattern: number[]; rhymeScheme: string; meter: { target: number[] | null; deviations: { line: number; expected: number; actual: number }[] }; note: string };
/** `meter` is a syllable pattern such as "8-6-8-6" (repeated over the lines) — a count check, not a stress scan. */
export function analyzeLyrics(text: string, lang: string, options: { meter?: string; languages?: LanguageSet } = {}): LyricAnalysis {
  const { data, resolved } = languageData(lang, options.languages);
  const keys: string[] = [];
  const lines: LineAnalysis[] = text.split(/\r?\n/).filter((l) => l.trim() !== '').map((line) => {
    const words = wordsOf(line).map((word) => ({ word, syllables: syllablesInWord(word, data) }));
    const endWord = words.length === 0 ? null : (words[words.length - 1] as { word: string }).word;
    const key = endWord === null ? null : rhymeKey(endWord, data);
    let rhyme: string | null = null;
    if (key !== null && key !== '') { let i = keys.indexOf(key); if (i < 0) { keys.push(key); i = keys.length - 1; } rhyme = i < 26 ? String.fromCharCode(65 + i) : `X${i}`; }
    return { text: line, syllables: words.reduce((n, w) => n + w.syllables, 0), words, endWord, rhymeKey: key, rhyme };
  });
  const target = options.meter === undefined ? null : options.meter.split(/[^0-9]+/).filter(Boolean).map(Number);
  const deviations = target === null || target.length === 0 ? [] : lines.flatMap((l, i) => { const expected = target[i % target.length] as number; return l.syllables === expected ? [] : [{ line: i + 1, expected, actual: l.syllables }]; });
  return { language: lang, rules: resolved, lines, syllablePattern: lines.map((l) => l.syllables), rhymeScheme: lines.map((l) => l.rhyme ?? '-').join(''), meter: { target: target !== null && target.length > 0 ? target : null, deviations },
    note: 'Syllable counts and rhymes are estimated from spelling rules; irregular words may be miscounted and stress is not analysed.' };
}
export type RhymeSuggestion = { word: string; quality: 'perfect' | 'near'; syllables: number };
/** Ranks candidate words (from the caller, the document or a deployment lexicon) by how well they rhyme with `word`. */
export function suggestRhymes(word: string, candidates: readonly string[], lang: string, options: { limit?: number; languages?: LanguageSet } = {}): RhymeSuggestion[] {
  const { data } = languageData(lang, options.languages);
  const self = letters(word), key = rhymeKey(word, data), nuc = nucleus(key, data), tail = key.slice(nuc.length);
  const seen = new Set<string>([self]); const out: RhymeSuggestion[] = [];
  for (const c of candidates) {
    const l = letters(c); if (l === '' || seen.has(l)) continue; seen.add(l);
    const k = rhymeKey(c, data);
    if (k === key) out.push({ word: l, quality: 'perfect', syllables: syllablesInWord(l, data) });
    else if (nuc !== '' && (nucleus(k, data) === nuc || (tail !== '' && k.endsWith(tail) && k.length > tail.length))) out.push({ word: l, quality: 'near', syllables: syllablesInWord(l, data) });
  }
  return out.sort((a, b) => (a.quality === b.quality ? a.word.localeCompare(b.word) : a.quality === 'perfect' ? -1 : 1)).slice(0, Math.min(Math.max(options.limit ?? 20, 1), 200));
}
/** Breaks prose into lines of roughly `target` syllables without splitting words. */
export function wrapBySyllables(text: string, target: number, d: LanguageData): string[] {
  const out: string[] = []; let line: string[] = [], n = 0;
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const s = countSyllables(token, d);
    if (line.length > 0 && n + s > target) { out.push(line.join(' ')); line = []; n = 0; }
    line.push(token); n += s;
  }
  if (line.length > 0) out.push(line.join(' '));
  return out;
}
