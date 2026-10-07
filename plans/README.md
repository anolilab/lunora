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

| Plan                                         | Title                                                  | Remaining                                                                   |
| -------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| [456](./456-modules-catalog-architecture.md) | Modules catalog, call graph, architecture diagram      | core and per-module queues shipped; optional: nested `api.*`, deploy diff   |
| [460](./460-cloudflare-artifacts.md)         | Cloudflare Artifacts as an action-only `ctx.artifacts` | A–D shipped (#926 + D deploy check); live probes remain (need Workers Paid) |
| [463](./463-experimental-graduation.md)      | Graduate the experimental tier to stable               | A shipped (#1002), B1 `payment` graduated (#1001); remaining packages       |
| [166](./166-enterprise-auth-saml-scim.md)    | Enterprise auth: SAML SSO + SCIM                       | Phase 1a (OIDC SSO + SCIM Users) shipped; Phase 1b SAML gated               |

## Open (TODO)

| Plan                                              | Title                                                       | Notes                                                    |
| ------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| [135](./135-stable-1.0-roadmap.md)                | Road to stable 1.0.0                                        | umbrella; phase/exit-criteria tracker for `alpha → main` |
| [306](./306-pluggable-queue-drivers.md)           | Pluggable queue-driver package                              | P2                                                       |
| [453](./453-embedded-runtime.md)                  | In-process runtime as an embedded (browser / device) target | design ratified, not started                             |
| [332](./332-payment-conformance-spike.md)         | Spike: what a payment-provider conformance suite asserts    | spike; deliverable is a decision                         |
| [168](./168-cross-shard-transactions-spike.md)    | Cross-shard transaction story                               | spike; decision first                                    |
| [078](./078-custom-scalar-types.md)               | Custom scalar types (`v.custom`)                            | not shipped                                              |
| [089](./089-promise-pipelining-batch.md)          | Promise pipelining over the batch transport                 | draft, design-only                                       |
| [160](./160-adapter-voice-agent-consolidation.md) | Consolidate the voice/agent surface across the 5 adapters   | deferred                                                 |
| [364](./364-studio-conversational-assistant.md)   | Conversational assistant for the Studio                     | P3                                                       |
| [033](./033-stream.md)                            | Cloudflare Stream (video)                                   | P3, deferred                                             |
| [037](./037-realtime-calls-webrtc.md)             | Cloudflare Realtime / Calls (WebRTC)                        | P3, deferred                                             |
| [133](./133-live-cdc-and-do-consumes-do.md)       | Live CDC ingest + DO-consumes-DO shape                      | P3, demand-gated                                         |
| [169](./169-collab-crdt.md)                       | `@lunora/collab` (CRDT / collaborative editing)             | demand-gated                                             |

## Reference designs

Design docs and spike findings that gate unbuilt follow-on work. Delete one when the
follow-on ships or is rejected.

| Doc                                                                                    | Subject                                                                 |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [052](./052-streaming-hook-design.md)                                                  | Typed HTTP-SSE stream consumer (adapter parity, reconnect, POST bodies) |
| [137](./137-release-train-rehearsal.md)                                                | Release-train rehearsal, feeds 135 Phase 3                              |
| [162](./162-phase0-crosstabsync-design.md)                                             | crossTabSync subscribe relay (CLIENT-01)                                |
| [234](./234-node-host-findings.md)                                                     | Node host findings                                                      |
| [237](./237-admin-auth-hooks-design.md)                                                | Reactive admin/organization auth hooks; remaining adapters open         |
| [238](./238-vector-reader-design.md)                                                   | `.withVectorIndex()` reader; codegen wiring + `define-rag` open         |
| [241](./241-inapp-inbox-design.md)                                                     | In-app inbox read half; D1 backend open                                 |
| [247](./247-event-store-design.md)                                                     | `defineEventStore`; not ratified                                        |
| [333](./333-query-snapshot-coherence.md)                                               | Snapshot coherence for query subscriptions                              |
| [334](./334-mutation-determinism.md)                                                   | Runtime determinism for query/mutation bodies                           |
| [386](./386-queue-workpool-observability-design.md)                                    | Observability for the Queues-backed workpool                            |
| [395](./395-sdk-stream-forms-design.md)                                                | Stream subscription forms for the non-Dart SDKs                         |
| [435](./435-platform-budget-tck-design.md)                                             | Portability-budget leg of the platform TCK                              |
| [445](./445-agent-approvals-inbox-design.md)                                           | Pending-approvals inbox for the HITL surface                            |
| [convex-primitives-gap-analysis.md](./convex-primitives-gap-analysis.md)               | What Convex's "missing primitives" mean for Lunora                      |
| [multi-platform-portability-assessment.md](./multi-platform-portability-assessment.md) | Multi-platform portability go/no-go                                     |
| [audit-findings.md](./audit-findings.md)                                               | Bug-hunt ledger (rounds 5–11)                                           |
