# E09 — Editorial and story development engine: service API

Package `@accountability/editorial-story`, entry `./engine` (`src/engine/index.ts`), server `./serve` (`src/engine/serve.ts`).
Schema `e09_editorial`. Capability prefix `editorial`. Kit `src/service-kit.ts` version 1.0.1, sha256
`95475a907267ba1fdd54b557aabe5645c37add9788a5b2d0854d9accfd5d8ea5` (byte-identical copy; `src/contracts.ts` is the Identity copy).

Status words used below: **tested** = covered by `tests/` on real PostgreSQL 16; **implemented, not verified** = code
exists but was never run against the real collaborator.

## 1. Entry points

```ts
import { SCHEMA, manifest, migrations, migrate, createEngine, routes } from '@accountability/editorial-story/engine';

createEngine({
  sql,                                  // kit Sql
  objects?,                             // kit ObjectStore: export bundles are also written to <tenant>/<project>/exports/<docId>/<exportId>.json
  ports?: {
    knowledge?: KnowledgePort,          // E07: getClaimStatus(ctx, claimRef) → { factual, editorial, stale, blocked } | null
    useDecisions?: UseDecisionPort,     // E11 (kit type): decide(ctx, { subjects, action: 'adapt' | 'publish', purpose, ... })
    authorization?: AuthorizationPort,  // E01 (kit type): re-checked before approve and export
    model?: ModelPort,                  // language model via the host: propose(ctx, ModelRequest) → { proposals: [{ text, targetBlockId?, rationale? }], model? }
  },
  config?: {
    standalone?: { knowledge?: boolean; useDecisions?: boolean },  // see "Ports and standalone modes"
    allowSelfApproval?: boolean,        // default false: approver ≠ author of the approved revision
    formats?: string[],                 // editorial project formats (default list in model.ts)
    factSourcePatterns?: string[],      // default ['E07:claim*', 'E08:finding*']
    testimonySourcePatterns?: string[], // default ['E02:*', 'E05:*', 'E06:*', 'E07:testimony*']
    supportedFactualValues?: string[],  // default ['supported'] (E07 factual track)
    languages?: Record<lang, LanguageData>,   // syllable / rhyme rules per language (built in: en, es, uk; others fall back to a generic vowel-run rule)
    lexicons?: Record<lang, string[]>,        // rhyme candidate words per language
    templates?: Record<lang, Record<string, string>>,  // generator connective text (keys: DEFAULT_TEMPLATES)
    notices?: Record<lang, { satire?, campaign?, modelDisclosure? }>,  // export label texts; campaign may contain {identity}
  },
})
```

Server: `npm run serve` (`node src/engine/serve.ts`). Environment: `DATABASE_URL` (required), `PORT` (8109), `HOST`
(127.0.0.1), `IDENTITY_PUBLIC_KEYS` (JSON map kid→PEM) or `IDENTITY_JWKS_FILE` (file with the same map) — required,
`IDENTITY_ISSUER`, `OBJECT_STORE` / `OBJECT_STORE_PATH` / `S3_*`, `EDITORIAL_STANDALONE` (comma list of `knowledge`,
`consent`), `EDITORIAL_ALLOW_SELF_APPROVAL`, `EDITORIAL_CONFIG_FILE` (JSON with the `config` keys above),
`KNOWLEDGE_URL` + `KNOWLEDGE_TOKEN_FILE`, `MODEL_ENDPOINT` + `MODEL_API_KEY_FILE`. The engine has no background jobs,
so the server runs no worker loop. No external tools are used.

## 2. Model

Seven revisioned kinds share one mechanism (`objects` + `revisions`): `series`, `collection`, `editorial_project`,
`collaborator`, `viewpoint`, `asset`, `document`. Universal references: `E09:<kind>:<uuid>@<revision>`, blocks
`E09:block:<documentUuid>.<blockId>@<revision>`, also `E09:approval:<uuid>`, `E09:export:<uuid>`.

"Editorial project" is this engine's creative project (an article, a film, an album…). It is distinct from the
tenancy `projectId` of `ServiceContext`; every row carries `tenant_id` and `project_id` and every query filters on both.
Series, collections, collaborators, viewpoints and registered assets are shared by all editorial projects inside one
tenant/project scope. An object may be created in a `compartment`; callers without it get `not_found`.

Every save is a new revision (`expectedRevision` required, mismatch → `revision_conflict`). Review state is per
revision: `draft → in_review → approved → superseded`. A new revision starts as `draft` and leaves earlier revisions,
including the approved one, untouched. `restore` copies an old revision into a **new** revision and validates it again.

Bodies (unknown properties are rejected):

| Kind | Body |
|---|---|
| `editorial_project` | `title, format, projectKind: factual\|artistic\|satire\|campaign, publishingIdentity, language, audience?, aim?, constraints?, brief?, credits: [{collaboratorId, role, creditLine?}], investigationRefs: uref[]`. `projectKind` and `publishingIdentity` cannot change after creation. Formats `satire` / `campaign_piece` require the matching kind. |
| `series` | `title, description?, projectKind, publishingIdentity, language?, status: active\|paused\|concluded, items: [{editorialProjectId, label?}]`. Members must have the series' `projectKind`. |
| `collection` | `title, description?, items: [{ref: E09 uref, note?}]` (documents, projects, assets, series, viewpoints, collaborators of this scope). |
| `collaborator` | `name, roles[], creditLine, actorId?, bio?, languages[]`. |
| `viewpoint` | `label, participantRef, testimonyRefs[≥1], consentRef, attribution, summary?, perspective?, dignityNotes[], restrictions[]`. Dignity notes are internal: never exported. |
| `asset` | `title, targetRef (E10 asset / E05 evidence uref), mediaKind, provenance: archival\|original_production\|generated\|reconstruction, rightsRef (E11), approvalRef?, description?, usageNotes?, restrictions[], tags[]`. `archival` requires an E05 target. An asset is usable in scenes only while it has an active approval in this engine. |
| `document` | `title, editorialProjectId, docType: outline\|treatment\|article\|book_section\|narrative\|lyrics\|script\|storyboard\|interview_plan\|interactive_story\|notes, language, blocks: Block[], translationOf?: {documentId, revision}, meta?` |

Block: `{ id, type, text, basis, sources: uref[], sourceSelectors?: {uref: selector}, attribution?, disclosure?, viewpointId?, note?, generated?: {by: generator|model, role: content|connective, name?}, downgraded?, translates?, data }`,
server-managed `verification` (knowledge / use-decision result at last changed save) and `sourceHash` (translations).

| `type` | `data` |
|---|---|
| `outline_node` | `level 1–6, parentId?` |
| `treatment_section` | `heading?` |
| `passage` | `heading?, role?` (article and book text) |
| `lyric_section` | `part: intro\|verse\|pre_chorus\|chorus\|refrain\|hook\|bridge\|outro\|spoken, label?, meter?, syllables? (computed per line when omitted), rhymeScheme?, melodyHint?, tempoBpm?, key?` |
| `script_element` | `element: scene_heading\|action\|dialogue\|narration\|on_screen_text\|parenthetical\|transition, character? (required for dialogue), parenthetical?, sceneRef?` |
| `scene` | `purpose, location?, time?, participants[], panels: [{id, description, framing?, durationSeconds?, audioNotes?, assetRefs: uref[], disclosure?}]` |
| `interview_question` | `sensitivities[], consentPrerequisites[] (urefs become dependencies), followUps[]` |
| `story_node` | `key, start?, ending?, choices: [{label, to, condition?: {var, op, value?}, effects?}]` — one start, resolvable targets, no dead ends, all nodes reachable, ≥1 ending |

### Basis labels (required on every block, no default)

`verified_fact | attributed_testimony | allegation | inference | reconstruction | satire | invention | unknown_acknowledged`

Enforced on every save (create, revise, restore, accepted suggestion, generator output); violations → `invalid_basis` (HTTP 400):

- `verified_fact`: ≥1 source matching `factSourcePatterns`. Every cited **E07 claim** must be `supported` on the factual
  track, not stale, not blocked, and known to `KnowledgePort`. Otherwise the save is rejected, or — only with
  `unsupportedFacts: 'downgrade'` (`downgradeTo: allegation | inference | unknown_acknowledged`, default `allegation`) —
  the block is relabelled and `downgraded: {from, reason}` is recorded. E08 finding refs satisfy the source rule but are
  not status-checked (the port only covers claims).
- `attributed_testimony`: `attribution` and ≥1 testimony source (pattern match, or a testimony ref of the block's viewpoint).
- `allegation`: an attribution or ≥1 source.
- `reconstruction`, `satire`, `invention`: non-empty `disclosure`; it is printed in every export rendering and listed in the manifest.
- `satire`: only in documents of an editorial project of kind `satire`.
- Scene panels using a registered `generated` / `reconstruction` asset need a panel or block disclosure.
- Checks with collaborators run for new or changed blocks; unchanged blocks keep their recorded `verification`.

### Ports and standalone modes

| Situation | Port present | Port absent, standalone flag off (default) | Port absent, flag on |
|---|---|---|---|
| saving a changed `verified_fact` block | status checked | `unavailable` | saved, `verification.knowledge.status = 'not_checked'`, fact-check shows `not_checked` |
| creating/revising a viewpoint; saving a changed block with a viewpoint or `attributed_testimony`; exporting such a document | `decide(adapt)` (export: `adapt` or `publish`); `deny` → `consent_denied`; `review` recorded, and refused for `publish` | `unavailable` | recorded as `decision: 'not_checked'` |
| `proposeDrafts` | model asked | `unavailable` | — (no standalone mode) |

## 3. Service methods

All take `ctx: ServiceContext` first and check a capability before any read or write. `SaveOptions = { summary?,
idempotencyKey?, unsupportedFacts?: 'reject' | 'downgrade', downgradeTo?, resolveFlagIds? }`. `Kind` is one of the seven kinds.

| Method | Capability |
|---|---|
| `create<K>(ctx, kind: K, { body, compartment? } & SaveOptions): Promise<Stored<K>>` | write |
| `revise<K>(ctx, kind, id, { expectedRevision, body } & SaveOptions): Promise<Stored<K>>` | write |
| `get<K>(ctx, kind, id, revision?): Promise<Stored<K>>` | read |
| `list(ctx, kind, { editorialProjectId?, state?, docType?, translationOf?, limit?, offset? }): Promise<Summary[]>` | read |
| `history(ctx, kind, id): Promise<RevisionInfo[]>` | read |
| `diff(ctx, kind, id, from, to): Promise<DiffResult>` — field changes; for documents also blocks added / removed / moved / changed with word-level text diff | read |
| `restore<K>(ctx, kind, id, { revision, expectedRevision } & SaveOptions): Promise<Stored<K>>` | write |
| `requestReview(ctx, kind, id, { expectedRevision, note?, idempotencyKey? }): Promise<Stored>` | write |
| `returnToDraft(ctx, kind, id, { revision, note, idempotencyKey? }): Promise<Stored>` | approve |
| `approve(ctx, kind, id, { revision, note?, idempotencyKey? }): Promise<Approval>` — binds to the revision digest; refused with open flags; also renews a `needs_renewal` approval | approve |
| `listApprovals(ctx, kind, id): Promise<Approval[]>` | read |
| `addComment(ctx, kind, id, { body, blockId?, idempotencyKey? }): Promise<Comment>` | comment |
| `suggest(ctx, documentId, { block, blockId? (replace) , afterBlockId? (insert), note?, idempotencyKey? }): Promise<Comment>` | comment |
| `listComments(ctx, kind, id, { status?, kind? }): Promise<Comment[]>` | read |
| `resolveComment(ctx, commentId, { status: 'resolved' \| 'rejected', note? }): Promise<Comment>` | comment |
| `acceptSuggestion(ctx, suggestionId, { expectedRevision, relabel? } & SaveOptions): Promise<Stored<'document'>>` | write |
| `assign(ctx, kind, id, { assigneeId, role, blockId?, note?, dueAt?, idempotencyKey? }): Promise<Assignment>` | write |
| `listAssignments(ctx, { objectId?, assigneeId?, status? }): Promise<Assignment[]>`, `updateAssignment(ctx, id, { status })` | read / write |
| `listFlags(ctx, { objectId?, status?, kind? }): Promise<Flag[]>` | read |
| `resolveFlag(ctx, flagId, { resolution: 'reviewed_still_accurate' \| 'revised', note }): Promise<Flag>` — stale flags only | write |
| `createTranslation(ctx, { sourceDocumentId, sourceRevision?, language, title, blocks, compartment? } & SaveOptions): Promise<Stored<'document'>>` | write |
| `translationStatus(ctx, sourceDocumentId)` → per translation, per block `current \| stale \| source_removed`, plus untranslated source blocks | read |
| `factCheck(ctx, documentId, revision?): Promise<FactCheck>` | read |
| `exportDocument(ctx, documentId, revision, { formats?, requireApproved?, intendedUse?: 'adapt' \| 'publish', audience?, territory?, destination?, idempotencyKey? }): Promise<ExportResult>` | export |
| `listExports(ctx, documentId): Promise<ExportManifest[]>` | read |
| `generate(ctx, { generator, editorialProjectId, package, viewpointIds?, title?, language?, lineSyllables?, compartment? } & SaveOptions): Promise<{ document: Stored<'document'>; omitted: { ref, reason }[] }>` | write |
| `proposeDrafts(ctx, documentId, { instruction, blockIds?, mode?: 'creative' \| 'analytical', count?, idempotencyKey? }): Promise<{ suggestions: Comment[]; model: string \| null }>` | write |
| `analyzeLyrics(ctx, { text, language, meter? }): Promise<LyricAnalysis>`, `suggestRhymes(ctx, { word, language, candidates?, documentId?, limit? }): Promise<RhymeSuggestion[]>` | read |
| `usage(ctx, 'asset' \| 'viewpoint', id)` → documents and blocks using it | read |
| `addScene(ctx, { documentId, expectedRevision, scene, afterBlockId? } & SaveOptions): Promise<Stored<'document'>>` | write |
| `inspect`, `search`, `audit` | read |
| `events(ctx, { after?, limit? })`, `applyUpstreamChange(ctx, change)` | events |
| `health()` | — |

`approve`, `export` and `events` are sensitive actions: `editorial:*` does not grant them.

`Stored<K>`: `{ ref, id, kind, revision, currentRevision, state, title, compartment, body, digest, summary, actorId, at, restoredFrom, createdAt, stale, blocked, flags }`.

### Generators

`generate` takes the E08 package as E08 returns it: `{ ref: 'E08:investigation_package:<id>@<version>', content }` with
`content.schema === 'investigation-package/v1'`. Used fields: `investigation.title`, `findings[]` (`ref`, `statement`,
`label`, `classification`, `supporting[]`, `contradicting[]`, `limitations[]`, `stale`), `unknowns[]`, `questionTree[]`
(open questions), `chronology.entries[]` (`at`, `description`, `claimRef`, `label`, `sources`), `originalAccount`.

| Package item | Block |
|---|---|
| finding `established` | `verified_fact`; sources = finding ref + supporting refs (selectors kept); limitations → `note` |
| finding `disputed` | `allegation` with an attribution (`attributed_testimony` when the finding is so labelled and cites a testimony source); sources = finding + supporting + contradicting |
| finding `unknown`, unknowns register, open questions | `unknown_acknowledged` |
| finding `refuted` or `stale` | not presented; returned in `omitted` with the reason |
| chronology entry | the finding about the same claim when there is one, dated; otherwise its own block labelled from the entry |
| viewpoint with a `summary` | `attributed_testimony`, the viewpoint's attribution and testimony refs, `viewpointId` |
| headings, openings, scaffold chorus, graph start/end | `invention` with a disclosure, `generated.role = 'connective'` |

Generators: `outline`, `treatment`, `narrative` (chronological), `lyrics` (verses wrapped to `lineSyllables`, scaffold
chorus from the title, bridges from unknowns), `script` (scene headings + narration + interview dialogue), `storyboard`
(scene blocks with one placeholder panel), `interactive` (playable graph by thread), `interview_plan`. Output is
deterministic and is saved through the normal rules (a contested claim is therefore rejected or explicitly downgraded).
The document records `meta.generatedFrom` and depends on the package ref.

### Exports (for E10 and E12)

`ExportResult = { manifest, document, renderings: { markdown?, fountain?, lyricSheet?, graph? } }`.
`document`: `{ document: { ref, id, revision, title, docType, language, reviewState, translationOf }, labels: { projectKind, format, publishingIdentity, projectTitle, notice }, credits: [{ name, role, creditLine }], blocks (with basis, sources, selectors, attribution, disclosure, data, viewpoint {id, label, attribution}), disclosures: [{ blockId, basis, disclosure }], sources: uref[] }`.
`manifest`: `{ exportId, engine, engineVersion, document (uref with revision), revision, contentDigest, reviewState, approval: { id, status, approverId, at } | null, formats, renderingDigests, sourceRefs, assetRefs, viewpointRefs, packageRefs, translationOf, labels, credits, disclosures, openFlags, useDecisions, intendedUse, exportedAt, exportedBy, objectKey }`.
Default formats: `json`, `markdown`, plus `fountain` (script, storyboard), `lyric_sheet` (lyrics), `graph` (interactive story).
Refused: revision containing withdrawn or blocked material (`consent_denied`); `requireApproved` without an active approval
of that exact revision (`approval_invalid`). Open stale flags do not stop an export; they are listed in `manifest.openFlags`.

## 4. Events

| Type | Subject | Payload |
|---|---|---|
| `editorial.document_revised` | `E09:document:<id>@<rev>` | `kind, revision, digest, previousRevision, docType, editorialProject` |
| `editorial.object_revised` | other kinds, with revision | `kind, revision, digest, previousRevision` |
| `editorial.review_requested`, `editorial.review_returned`, `editorial.approved` | object with revision | `kind, revision, …` |
| `editorial.block_stale`, `editorial.block_blocked` | `E09:block:<doc>.<block>@<rev>` | `reason, cause, ref, changeKind, object` |
| `editorial.object_stale`, `editorial.object_blocked` | viewpoint / asset / document / project with revision | same |
| `editorial.approval_invalidated` | object uref at the **approved** revision | `approval, reason, cause, ref, changeKind, mode` |
| `editorial.translation_stale` | translation block | `reason, cause, sourceBlock, translation` |
| `editorial.suggestion_proposed` | document with revision | `suggestion, origin: human \| model` |
| `editorial.exported` | document with revision | `export, revision, digest, formats` |

The catalog's older names map as: `story.revised` → `editorial.document_revised`, `scene.fact_dependency.changed` →
`editorial.block_stale`, `creative.review.requested` → `editorial.review_requested`.

### `applyUpstreamChange(ctx, { eventId, kind, refs, reason })`

Dependencies are stored per object revision and block (`links`): block sources, viewpoint (its participant, consent and
testimony refs), scene assets (registered entry, its target and rights refs), consent prerequisites, the investigation
package a document was generated from, `investigationRefs` of an editorial project.

- Matching ignores the revision of the changed object: a block citing any revision ≤ the changed one (or unpinned) is affected.
- `permission_withdrawn` → `blocked`; every other kind → `stale`.
- Blocks/objects of the **current** revision get an open flag (reason, cause = eventId, ref) and an event. Text is never changed.
- Any revision with an **active approval** that depends on the ref: the approval becomes `needs_renewal`
  (`editorial.approval_invalidated`); the approved revision keeps its text and digest.
- `permission_withdrawn` also records the ref as withdrawn: no changed block or new viewpoint/asset may start depending
  on it, and no revision containing it can be exported. `permission_changed` lifts that record only when
  `UseDecisionPort` now answers `allow`.
- Idempotent by `eventId` per tenant/project (stored result is returned). Returns `{ affected }`: block, object and approval urefs.
- Stale flags close by `resolveFlag` / `resolveFlagIds` (a recorded human judgement), or when the block or the reference
  is removed. Blocked flags close only when the withdrawn reference is gone from the block.

Translations: each translated block records the hash of its source block at the pinned source revision. Saving the
source with a changed or removed block flags the translation block stale; saving the translation re-pinned to a
revision whose block matches the current source closes the flag.

## 5. HTTP

Standard kit routes: `GET /healthz`, `GET /v1/manifest`, `GET /v1/inspect?ref=`, `GET /v1/search?q=`, `GET /v1/audit`,
`GET /v1/events`, `POST /v1/upstream-changes`.

For each `<seg>` in `series, collections, projects, collaborators, viewpoints, assets, documents`:
`POST /v1/<seg>` (`{ body, compartment?, …SaveOptions }`), `GET /v1/<seg>`, `GET /v1/<seg>/:id[?revision=]`,
`POST|GET /v1/<seg>/:id/revisions`, `GET /v1/<seg>/:id/diff?from=&to=`, `POST /v1/<seg>/:id/restore`,
`POST /v1/<seg>/:id/review`, `POST /v1/<seg>/:id/return`, `POST|GET /v1/<seg>/:id/approvals`,
`POST|GET /v1/<seg>/:id/comments`, `POST /v1/<seg>/:id/assignments`.

Also: `POST /v1/documents/:id/suggestions`, `POST /v1/suggestions/:id/accept`, `POST /v1/comments/:id/resolve`,
`GET /v1/assignments`, `PATCH /v1/assignments/:id`, `GET /v1/flags`, `POST /v1/flags/:id/resolve`,
`POST|GET /v1/documents/:id/translations`, `GET /v1/documents/:id/fact-check`, `POST|GET /v1/documents/:id/exports`
(`{ revision, …options }`), `POST /v1/documents/:id/proposals`, `POST /v1/generate`, `POST /v1/lyrics/analyze`,
`POST /v1/lyrics/rhymes`, `GET /v1/assets/:id/usage`, `GET /v1/viewpoints/:id/usage`.

Catalog routes: `POST /v1/creative/projects` (= `POST /v1/projects`), `POST /v1/stories/:id/versions`
(= document revision), `POST /v1/scenes`, `GET /v1/stories/:id/fact-map` (= fact-check).

The `Idempotency-Key` header is accepted in place of `idempotencyKey`. Errors: `invalid_*` 400, `unauthenticated` 401,
`forbidden` / `consent_denied` 403, `not_found` 404, `revision_conflict` / `invalid_state` / `approval_invalid` /
`idempotency_conflict` 409, `unavailable` 503 (answered by the engine's routes with the name of the missing collaborator).

## 6. What is and is not verified

Tested on real PostgreSQL (`npm run check` with `TEST_DATABASE_URL`): label and source enforcement, standalone/deny
behaviour, fail-closed authorization, history / diff / restore, idempotent replay, concurrent edit conflict, approvals
and renewal, generators from a fictional package in the E08 shape, fact-check ledger, exports and manifests, translation
staleness, satire/campaign separation, withdrawal blocking, series / collections / assets / collaborators, comments /
suggestions / assignments / model proposals (in-process fake port), tenant / project / compartment isolation, HTTP end to
end through the real `serve` entry in a child process.

Not implemented or not verified:

- `httpKnowledgePort` and `httpModelPort` are generic adapters with their own small JSON contracts (see `ports.ts`).
  They are tested against a controlled local server only: **implemented, not verified against a live E07 or a live model provider**.
- Integration with the real E07, E08, E10, E11 and E12 engines has not been run from this repository; the package
  fixture copies E08's shape by hand.
- Lyrics: syllables and rhymes come from spelling rules, not a pronouncing dictionary. Irregular words can be miscounted,
  stress and true metrical feet are not analysed, and rhyme candidates must be supplied (caller, document text or lexicon).
- Fountain output follows Fountain conventions but has not been checked with a third-party Fountain parser.
- No rich-text formatting inside blocks, no real-time co-editing or presence, no merge of conflicting edits (the second
  writer reloads), no block-level locking, no notification delivery for assignments.
- E08 finding refs on `verified_fact` blocks are not status-checked through a port; staleness arrives through `applyUpstreamChange`.
- Search is a case-insensitive substring match over titles and block text, without ranking or stemming.
- A viewpoint or asset revision flags its users stale; it does not re-run use decisions on them.
- No independent security review has been performed.
