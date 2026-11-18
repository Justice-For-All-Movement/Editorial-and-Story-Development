# Private export disclosure authority

This checkpoint changes only `exportDocument`'s optional host `AuthorizationPort` admission. It captures that port's method and receiver once before the first callback. Both the pre-SQL check and a fresh check after the actual transaction returns require literal `allowed === true`; absent/malformed decisions, getter errors and callback exceptions deny with a fixed message. Removing or replacing the host property during a request cannot skip the captured final check. Initial absence remains the existing optional mode, not authenticated authority.

The final check covers new exports, identical cached acknowledgements, configured object storage and exports without object storage. It happens after SQL COMMIT acknowledgement. A denied or unknown final decision withholds the whole response; the already committed export, audit, event and idempotency acknowledgement remain retained. An authorized explicit identical replay may return that original acknowledgement, without another object put or export effect. A denied replay cannot infer rollback or retry with new authority.

## Qualification checkpoint

Base is accepted PR5 merge `91c1e22100270e194cbca41d2dcbaf494e6f51b2`. Regression-only source `9b85f2a99c21041f5c11fba6dd3bee3b5a75a4fa`, raw jobs `135011402550` and `135011307431`, reproduced all four new failures: 54 tests, 50 passes, 4 failures, zero cancellations/skips. Malformed truthy admission reached SQL; all three post-operation denial assertions lacked an expected rejection.

Runtime source `76d8b49675e24b1d29ec681096ea6fb08d85ccd3` passes all eight head checks. Raw `135012509872`: all 54 ordinary tests pass, zero failures/cancellations/skips. Raw `135012510438`: four focused source tests (one synthetic pre-SQL, three actual own-PG groups), the actual E11 source test, actual E11 normally freshly installed public-serve test, and all four focused installed public-engine tests pass, each with zero failures/cancellations/skips. Raw Knowledge `135012510472` and Factual `135012510275` retain their actual pinned source/fresh-installed peer checks. No combined E01 human/whole-rights qualification is inferred.

Local focused strict-admission group passes (one test, zero failures/cancellations/skips); typecheck, build and original-registry validation pass using copied prepared dependencies. No local PostgreSQL, full-local or full-installed 54-test ordinary-suite claim. Source review is clear for captured strict authority/fresh post-COMMIT withholding and retained one-effect replay; final documentation-head CI/rules/expected-head merge remain pending at this checkpoint. SHA manifest: `export-disclosure-authority-verification.json`.

## Limits and remaining work

Synthetic host callbacks qualify execution/withholding boundaries, not E01 human proofing, current membership/roles or original-human delegation. No real E01 adapter is introduced. A service credential authorizes its calling service and cannot impersonate a human named in metadata. Context copies are not authentication. Callback selection is stable per request; decisions are not cached. Host callback deadlines, CPU/heap limits and lifecycle/PKI/TLS/driver acceptance remain separate.

This check does not revalidate all Consent/Knowledge/Factual permissions or own visibility after storage; those existing pre-export checks and their separate limits remain. Recursive E09 dependency currentness and final whole-source/visibility checks remain ready work. Sequential checks are not distributed permission fencing: revocation may occur after the final check, and an export effect can commit before a final denial. Copies already returned cannot be revoked.

An object put that throws or loses acknowledgement can leave retained uncertain storage while SQL rolls back or has unknown outcome. This checkpoint does not add a distributed SQL/filesystem transaction, orphan reconciliation, quiescence proof, automatic replay, cleanup or deletion authority. Preserve uncertain objects/history for separately authorized reconciliation. A lost SQL COMMIT acknowledgement propagates uncertainty; the final check does not claim rollback or return an unacknowledged transaction result.

Original six E09 tasks, all dependencies, public 15-engine/122-task four JSON files, SQL schema, SDK pins, dependencies and vendored kit/contracts remain unchanged. Fictional private development only; no publication, provider send, payment, paid infrastructure or operational PAM.
