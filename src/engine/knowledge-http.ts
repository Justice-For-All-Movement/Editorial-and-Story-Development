// Real E07 standalone HTTP port. Token payload checks bind local scope; E07 verifies signatures.
import { DomainError, invariant } from '../contracts.ts';
import type { ServiceContext } from '../service-kit.ts';
import type { ClaimStatus, KnowledgePort } from './ports.ts';
import { scopedJson } from './scoped-http.ts';
import type { ScopedHttpOptions } from './scoped-http.ts';
export type KnowledgeHttpOptions = ScopedHttpOptions;
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

const FACTUAL = ['unassessed', 'supported', 'contested', 'refuted', 'unresolvable'];
const EDITORIAL = ['not_reviewed', 'approved', 'approved_with_conditions', 'rejected', 'withdrawn'];
/** Current E07 claim assessment at the EXACT cited edition. No silent upgrade to the latest claim. */
export function httpKnowledgePort(options: KnowledgeHttpOptions): KnowledgePort {
  const url = new URL(options.baseUrl);
  invariant((url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '',
    'invalid_config', 'Knowledge URL must be an http(s) URL without embedded credentials');
  const configured = { ...options, baseUrl: url.toString() };
  return {
    async getClaimStatus(ctx, ref): Promise<ClaimStatus | null> {
      const selected = /^E07:claim:([A-Za-z0-9][A-Za-z0-9._-]{0,127})@([1-9][0-9]{0,15})$/.exec(ref);
      invariant(selected !== null && Number.isSafeInteger(Number(selected[2])), 'unavailable', 'An exact E07 claim edition is required');
      // Capture the caller scope before any injected credential/transport callback.
      const scope = { ...ctx, tenantId: ctx.tenantId, projectId: ctx.projectId, purpose: ctx.purpose, compartments: [...ctx.compartments] };
      const result = await scopedJson(configured, scope, 'knowledge', 'GET', `/v1/claims/${encodeURIComponent(selected[1]!)}`);
      if (result.status === 404) return null;
      invariant(result.status === 200, 'unavailable', 'Knowledge claim read failed');
      const value = result.json;
      invariant(object(value) && value.ref === ref && value.kind === 'claim' && value.id === selected[1]
        && value.revision === Number(selected[2]) && typeof value.stale === 'boolean' && typeof value.blocked === 'boolean'
        && ['active', 'withdrawn', 'superseded'].includes(value.state as string) && object(value.assessments)
        && (value.compartment === null || (typeof value.compartment === 'string' && scope.compartments.includes(value.compartment))),
        'unavailable', 'Knowledge returned a different edition or malformed claim');
      const factual = value.assessments.factual, editorial = value.assessments.editorial;
      invariant(object(factual) && FACTUAL.includes(factual.value as string) && typeof factual.needsReverification === 'boolean'
        && object(editorial) && EDITORIAL.includes(editorial.value as string) && typeof editorial.needsReverification === 'boolean',
        'unavailable', 'Knowledge returned malformed assessment tracks');
      return { factual: factual.value as string, editorial: editorial.value as string,
        stale: value.stale || factual.needsReverification || editorial.needsReverification,
        blocked: value.blocked || value.state !== 'active' };
    },
  };
}
