// Collaborator ports of the editorial engine and small HTTP adapters for a standalone server.
import { DomainError } from '../contracts.ts';
import type { ServiceContext } from '../service-kit.ts';

/** E07. Status of a claim on its factual and editorial assessment tracks. null when the claim is unknown to the caller. */
export type ClaimStatus = Readonly<{ factual: string; editorial: string; stale: boolean; blocked: boolean }>;
export interface KnowledgePort { getClaimStatus(ctx: ServiceContext, claimRef: string): Promise<ClaimStatus | null> }

export type ModelRequest = Readonly<{
  task: 'draft'; mode: 'creative' | 'analytical'; instruction: string; language: string; docType: string; title: string;
  blocks: readonly Readonly<{ id: string; type: string; basis: string; text: string }>[]; maxProposals: number;
}>;
export type ModelProposal = Readonly<{ text: string; targetBlockId?: string; rationale?: string }>;
/** A language model reached through the host (PAM). Its output is data: it never supplies labels, sources or authority. */
export interface ModelPort { propose(ctx: ServiceContext, request: ModelRequest): Promise<{ proposals: readonly ModelProposal[]; model?: string }> }

async function postJson(url: string, token: string | undefined, body: unknown, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try { response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) }); }
  catch { throw new DomainError('unavailable', 'The configured provider could not be reached'); }
  if (!response.ok) throw new DomainError('unavailable', `The configured provider answered HTTP ${response.status}`);
  try { return await response.json(); } catch { throw new DomainError('unavailable', 'The configured provider returned a malformed response'); }
}
/**
 * Generic HTTP model adapter: POSTs the ModelRequest as JSON to one fixed, operator-configured endpoint and expects
 * `{ proposals: [{ text, targetBlockId?, rationale? }], model? }`. The key never leaves this adapter.
 * Implemented, not verified against a live provider.
 */
export function httpModelPort(options: { endpoint: string; apiKey?: string; timeoutMs?: number }): ModelPort {
  const url = new URL(options.endpoint);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new DomainError('invalid_config', 'MODEL_ENDPOINT must be an http(s) URL');
  return {
    async propose(_ctx, request) {
      const out = await postJson(url.toString(), options.apiKey, request, options.timeoutMs ?? 60_000) as { proposals?: unknown; model?: unknown };
      if (!Array.isArray(out?.proposals)) throw new DomainError('unavailable', 'The model endpoint returned no proposals array');
      return { proposals: out.proposals as ModelProposal[], ...(typeof out.model === 'string' ? { model: out.model.slice(0, 100) } : {}) };
    },
  };
}
/**
 * HTTP knowledge adapter: POST `<baseUrl>/v1/claims/status` with `{ ref }` → ClaimStatus, 404 → null.
 * The route is this adapter's own convention; the integrator normally supplies a KnowledgePort directly.
 * Implemented, not verified against a live E07.
 */
export function httpKnowledgePort(options: { baseUrl: string; token?: string; timeoutMs?: number }): KnowledgePort {
  const url = new URL('/v1/claims/status', options.baseUrl).toString();
  return {
    async getClaimStatus(_ctx, ref) {
      let response: Response;
      try { response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 15_000), headers: { 'content-type': 'application/json', ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }) }, body: JSON.stringify({ ref }) }); }
      catch { throw new DomainError('unavailable', 'The knowledge service could not be reached'); }
      if (response.status === 404) return null;
      if (!response.ok) throw new DomainError('unavailable', `The knowledge service answered HTTP ${response.status}`);
      const o = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (o === null || typeof o.factual !== 'string') throw new DomainError('unavailable', 'The knowledge service returned a malformed status');
      return { factual: o.factual, editorial: typeof o.editorial === 'string' ? o.editorial : 'not_reviewed', stale: o.stale === true, blocked: o.blocked === true };
    },
  };
}
