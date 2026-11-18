// Current E08 metadata only. Neither approval nor classification proves a statement true.
import { invariant } from '../contracts.ts';
import { scopedJson } from './scoped-http.ts';
import type { ScopedHttpOptions } from './scoped-http.ts';
import type { ServiceContext } from '../service-kit.ts';
export type FindingStatus = Readonly<{
  ref: string;
  state: 'draft' | 'in_review' | 'returned' | 'approved' | 'withdrawn';
  label: 'allegation' | 'attributed_testimony' | 'verified_fact' | 'inference' | 'unknown';
  classification: 'established' | 'disputed' | 'unknown' | 'refuted';
  stale: boolean;
  blocked: boolean;
}>;
export interface FindingPort {
  getFindingStatus(ctx: ServiceContext, exactRef: string): Promise<FindingStatus | null>;
}
export type FindingHttpOptions = ScopedHttpOptions;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Read the current E08 record, requiring it still matches the exact cited edition. No history/latest substitution. */
export function httpFindingPort(options: FindingHttpOptions): FindingPort {
  const url = new URL(options.baseUrl);
  invariant((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password,
    'invalid_config', 'Factual URL must be http(s) without embedded credentials');
  const configured = { ...options, baseUrl: url.toString() };
  return {
    async getFindingStatus(ctx, exactRef) {
      const selected = /^E08:finding:([A-Za-z0-9][A-Za-z0-9._-]{0,127})@([1-9][0-9]{0,15})$/.exec(exactRef);
      invariant(selected !== null && Number.isSafeInteger(Number(selected[2])), 'unavailable', 'An exact E08 finding edition is required');
      const scope = { ...ctx, compartments: [...ctx.compartments] };
      const result = await scopedJson(configured, scope, 'factual', 'GET', `/v1/records/finding/${encodeURIComponent(selected[1]!)}`);
      if (result.status === 404) return null;
      invariant(result.status === 200, 'unavailable', 'Factual finding read failed');
      const value = result.json;
      invariant(object(value) && value.ref === exactRef && value.kind === 'finding' && value.id === selected[1]
        && value.revision === Number(selected[2]) && typeof value.stale === 'boolean' && typeof value.blocked === 'boolean'
        && ['draft', 'in_review', 'returned', 'approved', 'withdrawn'].includes(value.state as string) && object(value.data),
        'unavailable', 'Factual returned a different edition or malformed finding');
      const data = value.data;
      invariant(['allegation', 'attributed_testimony', 'verified_fact', 'inference', 'unknown'].includes(data.label as string)
        && ['established', 'disputed', 'unknown', 'refuted'].includes(data.classification as string),
        'unavailable', 'Factual returned malformed finding metadata');
      // E08's actual Rec response has no compartment field. Its authenticated service enforces visibility.
      return { ref: exactRef, state: value.state as FindingStatus['state'], label: data.label as FindingStatus['label'],
        classification: data.classification as FindingStatus['classification'], stale: value.stale, blocked: value.blocked };
    },
  };
}
