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

| Plan                                             | Title                                                               | Remaining                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [527](./527-ratelimit-memory-store-retention.md) | Evict rate-limit memory-store entries past their horizon            | PR #1223 open; debt (negative) entries deliberately kept                                             |
| [528](./528-durable-ratelimit-row-retention.md)  | Expire durable rate-limit rows (`createDbStore` / `createSqlStore`) | PR #1225 open, stacked on #1223; bounded sweep on write; tests tightened in a stacked follow-up      |
| [460](./460-cloudflare-artifacts.md)             | Cloudflare Artifacts as an action-only `ctx.artifacts`              | A–D shipped (#926 + D deploy check); live probes remain (need Workers Paid)                          |
| [463](./463-experimental-graduation.md)          | Graduate the experimental tier to stable                            | A shipped (#1002), B1 `payment` graduated (#1001); remaining packages                                |
| [166](./166-enterprise-auth-saml-scim.md)        | Enterprise auth: SAML SSO + SCIM                                    | Phase 1a (OIDC SSO + SCIM Users) shipped; Phase 1b SAML gated                                        |
| [464](./464-replay-conflict-resolution.md)       | Replayed offline writes that conflict                               | Phase A shipped (docs + test); Phase B waits on a real app needing a merge the handler can't express |
| [468](./468-gdpr-package.md)                     | `@lunora/privacy`: data-subject rights (export, erasure, holds)     | Phase 0: codegen spike; legal and tax review open (§10)                                              |

## Open (TODO)

| Plan                                                   | Title                                                                  | Notes                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [531](./531-typed-live-topics.md)                      | Typed live topics: declared names and payloads, generated refs         | design only; waits on the live-topic hooks landing on `alpha`; open question: auto-mount |
| [530](./530-vite-startup-ts-morph-graph.md)            | Keep ts-morph out of the Vite and cloudflare config-load graph         | BLOCKED: owner picks lazy codegen (~130 files) or async `lunora()` (public API change)   |
| [466](./466-local-replica-client-wiring.md)            | Wire `@lunora/replica` into every client                               | decisions D1–D6 open; Phase 0 first                                                      |
| [467](./467-client-split-remaining-clusters.md)        | Finish splitting `lunora-client.ts`                                    | replay engine, frame handlers, admin surface; decisions D1–D3                            |
| [480](./480-scheduler-remove-id-less-complete-shim.md) | Require the job id on `/complete` so a completion frees its own slot   | blocked: needs a read-only check of production pool rows for `inFlightIds`               |
| [482](./482-ratelimit-db-store-atomic-consume.md)      | Make the ratelimit consume atomic on the D1-backed `.global()` table   | SQL and KV fixed in #1129; D1 needs a conditional write on `ctx.db` (in progress)        |
| [135](./135-stable-1.0-roadmap.md)                     | Road to stable 1.0.0                                                   | umbrella; phase/exit-criteria tracker for `alpha → main`                                 |
| [306](./306-pluggable-queue-drivers.md)                | Pluggable queue-driver package                                         | P2                                                                                       |
| [332](./332-payment-conformance-spike.md)              | Spike: what a payment-provider conformance suite asserts               | spike; deliverable is a decision                                                         |
| [490](./490-lazy-function-registry.md)                 | Lazy function registry: Worker startup CPU scales with procedure count | design + measurements only; decisions in §7 open                                         |
| [168](./168-cross-shard-transactions-spike.md)         | Cross-shard transaction story                                          | spike; decision first                                                                    |
| [078](./078-custom-scalar-types.md)                    | Custom scalar types (`v.custom`)                                       | not shipped                                                                              |
| [089](./089-promise-pipelining-batch.md)               | Promise pipelining over the batch transport                            | draft, design-only                                                                       |
| [160](./160-adapter-voice-agent-consolidation.md)      | Consolidate the voice/agent surface across the 5 adapters              | deferred                                                                                 |
| [364](./364-studio-conversational-assistant.md)        | Conversational assistant for the Studio                                | P3                                                                                       |
| [033](./033-stream.md)                                 | Cloudflare Stream (video)                                              | P3, deferred                                                                             |
| [037](./037-realtime-calls-webrtc.md)                  | Cloudflare Realtime / Calls (WebRTC)                                   | P3, deferred                                                                             |
| [133](./133-live-cdc-and-do-consumes-do.md)            | Live CDC ingest + DO-consumes-DO shape                                 | P3, demand-gated                                                                         |
| [169](./169-collab-crdt.md)                            | `@lunora/collab` (CRDT / collaborative editing)                        | demand-gated                                                                             |
| [453](./453-embedded-runtime.md)                       | In-process runtime as an embedded (browser / device) target            | phase 1 shipped; rest demand-gated                                                       |

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
| [334](./334-mutation-determinism.md)                | Runtime determinism for query/mutation bodies                           |
| [386](./386-queue-workpool-observability-design.md) | Observability for the Queues-backed workpool                            |
| [395](./395-sdk-stream-forms-design.md)             | Stream subscription forms for the non-Dart SDKs                         |
| [435](./435-platform-budget-tck-design.md)          | Portability-budget leg of the platform TCK                              |
| [445](./445-agent-approvals-inbox-design.md)        | Pending-approvals inbox for the HITL surface                            |
