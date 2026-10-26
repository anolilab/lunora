# Plan 532 — `@lunora/privacy`: close the open status items, and read consent from c15t

**Baseline:** `ce1d4f36f` on `origin/alpha` (2026-10-25)
**Status:** IN PROGRESS. WS A, B, C and I are DONE (2026-10-26). WS D–H (c15t) are TODO and need the §9 decisions.

## 0. Headline finding

Plan 468's own Status section is partly stale. All three of its "not finished" code items are
smaller than written, and one real defect is missing from the list:

- **Real defect.** `examples/privacy/lunora/privacy-ports.ts:202` returns
  `/privacy/files/<key>?expires_in=…` as the download link. Nothing serves that path, so the
  Art. 15 download the example advertises cannot be fetched. This is the first thing to fix.
- **Stale.** The package README says there is no sign-in, but `subject.ts` reads the session's `iat`
  and refuses erasures from sign-ins older than 24 h. The example also has a workerd lifecycle suite,
  and `scripts/test-workerd.sh` discovers it automatically.
- **Still open.** `authDataset` and `retain()` are not used anywhere in the example. So the archive
  purge path has never run in a real app, and the `retain` rule path is untested end to end.
- **Not closable by code.** Every LR/TR row in §10 of plan 468, and `docs/legal.mdx`, need a lawyer and a
  tax adviser. The default rules stay unshipped until they sign off.

The c15t part is a read-only integration. Privacy reads a subject's consent state from c15t for Art. 15
and for a `consent()` check. It does not manage consent, and it cannot erase c15t records, because
neither the HTTP API nor `@c15t/node-sdk` has a subject delete. That is the main design constraint.

## 1. Current state (audit)

Checked against `origin/alpha`, not against the README's own status text.

| Status item (README "Not finished")     | Verdict                   | Evidence                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No end-to-end demo                      | **Partly done**           | `examples/privacy` runs sign-in (`lunora/subject.ts`), a `tasks` dataset, export, erasure, cancel, restore, and a daily cron (`lunora/crons.ts`). Missing: `authDataset`, `retain()`, a table with a retention rule.                                          |
| Workerd suite for storage paths         | **Partly done**           | `examples/privacy/__tests__/workerd/lifecycle.workerd.test.ts` has 4 cases: export and archive, erase only theirs, cancel in grace, restore re-erase. Not on workerd: the sweep (`housekeeping.test.ts` is node-only), file expiry, and `archive.purgeBatch`. |
| Workflow handler vs codegen (plan §4.2) | **Mostly done**           | `examples/privacy/lunora/_generated/workflows.ts` emits `PrivacyExportWorkflow`, `PrivacyErasureWorkflow` and `PrivacyRestoreWorkflow` over `privacyWorkflows.*` (per-call `privacyFor`). Only a regression gate is missing.                                  |
| Download link (not in README)           | **Open defect**           | `examples/privacy/lunora/privacy-ports.ts:202`; the example README says the Worker does not serve the path yet.                                                                                                                                               |
| Legal and tax values                    | **Blocked on people**     | `packages/privacy/docs/legal.mdx`; plan 468 §10.                                                                                                                                                                                                              |
| Phase 0 measurements                    | **Stale for the PDF lib** | Plan 468 §7 measured `pdf-lib` 1.17.1, not the `@cantoo/pdf-lib` fork it decided on. Re-measure on workerd.                                                                                                                                                   |
| Package's own test config               | **No workerd project**    | `packages/privacy/vitest.config.ts` is node-only. The storage paths run only in the example.                                                                                                                                                                  |

**Overlap:** PR #1286 (`fix/privacy-audit-erasure`, open) changes erasure replay, coverage, retention and
persistence in the same package. Every workstream below that touches `define.ts`, `run.ts` or `ports.ts`
should wait for it or rebase on it.

**c15t surfaces (`github.com/c15t/c15t`, `canary`, read on 2026-10-25):**

- Backend routes (`packages/backend/src/http/`): `GET /consents/check`, `GET|POST /subjects`,
  `GET|PATCH /subjects/:id`. **No DELETE.**
- `packages/node-sdk/src/contract.ts`: `consents.check` `:688` (`GET /consents/check`, API key),
  `subjects.get` `:526` (`GET /subjects/:id`, no key), `subjects.list` `:564` (API key),
  `subjects.identify` `:654` (`PATCH`). `subjects.create` is `POST /subjects`.
- `patchSubjectInputSchema` (`packages/schema/src/api/subject/patch.ts:20`): `externalId` is a required
  string. A subject cannot be unlinked through the API.
- `packages/node-sdk/src/transport.ts:52`: `Authorization: Bearer <apiKey>`.
- `packages/node-sdk/src/identity-token.ts:90`: `createIdentityToken(user, { signingKey })`, a local signer.
- Backend `http/context.ts:153` and `db/migrations/8-verified-external-id.ts`: a subject counts toward
  `consents.check` and `subjects?externalId=` only after a **verified** link. Without a link, `hasConsent`
  is `false` for everyone.
- npm: `@c15t/node-sdk` `latest` = `3.1.0`, `canary` = `3.2.0-canary.0`. `@c15t/schema` 3.1.0 depends on
  `base-x`, `valibot` and `@c15t/translations`.

**Privacy seams:**

- `packages/privacy/src/define.ts:63` — `ports` is a per-call factory (the `ctx.db` lifetime).
- `packages/privacy/src/ports.ts` — `DataPort`, `StorePort`, `ArchivePort`, `PrivacyPorts`. Nothing in
  ports reaches the network today.
- `packages/privacy/src/dataset.ts` — `defineDataset`. Tables are the unit of coverage.
- `packages/privacy/src/run.ts:146` and commit `47772f3ee` — `requireTables` throws `INTERNAL` when a
  dataset table is missing from a `collect` or `remaining` result.
- Plan 334 (`mutation determinism`): `ctx.fetch` is refused in queries and mutations. Any network call
  belongs in a workflow step or an action.

## 2. Existing seams (do not reinvent)

- **Ports, not provider code.** A provider API reached from the core breaks the parity rule. Each provider
  is an app-supplied port, the way `StorePort` already works.
- **Tombstone pattern.** `ctx.env` is reachable only from the erasure workflow, and a run from a mutation is
  refused. The c15t key is bound the same way: only workflow steps and actions see it.
- **Steps.** `collect:<dataset>` steps already memoise per dataset, so an external source gets one step
  per call and a durable retry.
- **Subpaths.** `@lunora/privacy/eu`, `/de`, `/workflow` set the pattern. A `/c15t` subpath follows it.
- **Identity.** `privacyFor(ctx, identity?)` already carries the subject. The c15t `externalId` is the
  Lunora subject id, and no new identity concept is needed.

## 3. The behavioural contract to preserve

- Export and erasure keep their existing step names. `privacy/v1/<phase>/<datasetId>` is a durable-log
  contract (plan 468 §4.2). New steps get new names and never rename an old one.
- No new mutation performs network I/O. `consent()` runs from an action or workflow only.
- The core package gains no runtime dependency. `@c15t/node-sdk` is an optional peer of the subpath only.
- A c15t outage fails the export step (retried) and does not silently omit the c15t part. A missing part is
  a `remaining`-style refusal, the same as a missing table.
- `api-snapshots` for `@lunora/privacy` change only additively, and every change goes through
  `api:update` after `build:packages`.

## 4. Design decisions

**D1 — Scope amendment to plan 468 §4.1.** Plan 468 says consent is out of scope. This plan reads consent
from an external CMP for data-subject rights. It does not manage consent, collect consent, or gate sending.
_Alternative rejected:_ leave §4.1 and ship the c15t work as an app-only example. Then the export cannot
include c15t records through the package, and every app rewrites the same join. **Needs maintainer sign-off**
(§9 Q1).

**D2 — Consent source is an app port, with a `@lunora/privacy/c15t` adapter.** The core defines a
`ConsentSource` port (`collect(subjectId)`, `check(subjectId, types)`, `keep(subjectId, reason)`). The subpath
ships `c15tConsentSource({ baseUrl, apiKey, fetch? })`, a factory over `createC15tClient`.
_Alternative rejected:_ import `@c15t/node-sdk` in the core. It couples every privacy app to one CMP, and it
breaks the `/eu`/`/de`-style optional-subpath rule.

**D3 — Client: `@c15t/node-sdk` as an optional peer, not a hand-written `fetch`.** The SDK gives typed error
codes, retries honouring `Retry-After`, input validation, and a mock client under `/testing`. A hand-written
client is about 40 lines and has none of that. The peer range is a real semver range (`>=3.1.0 <4`), not
`catalog:`, per the catalog-in-peerDependencies trap. The dev pin goes in a catalog entry. The SDK's `latest`
is `3.1.0`, so do not pin `canary`.
_Alternative to record:_ a Lunora-native client against the backend's documented HTTP contract. Rejected for
now because it re-implements validation and retry, and the SDK already does both. Revisit if the SDK's
workerd support fails (see §8).

**D4 — The calls run in workflow steps, not mutations.** Plan 334 refuses `fetch` in mutations. So:

- Export: one `collect:c15t` step inside `privacyExport`. Its result is the subject's c15t records, a
  receipt-sized JSON document (well under 1 MiB).
- Erasure: one `keep:c15t` step, after the Lunora tables are erased and before verify.
- `consent({ types })` is a bound API method callable from an action or a workflow. A call from a
  query or mutation is refused the way `ctx.fetch` is.

**D5 — Erasure cannot delete c15t records, so they are kept, with a stated basis.** The API has no DELETE,
and `PATCH` cannot clear `externalId`. The records are the controller's evidence of consent (Art. 7(1)). Whether that
evidence falls under the Art. 17(3) exceptions (legal obligation, or legal claims in (b) and (e)) is a legal
question, not a code decision, so the basis gets a **LEGAL REVIEW** row and ships only once it is answered.

- The erasure records `c15t: kept, reason "proof of consent", until <policy date>` in the request events.
- The subject's Lunora requests show that the c15t records were kept, and why.
- For self-hosted backends, an operator runbook covers a direct database delete, outside the API.
  _Alternatives rejected:_ silently skip c15t (the verify step would then pass a lie), and call a delete
  route the API does not have.

**D6 — The consent check is a read, and it does not gate anything.** `privacy.consent({ types })` calls
`consents.check` for the caller. The export includes `subjects.get` records. Nothing in the core blocks a
send. Gating belongs to the app and is out of scope (plan 468 §4.1).

**D7 — Linking is a sign-in step, and it is required.** The backend counts a subject only after a verified
link (`context.ts:153`). The example's sign-in route mints
`createIdentityToken({ externalId: user.id }, { signingKey })` and returns it. The browser passes it to the
c15t client's `identify()`. Without this, `consent()` says `hasConsent: false` for every user. This is app
code and docs, not core code.

**D8 — The download link is served by the example Worker.** Replace the stub (`privacy-ports.ts:202`) with
`buildSignedUrl` from `@lunora/storage`, and serve `/privacy/files/*` from the Worker, checking the link with
`verifySignedUrl` (both exported from `packages/storage/src/index.ts:7`). The signature binds the host, bucket
and key, and `buildSignedUrl` rejects a subpath base. So the example needs a configured public base URL, which
the stub does not have. _Alternative rejected:_ drop the link and return bytes from the query. That fails for
large exports.

## 5. Workstreams

| WS  | Size | Work                                                                                                                                                                                                                                    | Blocked by |
| --- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 0   | S    | Maintainer sign-off on §9 Q1–Q4. Decide whether #1286 lands first, then rebase this branch on it.                                                                                                                                       | —          |
| A   | S    | Fix the download route (D8) and add a workerd test: the link resolves, and an expired or tampered one is refused.                                                                                                                       | 0          |
| B   | S    | Make the example exercise what the README claims it covers: add an `authDataset` and a table with `retain()` (the `de.voucher` rule) so archive purge runs on workerd. Add a sweep and file-expiry case to `lifecycle.workerd.test.ts`. | #1286      |
| C   | S    | Regression gate for the codegen shape: a test asserting `_generated/workflows.ts` emits the three privacy entrypoints, run in CI. Re-measure `@cantoo/pdf-lib` on workerd (plan 468 §7).                                                | —          |
| D   | M    | `ConsentSource` port in `ports.ts`, plus `consent()` on the bound API and the export and erase step wiring in `run.ts`. The core ships no provider code. Unit tests use a stub source.                                                  | #1286, 0   |
| E   | M    | `@lunora/privacy/c15t` adapter over `@c15t/node-sdk` (D2, D3). Unit tests use `@c15t/node-sdk/testing`. Export the factory only. Named exports only.                                                                                    | D          |
| F   | S    | Workerd test for the adapter with outbound `fetch` stubbed. Confirms `AbortSignal.any` and `crypto.randomUUID` exist in workerd, and that the bundle has no Node-only import. Run `pnpm run dist:check`.                                | E          |
| G   | S    | Example: sign-in mints the identity token (D7); a `consent` action; the export includes c15t records; the erasure keeps them and says why (D5).                                                                                         | E, A       |
| H   | S    | Docs: `docs/index.mdx` gets a c15t section, with the link step, the kept-records rule, and the self-host runbook. `docs/legal.mdx` gets the proof-of-consent row, marked LEGAL REVIEW.                                                  | G          |
| I   | S    | Status sync, in the same change as B and G: the package README "Status", plan 468's status line, and the `plans/README.md` row (plan 468 is listed as "Phase 0"; it is not).                                                            | A, B, G    |

**Package and dependency changes:**

- `packages/privacy/package.json`: add the `./c15t` export. `@c15t/node-sdk` goes in `peerDependencies`
  (optional, `peerDependenciesMeta`) with a real range. Its dev version goes in a `catalog:` entry in
  `pnpm-workspace.yaml`. Run `pnpm run lint:package-json` after editing.
- No change to `PlatformCapabilities`, `ctx.*`, or the registry.

**Done (2026-10-26):**

- **WS A.** The download is a signed `/privacy/files` route (`lunora/http.ts`), mounted on the Worker through `createWorker({ httpRouter: app })` in `src/server/worker.ts`. Until it was mounted the route was unreachable, so a Worker-level test (`__tests__/download-route.test.ts`) now sends a real request through `buildWorker` and checks the internal `requests:exportFile` read. Sabotage: removing the mount fails it. The link is an HMAC over the key and expiry, keyed by `PRIVACY_FILE_SECRET` (`lunora/privacy-files.ts`). Tests: `__tests__/privacy-files.test.ts`, the link case in `privacy.test.ts` (it changes only `exp`, so only the signature can refuse it), and the Worker test. Sabotage: forcing the verifier to `true` fails three tests. Deviation: the plan named `@lunora/storage`'s `buildSignedUrl`. It binds the host and needs object storage, so it does not fit a DB-stored archive.
- **WS B.** `invoices` with `retain("de.voucher")` (`lunora/privacy.ts`, `billing` dataset). Retained rows go to the package's `privacy_archive`, which already has the required shape, not a new table. The sweep purge runs in `__tests__/retention.test.ts` and in the workerd lifecycle. The restore re-erasure now collects subject ids from `tasks` and `invoices` (`restoredSubjectIdsOf` in `lunora/admin.ts`), so an invoice-only subject is covered; it was missed before. Export expiry runs in the workerd lifecycle. `authDataset` is NOT done: the example's identity is `ctx.auth` claims, not shard rows, so there is nothing for it to cover until the example adopts `@lunora/auth`. The package has no workerd project of its own, so the storage suite lives in the example.
- **WS C.** `__tests__/generated-workflows.test.ts` gates the three generated entrypoints. The summary PDF was re-measured on workerd with `@cantoo/pdf-lib` (600 datasets: 37 pages, 96 KB, 300 ms). The earlier figure was for `pdf-lib` 1.17.1 at 40 pages, so the two are not like-for-like.
- **WS I.** The package README Status, `docs/index.mdx` "What is not finished", the example README, plan 468's status and its index row are updated.

## 6. Platform parity

This plan adds no `ctx.*` surface and no binding. `consent()` is a bound method on the privacy object, not on
`ctx`. The one new outbound call is a `fetch` from a workflow step or action.

| Feature                               | `cloudflare` | `node` | `celld` | Notes                                                                                             |
| ------------------------------------- | ------------ | ------ | ------- | ------------------------------------------------------------------------------------------------- |
| outbound `fetch` from a workflow step | native       | native | native  | Needed by the c15t adapter only. The adapter is opt-in, so a host without the peer is unaffected. |

No `PlatformCapabilities` row changes. Confirm this when landing WS D, since the gate for it is `dist:check`
and not the matrix.

## 7. Phasing & ordering

| Phase | Work                    | Gate                                                                                                                                                                                        |
| ----- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | WS 0                    | §9 Q1–Q4 answered in writing. #1286 status known.                                                                                                                                           |
| 1     | WS A, B, C              | `pnpm run test:workerd` green with the new `lifecycle.workerd.test.ts` cases. The download route test fails if the signature check is removed (sabotage check).                             |
| 2     | WS D, E, F              | Core unit suite green with stub source. Adapter suite green. `pnpm run test:workerd` green with the stubbed-fetch case. `pnpm run dist:check` and `api:check` green after `build:packages`. |
| 3     | WS G, H, I              | Example lifecycle test covers the kept-records path. `apps/docs` build passes. Status rows agree with the code (checked by reading the test names, not the prose).                          |
| 4     | Legal review (not code) | Each LEGAL REVIEW and TAX REVIEW row signed off by its professional. Until then the defaults stay unshipped. This is the maintainer's to complete.                                          |

Every phase has a gate that can fail. Phase 1's sabotage check and Phase 2's `dist:check` are the two that catch
a silently green suite.

## 8. Risks & STOP conditions

- **STOP if `@c15t/node-sdk` fails on workerd** (`AbortSignal.any`, `crypto.randomUUID`, or a Node import in its
  bundle). Fall back to the native client in D3, and re-plan E.
- **STOP if a c15t record cannot be kept under a stated basis.** Erasure then needs an operator runbook before
  any code ships. Do not ship a silent skip.
- **Consent false negatives.** An unverified link reads as no consent. The Phase 3 gate must include a test where
  the link is missing, so the failure is visible.
- **Bundle weight.** `@c15t/schema` brings `valibot` and `@c15t/translations`. Measure the example bundle before and
  after, and record the delta in the PR.
- **Overlap with #1286.** Rebase or wait. Do not merge D into a branch that still carries the pre-#1286 erasure code.
- **Legal conclusions.** Nothing in this plan is legal advice. The D5 basis is a LEGAL REVIEW row until a lawyer signs it.

## 9. Open questions: maintainer decisions (each with a recommendation)

1. **Amend plan 468 §4.1?** Recommend yes: privacy reads consent, and it does not manage or gate it. (Changes D1.)
2. **Adapter over the SDK, or a native client against the documented HTTP contract?** Recommend the SDK as an optional
   peer (D3). The native client is the fallback if §8's first STOP fires.
3. **Erasure of c15t records: keep as proof of consent, or require an operator runbook?** Recommend keep, with the
   LEGAL REVIEW row and a runbook for self-hosted backends (D5).
4. **Does `consent()` gate anything in the core?** Recommend no (D6).

## 10. Items needing legal (LR) or tax (TR) review

- **LEGAL REVIEW:** proof-of-consent retention after erasure (D5, Art. 7(1), Art. 17(3)(b)/(e)).
- **LEGAL REVIEW:** whether a consent-check result is itself personal data that the export must list (Art. 15).
- **TAX REVIEW:** none new. The plan 468 TR rows are unchanged.
- **Open since plan 468:** every LR/TR row, and `docs/legal.mdx`.
