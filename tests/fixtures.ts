// Fictional fixtures. The package mirrors the shape E08 builds (schema investigation-package/v1); all names are invented.
import type { ServiceContext, UseDecisionPort } from '../src/service-kit.ts';
import type { ClaimStatus, KnowledgePort } from '../src/engine/index.ts';

export const ADMIN = process.env.TEST_DATABASE_URL ?? '';
export const needsPg = ADMIN === '' ? { skip: 'TEST_DATABASE_URL is not set; real-PostgreSQL test not executed' } : {};
export const ALL_CAPS = ['editorial:read', 'editorial:write', 'editorial:comment', 'editorial:approve', 'editorial:export', 'editorial:events'];
export const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({ tenantId: 't1', projectId: 'p1', purpose: 'editorial', requestId: 'req-1', now: new Date().toISOString(), actor: { id: 'author-1', kind: 'human', roles: [] }, capabilities: ALL_CAPS, compartments: [], ...over });
export const editor = (over: Partial<ServiceContext> = {}): ServiceContext => ctx({ actor: { id: 'editor-1', kind: 'human', roles: [] }, ...over });

export const CLAIM_CONTRACT = 'E07:claim:c-contract@2', CLAIM_TIPOFF = 'E07:claim:c-tipoff@1', CLAIM_DENIAL = 'E07:claim:c-denial@1', CLAIM_PAYMENT = 'E07:claim:c-payment@1';
export const EVIDENCE_MINUTES = 'E05:evidence_version:ev-minutes@1', SEGMENT_INTERVIEW = 'E06:segment:seg-interview-7@1';
export const FINDING_CONTRACT = 'E08:finding:f-contract@3', FINDING_TIPOFF = 'E08:finding:f-tipoff@1', FINDING_PAYER = 'E08:finding:f-payer@1';
export const PACKAGE_REF = 'E08:investigation_package:inv-harbor@4';

export function investigationPackage(): Record<string, unknown> {
  const finding = (id: string, revision: number, statement: string, label: string, classification: string, supporting: unknown[], contradicting: unknown[] = [], extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ id, ref: `E08:finding:${id}@${revision}`, revision, statement, label, classification, confidence: { level: 'high', basis: 'fixture' }, questionIds: [], supporting, contradicting, limitations: [], checklist: {}, review: { state: 'approved' }, stale: false, staleReasons: [], ...extra });
  return { ref: PACKAGE_REF, version: 4, digest: 'fixture-digest', markdown: '', html: '', content: {
    schema: 'investigation-package/v1', version: 4, builtAt: '2031-05-01T00:00:00.000Z', builtBy: 'investigator-1',
    investigation: { ref: 'E08:investigation:inv-harbor@1', id: 'inv-harbor', title: 'The Harbor Dredging Contract', state: 'active' },
    originalAccount: { ref: 'E02:submission:sub-1', summary: 'A resident wrote that the dredging contract was decided before the vote.', label: 'allegation' },
    questionTree: [
      { id: 'q1', ref: 'E08:question:q1@1', text: 'Was the contract approved by the council?', status: 'answered', material: true },
      { id: 'q2', ref: 'E08:question:q2@1', text: 'Did anyone outside the council see the bids?', status: 'open', material: true },
    ],
    findings: [
      finding('f-contract', 3, 'The Harbor Council approved the dredging contract at its public session.', 'verified_fact', 'established', [{ ref: CLAIM_CONTRACT, selector: null, note: null }, { ref: EVIDENCE_MINUTES, selector: { page: 4 }, note: 'minutes' }], [], { limitations: ['The minutes do not record the vote count.'] }),
      finding('f-tipoff', 1, 'The contractor was told the outcome before the vote.', 'allegation', 'disputed', [{ ref: CLAIM_TIPOFF, selector: null, note: null }], [{ ref: CLAIM_DENIAL, selector: null, note: null }]),
      finding('f-payer', 1, 'Who authorised the second payment is not known.', 'unknown', 'unknown', []),
      finding('f-bribe', 1, 'A council member was paid by the contractor.', 'allegation', 'refuted', [], [{ ref: 'E07:claim:c-ledger@1', selector: null, note: null }]),
      finding('f-old', 2, 'The harbor was last dredged nine years earlier.', 'verified_fact', 'established', [{ ref: 'E07:claim:c-old@1', selector: null, note: null }], [], { stale: true }),
    ],
    unknowns: [{ id: 'u1', ref: 'E08:unknown:u1@1', description: 'The bid evaluation sheets were not obtained', label: 'unknown', whyUnknown: 'the request was refused', status: 'open' }],
    chronology: { available: true, reason: null, entries: [
      { at: '2031-04-10', description: 'A second payment was made to the contractor.', claimRef: CLAIM_PAYMENT, label: 'established', basis: 'status reported by the knowledge engine', sources: ['E05:evidence_version:ev-ledger@1'] },
      { at: '2031-03-03', description: 'Council session approves the contract.', claimRef: CLAIM_CONTRACT, label: 'established', basis: 'approved finding in this investigation', sources: [] },
    ] },
    contradictions: [], evidenceIndex: [], limitations: [],
  } };
}

export function knowledge(initial: Record<string, Partial<ClaimStatus>> = {}): KnowledgePort & { set(ref: string, s: Partial<ClaimStatus> | null): void; calls: string[] } {
  const state = new Map<string, Partial<ClaimStatus> | null>(Object.entries(initial));
  const calls: string[] = [];
  return {
    calls,
    set(ref, s) { state.set(ref.split('@')[0] as string, s); },
    async getClaimStatus(_c, ref) {
      calls.push(ref);
      const s = state.get(ref.split('@')[0] as string);
      if (s === null) return null;
      return { factual: 'supported', editorial: 'approved', stale: false, blocked: false, ...s };
    },
  };
}
export function useDecisions(): UseDecisionPort & { deny: Set<string>; review: Set<string>; calls: { subjects: readonly string[]; action: string }[] } {
  const deny = new Set<string>(), review = new Set<string>(); const calls: { subjects: readonly string[]; action: string }[] = [];
  return { deny, review, calls, async decide(_c, r) {
    calls.push({ subjects: r.subjects, action: r.action });
    const d = r.subjects.some((s) => deny.has(s)) ? 'deny' : r.subjects.some((s) => review.has(s)) ? 'review' : 'allow';
    return { decision: d, reasons: d === 'allow' ? [] : [`fixture ${d}`], permissionRefs: ['E11:permission:perm-1@1'], restrictions: [], decidedAt: new Date().toISOString() };
  } };
}
export const project = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ title: 'Harbor story', format: 'article', projectKind: 'factual', publishingIdentity: 'Example Desk', language: 'en', ...over });
export const block = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ id, type: 'passage', text: `Text of ${id}.`, basis: 'verified_fact', sources: [CLAIM_CONTRACT], ...over });
export const viewpoint = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ label: 'Dock worker', participantRef: 'E11:participant:part-1', testimonyRefs: [SEGMENT_INTERVIEW], consentRef: 'E11:permission:perm-1@1', attribution: 'A dock worker who was present', summary: 'I saw the trucks arrive two days before anyone voted.', dignityNotes: ['Do not show the workplace entrance.'], ...over });
