// Standalone server for the editorial and story development engine: migrations and HTTP API.
// Env: DATABASE_URL, PORT (default 8109), HOST (default 127.0.0.1), IDENTITY_PUBLIC_KEYS (JSON map kid→PEM) or
// IDENTITY_JWKS_FILE (JSON file with the same map), IDENTITY_ISSUER (optional), OBJECT_STORE* (optional: export bundles),
// EDITORIAL_STANDALONE (comma list of `knowledge`, `consent`: accept the documented unchecked modes when no port is configured),
// EDITORIAL_ALLOW_SELF_APPROVAL (default false), EDITORIAL_CONFIG_FILE (JSON: languages, lexicons, templates, notices, formats),
// KNOWLEDGE_URL + KNOWLEDGE_TOKEN_FILE (optional HTTP KnowledgePort), MODEL_ENDPOINT + MODEL_API_KEY_FILE (optional HTTP ModelPort).
// The engine has no background jobs, so there is no worker loop.
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createHttpHandler, createTokenVerifier, objectStoreFromEnv, pgSql, serve } from '../service-kit.ts';
import { createEngine, httpKnowledgePort, httpModelPort, manifest, migrate, routes } from './index.ts';
import type { EditorialConfig } from './index.ts';

async function main(): Promise<void> {
  const env = process.env;
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const keysJson = env.IDENTITY_PUBLIC_KEYS ?? (env.IDENTITY_JWKS_FILE ? await readFile(env.IDENTITY_JWKS_FILE, 'utf8') : undefined);
  if (keysJson === undefined) throw new Error('IDENTITY_PUBLIC_KEYS or IDENTITY_JWKS_FILE is required: the server never runs without token verification');
  const publicKeys = JSON.parse(keysJson) as Record<string, string>;
  const secret = async (file: string | undefined): Promise<string | undefined> => (file ? (await readFile(file, 'utf8')).trim() : undefined);
  const fileConfig = env.EDITORIAL_CONFIG_FILE ? JSON.parse(await readFile(env.EDITORIAL_CONFIG_FILE, 'utf8')) as EditorialConfig : {};
  const standalone = (env.EDITORIAL_STANDALONE ?? '').split(',').map((s) => s.trim());
  const knowledgeToken = await secret(env.KNOWLEDGE_TOKEN_FILE), modelKey = await secret(env.MODEL_API_KEY_FILE);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
  const sql = pgSql(pool);
  await migrate(sql);
  const engine = createEngine({
    sql,
    ...(env.OBJECT_STORE !== undefined || env.OBJECT_STORE_PATH !== undefined ? { objects: objectStoreFromEnv(env, './data/objects') } : {}),
    ports: {
      ...(env.KNOWLEDGE_URL ? { knowledge: httpKnowledgePort({ baseUrl: env.KNOWLEDGE_URL, ...(knowledgeToken === undefined ? {} : { token: knowledgeToken }) }) } : {}),
      ...(env.MODEL_ENDPOINT ? { model: httpModelPort({ endpoint: env.MODEL_ENDPOINT, ...(modelKey === undefined ? {} : { apiKey: modelKey }) }) } : {}),
    },
    config: { ...fileConfig, standalone: { knowledge: standalone.includes('knowledge'), useDecisions: standalone.includes('consent') }, allowSelfApproval: env.EDITORIAL_ALLOW_SELF_APPROVAL === 'true' },
  });
  const handler = createHttpHandler({
    name: manifest.name, version: manifest.version, routes: routes(engine), health: () => engine.health(),
    verify: createTokenVerifier({ publicKeys, ...(env.IDENTITY_ISSUER ? { issuer: env.IDENTITY_ISSUER } : {}) }),
    onError: (error, info) => console.error(JSON.stringify({ level: 'error', requestId: info.requestId, method: info.method, path: info.path, error: error instanceof Error ? error.name : 'error' })),
  });
  const server = await serve(handler, Number(env.PORT ?? 8109), env.HOST ?? '127.0.0.1');
  console.log(JSON.stringify({ level: 'info', message: 'editorial engine listening', address: server.address() }));
  const stop = (): void => { server.close(); void pool.end().then(() => process.exit(0)); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : 'startup failed'); process.exit(1); });
