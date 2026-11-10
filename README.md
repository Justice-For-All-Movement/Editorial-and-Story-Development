# Editorial and Story Development Engine (E09)

Country-neutral engine of the Public Accountability Machine suite. It develops investigated material into factual and
artistic work — articles, reports, book sections, lyrics, scripts, storyboards, interview plans and interactive stories —
while keeping every passage labelled as verified fact, attributed testimony, allegation, inference, reconstruction,
satire, invention or acknowledged unknown, and linked to its sources.

Repository: `Justice-For-All-Movement/Editorial-and-Story-Development`. The repository was empty; this is its first implementation.

## Service layer

```sh
npm ci
TEST_DATABASE_URL=postgresql://pam:pam@127.0.0.1:5432/postgres npm run check   # typecheck, tests on real PostgreSQL, build
DATABASE_URL=postgresql://… IDENTITY_PUBLIC_KEYS='{"kid":"-----BEGIN PUBLIC KEY-----…"}' npm run serve
```

Without `TEST_DATABASE_URL` the database tests are reported as skipped, not passed.

```ts
import pg from 'pg';
import { pgSql } from '@accountability/editorial-story/service-kit';
import { createEngine, migrate, routes } from '@accountability/editorial-story/engine';

const sql = pgSql(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
await migrate(sql);
const engine = createEngine({ sql, ports: { knowledge, useDecisions } });
const project = await engine.create(ctx, 'editorial_project', { body: { title: 'Harbor story', format: 'article', projectKind: 'factual', publishingIdentity: 'Example Desk', language: 'en' } });
const { document } = await engine.generate(ctx, { generator: 'outline', editorialProjectId: project.id, package: investigationPackage });
const exported = await engine.exportDocument(ctx, document.id, document.revision);
```

The full surface — methods, HTTP routes, events, ports, environment, and what is not implemented or not verified — is
in [docs/ENGINE_API.md](docs/ENGINE_API.md). Deployment subject matter, languages, templates and branding are
configuration; fixtures in this repository are fictional.
