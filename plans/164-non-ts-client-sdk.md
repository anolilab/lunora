# Plan 164 — Non-TypeScript client SDK

- **Category**: feat (competitive parity — gap #3 in `plans/README.md` Wave 14)
- **Priority**: P2
- **Effort**: L · **Risk**: MED
- **Status**: DONE (Phase 0 + Phase 1 shipped; Phase 2 parity follow-ups open)
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

- [x] Extract a **language-independent protocol spec** (docs) from the TS client:
      connect/auth handshake, query/mutation request+response envelopes, the
      subscribe/poke/shape frames, `encodeWire` value grammar, error-body shape,
      and the ephemeral-WS-token flow (plan 095). → `protocol/README.md`.
- [x] Add a protocol-conformance fixture set (golden request/response frames)
      the TS client is tested against, so any SDK can target the same fixtures.
      → `protocol/fixtures/*.json`; TS test
      `packages/client/__tests__/protocol-conformance.test.ts`.

## Phase 1 — Minimal SDK (pick one language)

Decision: **Python** (broadest reach; standard-library-only core; easiest to test
in CI without a native toolchain). → `sdks/python/`.

- [x] Connect + auth (accept an async token provider, mirror `WsTokenProvider`).
      → `LunoraClient(ws_token=…)` + `resolve_ws_token()`.
- [x] `query` and `mutation` round-trips over the documented envelopes.
- [x] One live `subscribe` consuming the data/delta frames, plus
      `subscribe_shape` consuming the poke frames.
- [x] `encode_wire` / `decode_wire` value codec for Python (`lunora/wire.py`).
- [x] Run against the Phase-0 conformance fixtures (`tests/test_conformance.py`,
      26 tests). A live workerd run is scripted in `examples/quickstart.py`
      (point `LUNORA_URL` at a running `lunora dev`).

## Phase 2 — Parity follow-ups (separate, demand-gated)

- [ ] Optimistic updates / offline queue (only if the target platform needs it).
      Scaffolded as a follow-up — the Python SDK ships the live-read + write path
      only; the optimistic/outbox machinery stays in `@lunora/client` for v1.
- [ ] Codegen: emit typed bindings for the language from `schema.ts`.
      Follow-up — the SDK is string-path/`dict`-typed today.

## Exit criteria

- [x] Protocol spec + conformance fixtures published; TS client tested against them.
- [x] One non-TS SDK does query/mutation/subscribe over the documented protocol
      (fixture-conformant; live deployment via `examples/quickstart.py`).
- [x] Docs page + example app for the new SDK
      (`apps/docs/src/content/docs/concepts/wire-protocol.mdx`,
      `sdks/python/examples/quickstart.py`).

## Non-goals

- Full optimistic/offline parity with `@lunora/client` in v1.
- More than one language in this plan — prove the model once, then templatize.
