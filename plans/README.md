# Implementation Plans

What is planned, in flight, or kept as a reference design. **A plan file is deleted
once it ships**; the record lives in git history and in the PR that landed it. The
full wave-by-wave log (waves 1–22 and the parity passes, every shipped and rejected
plan) was retired on 2026-10-06 — read it at
[`f01e4ff5:plans/README.md`](https://github.com/anolilab/lunora/blob/f01e4ff55da15f8bcef232f4c9b237487f7798aa/plans/README.md).

Status values: TODO | IN PROGRESS | DONE | BLOCKED (one-line reason) | REJECTED.

New plans start from [`TEMPLATE.md`](./TEMPLATE.md). Its **Platform parity**
section is mandatory for anything that adds or changes a `ctx.*` surface, a
provider binding, or a deploy/runtime capability: state the mapping per target
(`native` | `emulated` | `unsupported`) or the explicit non-support. Codegen reads
that matrix, so a row left unstated ships a surface that silently does nothing on
the target it was never mapped for.

When a plan ships: delete its file and remove its row here in the same change.

## In progress

| Plan                                             | Title                                                               | Remaining                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [527](./527-ratelimit-memory-store-retention.md) | Evict rate-limit memory-store entries past their horizon            | PR #1223 open; debt (negative) entries deliberately kept                                                                                                   |
| [528](./528-durable-ratelimit-row-retention.md)  | Expire durable rate-limit rows (`createDbStore` / `createSqlStore`) | PR #1225 open, stacked on #1223; bounded sweep on write; tests tightened in a stacked follow-up                                                            |
| [460](./460-cloudflare-artifacts.md)             | Cloudflare Artifacts as an action-only `ctx.artifacts`              | A–D shipped (#926 + D deploy check); live probes remain (need Workers Paid)                                                                                |
| [463](./463-experimental-graduation.md)          | Graduate the experimental tier to stable                            | A shipped (#1002), B1 `payment` graduated (#1001); remaining packages                                                                                      |
| [166](./166-enterprise-auth-saml-scim.md)        | Enterprise auth: SAML SSO + SCIM                                    | Phase 1a (OIDC SSO + SCIM Users) shipped; Phase 1b SAML gated                                                                                              |
| [464](./464-replay-conflict-resolution.md)       | Replayed offline writes that conflict                               | Phase A shipped (docs + test); Phase B waits on a real app needing a merge the handler can't express                                                       |
| [468](./468-gdpr-package.md)                     | `@lunora/privacy`: data-subject rights (export, erasure, holds)     | Built end to end; example covers download, retention and expiry; open: legal and tax review (§10)                                                          |
| [364](./364-studio-conversational-assistant.md)  | Conversational assistant for the Studio                             | W1–W9 shipped (assistant reachable studio-wide, server-side data-sharing ladder, hardened markdown); W5 (streaming) blocked — needs its own transport plan |

## Open (TODO)

| Plan                                                   | Title                                                                      | Notes                                                                                                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [532](./532-privacy-status-and-c15t-consent.md)        | `@lunora/privacy`: close the open status items; read consent from c15t     | WS A, B, C, I done (privacy PR); c15t WS D–H TODO, needs §9 decisions                                                                                    |
| [536](./536-deleteall-hard-includes-soft-deleted.md)   | Make a hard `deleteAll` / `wipeShard` erase soft-deleted rows              | APPROVED, branch `fix/improve-536-deleteall-hard-soft-deleted` (d93ae4424), awaiting merge                                                               |
| [537](./537-pause-read-failure-keeps-last-state.md)    | Keep a seen pause when a later pause-flag read fails                       | APPROVED, branch `fix/improve-537-pause-read-failure` (c9cee5101), awaiting merge                                                                        |
| [538](./538-refuse-soft-delete-join-table.md)          | Refuse a `.softDelete()` join table behind a many-to-many relation         | APPROVED, branch `fix/improve-538-soft-delete-join-table` (d91776aa0), awaiting merge                                                                    |
| [539](./539-scheduler-dispatch-signature-binding.md)   | Bind the scheduler-dispatch HMAC to a timestamp and the forwarded identity | APPROVED, branch `security/improve-539-scheduler-dispatch-signature` (453db6d3b, 4ce724b43), awaiting merge; wire change both sides                      |
| [540](./540-signed-get-serve-authorizer.md)            | A signed-GET authorizer for `serveStorageObject`, used in the docs         | APPROVED, branch `security/improve-540-signed-get-authorizer` (16a6b7920, be59c31eb), awaiting merge                                                     |
| [541](./541-replay-subscription-refusal.md)            | Replay a refused subscription to late subscribers                          | APPROVED, branch `fix/improve-541-replay-subscription-refusal` (aa4f33dc0, 2d755d3bd), awaiting merge; intent assumption §4                              |
| [542](./542-harness-wire-round-trip.md)                | Wire-round-trip `lunoraTest` results like production                       | APPROVED, branch `fix/improve-542-harness-wire-round-trip` (7ddac23da, stacked on 543), awaiting merge                                                   |
| [543](./543-scheduled-job-composed-clock.md)           | Give composed calls in a scheduled job the virtual clock                   | APPROVED, branch `fix/improve-543-scheduled-job-clock` (5e8333fc2), awaiting merge; merge before 542                                                     |
| [544](./544-privacy-restore-retires-requests.md)       | Retire restored privacy requests as a completed erasure does               | APPROVED incl. `restored` status; branch `fix/improve-544-privacy-restore-retires` new commits 2dfd74eb7, f171f942e, d906f6733 (PR #1533), awaiting push |
| [545](./545-restamp-mid-replay-writes.md)              | Restamp offline writes that are mid-replay                                 | APPROVED, branch `fix/improve-545-restamp-mid-replay` (63fc94e91), awaiting merge                                                                        |
| [546](./546-backed-off-subscription-retry-design.md)   | Retry a backed-off live query without waiting for a write                  | BLOCKED: owner confirms §9 Q1 (failed hinted re-run keeps the subscription); phase 1 specified, phase 2 plan-only                                        |
| [547](./547-seed-commit-after-persist.md)              | Record seeded rows only after `persist` succeeds                           | APPROVED, branch `fix/improve-547-seed-commit-after-persist` (d52651512), awaiting merge                                                                 |
| [548](./548-agent-docs-and-roadmap-counts.md)          | Correct the package and workerd counts in AGENTS.md and ROADMAP            | APPROVED, branch `docs/improve-548-agent-docs-counts` (3e8f4f6ed), awaiting merge                                                                        |
| [549](./549-nightly-runs-path-gated-suites.md)         | Run celld, MySQL, SDK conformance and SaaS e2e in the nightly              | APPROVED, branch `ci/improve-549-nightly-path-gated` (b4889fa4b), awaiting merge; first nightly run unverified                                           |
| [550](./550-split-mixed-default-exports.md)            | Stop mixing a default export with named value exports                      | 7 files merged (#1539); Nuxt part APPROVED on `refactor/improve-550-nuxt-module-helpers` (4fd349f29, dc1e6a6c8), awaiting push                           |
| [551](./551-five-small-fixes.md)                       | Five small fixes: advisor, CLI eval, Nuxt alias, metric buffer, OTLP       | APPROVED, branch `fix/improve-551-five-small-fixes` (5 commits, head ace703305), awaiting merge                                                          |
| [552](./552-post-release-install-smoke.md)             | Install the published packages after a release                             | PLAN ONLY: needs npm and a release to verify                                                                                                             |
| [553](./553-ci-cold-production-builds.md)              | Measure, then stop rebuilding the production build cold per CI job         | PLAN ONLY: measurement first                                                                                                                             |
| [554](./554-file-level-eslint-disables.md)             | Move file-level `eslint-disable` blocks into the lint config               | PLAN ONLY: per-rule lint-config decisions                                                                                                                |
| [555](./555-cross-catalog-version-drift.md)            | Reconcile versions pinned differently across pnpm catalogs                 | PLAN ONLY: dependency decisions                                                                                                                          |
| [556](./556-real-clock-sleeps-in-tests.md)             | Stop new real-clock sleeps in tests; burn down the existing ones           | PLAN ONLY: large burn-down                                                                                                                               |
| [557](./557-shard-do-split-design.md)                  | Design the split of `shard-do.ts`                                          | PLAN ONLY: design, L                                                                                                                                     |
| [530](./530-vite-startup-ts-morph-graph.md)            | Keep ts-morph out of the Vite and cloudflare config-load graph             | BLOCKED: owner picks lazy codegen (~130 files) or async `lunora()` (public API change)                                                                   |
| [466](./466-local-replica-client-wiring.md)            | Wire `@lunora/replica` into every client                                   | decisions D1–D6 open; Phase 0 first                                                                                                                      |
| [467](./467-client-split-remaining-clusters.md)        | Finish splitting `lunora-client.ts`                                        | replay engine, frame handlers, admin surface; decisions D1–D3                                                                                            |
| [480](./480-scheduler-remove-id-less-complete-shim.md) | Require the job id on `/complete` so a completion frees its own slot       | blocked: needs a read-only check of production pool rows for `inFlightIds`                                                                               |
| [482](./482-ratelimit-db-store-atomic-consume.md)      | Make the ratelimit consume atomic on the D1-backed `.global()` table       | SQL and KV fixed in #1129; D1 needs a conditional write on `ctx.db` (in progress)                                                                        |
| [135](./135-stable-1.0-roadmap.md)                     | Road to stable 1.0.0                                                       | umbrella; phase/exit-criteria tracker for `alpha → main`                                                                                                 |
| [306](./306-pluggable-queue-drivers.md)                | Pluggable queue-driver package                                             | P2                                                                                                                                                       |
| [332](./332-payment-conformance-spike.md)              | Spike: what a payment-provider conformance suite asserts                   | spike; deliverable is a decision                                                                                                                         |
| [490](./490-lazy-function-registry.md)                 | Lazy function registry: Worker startup CPU scales with procedure count     | PARTIAL: lazy registry shipped opt-in (#1236), smoke-load (eager too); §9 budget open                                                                    |
| [168](./168-cross-shard-transactions-spike.md)         | Cross-shard transaction story                                              | spike; decision first                                                                                                                                    |
| [078](./078-custom-scalar-types.md)                    | Custom scalar types (`v.custom`)                                           | not shipped                                                                                                                                              |
| [089](./089-promise-pipelining-batch.md)               | Promise pipelining over the batch transport                                | draft, design-only                                                                                                                                       |
| [160](./160-adapter-voice-agent-consolidation.md)      | Consolidate the voice/agent surface across the 5 adapters                  | deferred                                                                                                                                                 |
| [033](./033-stream.md)                                 | Cloudflare Stream (video)                                                  | P3, deferred                                                                                                                                             |
| [037](./037-realtime-calls-webrtc.md)                  | Cloudflare Realtime / Calls (WebRTC)                                       | P3, deferred                                                                                                                                             |
| [133](./133-live-cdc-and-do-consumes-do.md)            | Live CDC ingest + DO-consumes-DO shape                                     | P3, demand-gated                                                                                                                                         |
| [169](./169-collab-crdt.md)                            | `@lunora/collab` (CRDT / collaborative editing)                            | demand-gated                                                                                                                                             |
| [453](./453-embedded-runtime.md)                       | In-process runtime as an embedded (browser / device) target                | phase 1 shipped; rest demand-gated                                                                                                                       |
| [454](./454-saas-kit.md)                               | Ship a Lunora SaaS Kit (`templates/saas`) composed from the registry       | P2; composition plan                                                                                                                                     |

## Shipped

Plans whose files were deleted on this branch. The commit column is the change that
landed the plan; a follow-up commit that completed it is listed after the first.

| Plan | Title                                                                       | Commit               |
| ---- | --------------------------------------------------------------------------- | -------------------- |
| 489  | Many-to-many relations through a join table                                 | #1146                |
| 479  | Make `createPayment`'s `authorize` required (default-deny)                  | 360c4f27c            |
| 483  | Make the `.dev.vars` create exclusive on the final path                     | 58e11f997, 88b7c1997 |
| 484  | Flag `v.any()` public args reached through an alias, destructure, or helper | e942bdb5f, 88b7c1997 |
| 485  | Stop presence `setData` heartbeats before mount or on the server            | c52580876, 7ac090ea7 |
| 486  | Gate raw data-read and observability MCP tools behind scopes                | ed2a1abe3, 88b7c1997 |
| 487  | Never send the master admin token in a WebSocket URL                        | 5e89bec39            |
| 481  | Cap presence by distinct user and bound the sweep read                      | #1129 (9acca8722)    |
| 488  | Serve the Node scheduler dispatch route for queue and topic handlers        | #1129 (9acca8722)    |
| 531  | Typed live topics; E (auto-mount the routes) was the last workstream        | #1314 (45f31b678)    |
| 445  | Pending-approvals inbox for the HITL surface (reference design)             | #1255 (5ee5072b2)    |

## Audit 2026-11-11

Findings audited at `5ed1688b6`, re-verified and planned against `4a7c48bfd` (`origin/alpha`).
Plans 536-551 except 546 (blocked on an owner decision) were dispatched to executor agents, each on its
own branch `<type>/improve-<NNN>-<slug>` cut from `4a7c48bfd` (542 is stacked on 543); a plan's Status
line records the review verdict. 550's Nuxt-module part is blocked on an owner decision.
Plans 552-557 are plan-only: each is large, needs a maintainer decision, or cannot be verified
without CI, npm or a release.

**Execution order.** 536, 537, 538, 547 (small, independent); then 539, 540, 541; then 543, 544,
545; then 542 alone; then 548, 549, 550, 551. 546 is blocked on an owner decision.

**Dependencies and merge order.**

- 542's branch is stacked on 543's commit (both edit the dispatch block of
  `packages/testing/src/harness.ts`): merge 543 first, or merging 542 brings 543 with it. No conflict.
- 541 and 545 both edit `packages/client/src/lunora-client.ts` or its neighbours in different
  regions; merge either first, the second should rebase cleanly.
- 539 changes the scheduler-dispatch wire contract on both sides (SchedulerDO signer, Worker and
  Node receivers) in one commit; a deployment must ship the scheduler and the Worker together.
- 536 and 539 touch storage or a Durable Object: run their packages' `workerd` projects before merging.

**Intent assumptions** (each plan's §4 states it): 537 (a failed read keeps a seen pause), 541 (a
late subscriber should receive the refusal, not trigger a resend), 544 (restored erasure requests
keep today's rekey-only handling), 550 (type-only companions of a default export are out of scope).

**Considered and rejected.**

- `.js` relative imports under `examples/*/lunora` and `templates/*/lunora`: possibly deliberate
  (that code is consumed by the app's own toolchain, and codegen emits `.js` there); not planned
  without the owner confirming the rule applies outside `packages/`.
- Gating the fallow dead-code check in CI: a policy decision with an unknown backlog, not a defect.
- Payment reconcile conditional write (listed under "Audit 2026-10-19"): fixed by `7f9d45540`
  (#1272), which guards the reconcile upsert on the row revision (`upsertRevisioned` + `patchIf`
  in `packages/payment/src/database-store.ts:310-347`). Entry removed.

## Audit 2026-10-19 — still open after PR #1272

Full table with evidence in [issue #1271](https://github.com/anolilab/lunora/issues/1271);
direction findings in [#1274](https://github.com/anolilab/lunora/issues/1274). Plans
532–535 and the second revision of #1272 fixed the rest. Recorded here so the next
audit does not re-report them:

- **ShardDO has no caller secret** (`do/src/shard-do.ts:14818-14845`): safe by host topology; add `LUNORA_SHARD_SECRET` like the registry/event-log secrets if a host ever exposes shard RPC on a socket.
- **Relay hub** (`shard-engine/src/relay-hub.ts`): cohort registry has no refcount and pins the op-log floor (`:1165-1170, 796-814, 566-570`); sibling HMAC signs bytes only, no seq/target binding, no key rotation (`sibling-channel.ts:45-67`); owner promotion latch is in-memory and counts owner-local sockets (`:605, 737-751`). M each, protocol design.
- **Persisted bearer fingerprint** (`len:fnv1a32:djb2`, `@lunora/client` and all 8 SDKs): offline oracle for low-entropy tokens; reference client moves first.
- **SDK vendoring path untested** (`cli/src/commands/sdk/vendor.ts:210-273`): `generated-check.sh` always passes `--from`.
- **RAG lexical join O(corpus)** (`ai/src/rag/sql-lexical-store.ts:216`), **`payments.check` ledger fold** (`payment/src/database-store.ts:299`), **`payment_events` / scheduler `dead:` retention** (needs a window: age, count, and how refund-claim rows are identified). The agent history read is bounded to the newest 200 messages when no compaction is set.
- **Studio edit runs codegen twice** (`config/src/studio-host/schema-edit-handler.ts:155`): the endpoint returns the synchronous run's diagnostics, so one owner must hand them back. **Codegen fixpoint re-infers everything per pass** (`codegen/src/run-codegen.ts:208`), **watcher refreshes the whole program** (`codegen-project.ts:117`).
- **Request log writes every successful dispatch** (`do/src/shard-do.ts:11663`): `LUNORA_REQUEST_LOG_SAMPLE` defaults to 1.0; metrics now flush every 8 dispatches. Decide a production sample default.
- **Studio chart `<style>` from config strings** (`studio/src/components/evilcharts/ui/chart.tsx:169`): confirm no SQL alias can reach it.

## Perf audit 2026-10-16 — measured and rejected

Recorded with numbers so a later audit does not re-report them.

- **Closed: plan 529**, RLS `patchMany` policy overhead. About 0.5 ms per 100 rows under a workerd DO, under the 5 ms gate. The plan's premise was wrong: the extra read is a point lookup.
- Subscription push fingerprint: ~1.2 ms encode per push at 1k rows, ~280 KB retained per subscription. No row-version contract exists, and delta framing parses the serialized baseline.
- `ts-morph` Project reuse: ~0.06 ms per Project, so nothing to save. The real CLI cost was module loading (772 → 169 modules), addressed by the CLI PR.
- Rate-limit DB `idCache`: built per call in `dbRateLimit`, so it does not grow across requests.
- D1 statement cache: already a bounded LRU.
- Pipeline `hashRow` and mask `hash` stringify: not on request paths.

Review PRs from this round, not yet merged: #1220 (history snapshot size cap), #1221 (reconcile
customer memo), #1222 (top-k fan-out selection), #1224 (CLI lazy modules, config light path).

## Reference designs

Design docs and spike findings that gate unbuilt follow-on work. Delete one when the
follow-on ships or is rejected.

| Doc                                                 | Subject                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| [052](./052-streaming-hook-design.md)               | Typed HTTP-SSE stream consumer (adapter parity, reconnect, POST bodies) |
| [137](./137-release-train-rehearsal.md)             | Release-train rehearsal, feeds 135 Phase 3                              |
| [162](./162-phase0-crosstabsync-design.md)          | crossTabSync subscribe relay (CLIENT-01)                                |
| [234](./234-node-host-findings.md)                  | Node host findings                                                      |
| [237](./237-admin-auth-hooks-design.md)             | Reactive admin/organization auth hooks; remaining adapters open         |
| [238](./238-vector-reader-design.md)                | `.withVectorIndex()` reader; codegen wiring + `define-rag` open         |
| [241](./241-inapp-inbox-design.md)                  | In-app inbox read half; D1 backend open                                 |
| [247](./247-event-store-design.md)                  | `defineEventStore`; not ratified                                        |
| [333](./333-query-snapshot-coherence.md)            | Snapshot coherence for query subscriptions                              |
| [334](./334-mutation-determinism.md)                | Determinism: ctx.random, ctx.fetch refusal shipped; research open       |
| [386](./386-queue-workpool-observability-design.md) | Observability for the Queues-backed workpool                            |
| [395](./395-sdk-stream-forms-design.md)             | Stream subscription forms for the non-Dart SDKs                         |
