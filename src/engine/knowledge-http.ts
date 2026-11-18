// Real E07 standalone HTTP port. Token payload checks bind local scope; E07 verifies signatures.
import { DomainError, invariant } from '../contracts.ts';
import type { ServiceContext } from '../service-kit.ts';
import type { ClaimStatus, KnowledgePort } from './ports.ts';
export type KnowledgeHttpOptions = Readonly<{ baseUrl: string; token?: string | (() => string); timeoutMs?: number; fetch?: typeof fetch }>;
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
function checkScope(ctx: ServiceContext, token: string | undefined, _engine: string): void {
  invariant(typeof token === 'string' && token.length <= 65536, 'unavailable', 'A scoped Knowledge service credential is required');
  const payload = token.split('.')[1];
  invariant(payload !== undefined && /^[A-Za-z0-9_-]+$/.test(payload), 'unavailable', 'Invalid Knowledge credential');
  const claims: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(payload, 'base64url')));
  invariant(object(claims) && claims.tid === ctx.tenantId && claims.pid === ctx.projectId && claims.purpose === ctx.purpose,
    'unavailable', 'Knowledge credential scope or purpose differs');
}
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RESPONSE_CHUNKS = 4096;

async function call(o: KnowledgeHttpOptions, ctx: ServiceContext, engine: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const timeoutMs = o.timeoutMs ?? 15_000;
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 120_000,
    'invalid_config', 'HTTP port timeout must be an integer from 100 to 120000 milliseconds');
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const failed = () => new DomainError('unavailable', `The ${engine} engine request could not be completed`);
  const check = () => {
    if (controller.signal.aborted || performance.now() >= deadline) throw failed();
  };
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  // A synchronous credential or transport callback can expire before the first race is installed.
  void aborted.catch(() => {});
  const onAbort = () => rejectAbort(failed());
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const wait = async <T>(pending: Promise<T>): Promise<T> => {
    // A read is already begun when passed here; observe its eventual rejection even if admission expired.
    void pending.catch(() => {});
    check();
    const value = await Promise.race([pending, aborted]);
    check();
    return value;
  };
  const cancelBody = (response: Response) => {
    try { void response.body?.cancel().catch(() => {}); } catch { /* best-effort, never await a host cancel hook */ }
  };
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    check();
    // Rotation is observed once per request. The checked credential must also be sent below.
    const token = typeof o.token === 'function' ? o.token() : o.token;
    check();
    checkScope(ctx, token, engine);
    const url = new URL(path, o.baseUrl);
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    check();
    const transport = Promise.resolve().then(() => {
      check();
      return (o.fetch ?? fetch)(url, {
        method, redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(encoded === undefined ? {} : { body: encoded }),
      });
    });
    // An injected/noncooperative fetch may settle after this call has already timed out.
    void transport.then(late => {
      if (controller.signal.aborted || performance.now() >= deadline) cancelBody(late);
    }, () => {});
    response = await wait(transport);
    const status = response.status;
    const advertised = response.headers.get('content-length');
    if (advertised !== null && (!/^\d+$/.test(advertised) || !Number.isSafeInteger(Number(advertised)) || Number(advertised) > MAX_RESPONSE_BYTES)) throw failed();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (response.body !== null) {
      reader = response.body.getReader();
      for (;;) {
        const part = await wait(reader.read());
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || chunks.length >= MAX_RESPONSE_CHUNKS || part.value.byteLength > MAX_RESPONSE_BYTES - bytes) throw failed();
        bytes += part.value.byteLength;
        // Buffer is a Uint8Array subclass whose slice() aliases the producer's backing storage.
        chunks.push(new Uint8Array(part.value));
        check();
      }
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    check();
    const json: unknown = text === '' ? null : JSON.parse(text);
    check();
    complete = true;
    return { status, json };
  } catch {
    // Host credential/fetch/stream/parse diagnostics may contain private data.
    throw failed();
  } finally {
    clearTimeout(timer);
    controller.abort();
    controller.signal.removeEventListener('abort', onAbort);
    if (reader !== undefined) {
      if (!complete) { try { void reader.cancel().catch(() => {}); } catch { /* best-effort */ } }
      try { reader.releaseLock(); } catch { /* a noncooperative host may still own a read */ }
    } else if (response !== undefined && !complete) cancelBody(response);
  }
}

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
      const scope = { ...ctx, tenantId: ctx.tenantId, projectId: ctx.projectId, purpose: ctx.purpose };
      const result = await call(configured, scope, 'knowledge', 'GET', `/v1/claims/${encodeURIComponent(selected[1]!)}`);
      if (result.status === 404) return null;
      invariant(result.status === 200, 'unavailable', 'Knowledge claim read failed');
      const value = result.json;
      invariant(object(value) && value.ref === ref && value.kind === 'claim' && value.id === selected[1]
        && value.revision === Number(selected[2]) && typeof value.stale === 'boolean' && typeof value.blocked === 'boolean'
        && ['active', 'withdrawn', 'superseded'].includes(value.state as string) && object(value.assessments),
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
