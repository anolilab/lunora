# Plan 164 — Non-TypeScript client SDK

- **Category**: feat (competitive parity — gap #3 in `plans/README.md` Wave 14)
- **Priority**: P2
- **Effort**: L · **Risk**: MED
- **Status**: TODO
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: prove the Lunora wire protocol is not TypeScript-bound by shipping a
  minimal client SDK in one non-TS language (Swift **or** Python), breaking the
  single biggest capability ceiling vs Convex (which ships Swift/Kotlin/Python/Rust).

## Context (verified)

The entire client surface is TypeScript: `@lunora/client`
(`packages/client/src/lunora-client.ts`, `subscription.ts`, `http-stream.ts`)
and `@lunora/react-native` are TS. There is **no** Swift/Kotlin/Python/Dart/Go/Rust
client. This blocks native mobile (Swift/Kotlin), Python data/ML consumers, and
non-TS backends from talking to a Lunora deployment.

The wire protocol already exists and is exercised end-to-end; it is simply not
documented as a language-independent contract. Reference implementation and
framing anchors:

- Worker endpoints / RPC + WS handshake: `packages/runtime/src/create-worker.ts`.
- Live-subscription frames: `packages/client/src/subscription.ts`.
- Arg/wire encoding (bigint/Date/Map/Set/bytes): `shared/wire-key.ts`
  (`stableWireKey` / `encodeWire`).
- HTTP-SSE streaming framing: `packages/client/src/http-stream.ts`.

## Phase 0 — Formalize the wire protocol (prerequisite)

- [ ] Extract a **language-independent protocol spec** (docs) from the TS client:
      connect/auth handshake, query/mutation request+response envelopes, the
      subscribe/poke/shape frames, `encodeWire` value grammar, error-body shape,
      and the ephemeral-WS-token flow (plan 095).
- [ ] Add a protocol-conformance fixture set (golden request/response frames)
      the TS client is tested against, so any SDK can target the same fixtures.

## Phase 1 — Minimal SDK (pick one language)

Decision: **Swift** (unlock native iOS) or **Python** (unlock data/ML/backends).

- [ ] Connect + auth (accept an async token provider, mirror `WsTokenProvider`).
- [ ] `query` and `mutation` round-trips over the documented envelopes.
- [ ] One live `subscribe` consuming the poke/shape frames.
- [ ] `encodeWire` value codec for the language.
- [ ] Run against the Phase-0 conformance fixtures + a real workerd deployment.

## Phase 2 — Parity follow-ups (separate, demand-gated)

- [ ] Optimistic updates / offline queue (only if the target platform needs it).
- [ ] Codegen: emit typed bindings for the language from `schema.ts`.

## Exit criteria

- [ ] Protocol spec + conformance fixtures published; TS client tested against them.
- [ ] One non-TS SDK does query/mutation/subscribe against a live deployment.
- [ ] Docs page + example app for the new SDK.

## Non-goals

- Full optimistic/offline parity with `@lunora/client` in v1.
- More than one language in this plan — prove the model once, then templatize.
