# Plan 052: [Spike] Design a typed server→client streaming hook for the adapters

> **Executor instructions**: This is a DESIGN/SPIKE plan. The deliverable is a
> design document plus a minimal prototype — NOT a finished, shipped feature
> across all adapters. Follow the steps, produce the artifacts, and STOP at the
> open questions for a maintainer decision. Update this plan's status row in
> `plans/README.md` when the spike is complete.
>
> **Drift check (run first)**: `git diff --stat b51b440a..HEAD -- packages/server/src/http.ts packages/react/src/use-stream.ts packages/client/src`
> If the cited files changed, re-read them before proceeding.

## Status

- **Priority**: P2
- **Effort**: M (spike)
- **Risk**: MED
- **Depends on**: none (informs, and may precede, adapter work in plan 047)
- **Category**: direction
- **Planned at**: commit `b51b440a`, 2026-06-17

## Why this matters

The server has a first-class streaming primitive — `http.ts`'s `.stream()` builder
emits a `text/event-stream` (SSE) of JSON-encoded chunks (`packages/server/src/http.ts:141-149`,
pump at `:403`). But there is **no client hook** that consumes it with type
safety. The existing React `use-stream.ts` is the *opposite* direction
(client→server). So the natural pairing for LLM token streaming, live transcripts,
and progressive results is missing: developers must drop to raw `EventSource`,
losing the end-to-end type inference Lunora otherwise provides. This is a grounded
asymmetry (a builder with no consumer), worth a small design before building.

## Current state

- `packages/server/src/http.ts:141-149` — `.stream<R>(handler => AsyncGenerator<R>)`
  declares a streaming SSE route; `R` is the per-chunk type. The pump at `:403-428`
  serializes chunks to `text/event-stream` and wires `request.signal` for cancel.
- `packages/react/src/use-stream.ts` — exists, but is client→server (verify by
  reading it: it streams data *to* the server, not consuming an SSE endpoint).
- `@lunora/client` owns transport and type helpers (`ArgsOf`/`ReturnOf`/
  `FunctionReference`); the streaming route's `R` type needs to flow to the client
  for inference. Check how codegen represents stream routes — `grep -rn "stream" packages/codegen/src`
  (note `openrpc.ts:117` excludes `kind !== "stream"` from RPC methods, so streams
  are already a recognized function kind in codegen).
- No client method consumes an SSE Lunora stream today (`grep -rn "EventSource\|text/event-stream\|getReader" packages/client/src`).

## Scope

**In scope (spike only)**:
- A design doc: `plans/052-streaming-hook-design.md`.
- A minimal prototype: a `@lunora/client` method that opens the SSE endpoint and
  yields typed chunks, plus a React `useStream`-style consumer hook (rename to
  avoid clashing with the existing client→server `use-stream.ts` — e.g.
  `useStreamQuery` / `useEventStream`; decide in the design).
- Just enough to prove type inference (chunk type `R` flows from server to hook)
  and lifecycle (subscribe, chunks, error, done, cancel-on-unmount).

**Out of scope (defer to a build plan)**:
- Shipping the hook in Vue/Solid/Svelte (that belongs with plan 047's pattern once
  the API is settled).
- Reconnect/backoff policy (note it as an open question).
- Changing the server `.stream()` builder.

## Steps

### Step 1: Map the end-to-end stream path

Document how a `.stream()` route is: defined (server), represented in codegen, and
reachable over HTTP. Confirm the SSE wire format (event/data framing) from the pump
(`http.ts:403-428`) so the client parser matches it exactly.

**Verify**: the design doc states the exact wire format and the URL/route shape the
client must hit.

### Step 2: Prototype the client consumer

Add a minimal `@lunora/client` function that, given a stream `FunctionReference`
and args, opens the endpoint (`fetch` + `ReadableStream` reader, or `EventSource`)
and yields parsed chunks typed as the route's `R`. Prove the type flows (a test
where the chunk type is inferred, not `any`).

**Verify**: `pnpm --filter "@lunora/client" run lint:types` → exit 0; a test
asserts a typed chunk sequence from a faked SSE response.

### Step 3: Prototype the React hook

Add a consumer hook (e.g. `useEventStream(streamFn, args, { onChunk, onError, onDone })`)
over the Step-2 client function, with cancel-on-unmount via the client signal.
Keep it minimal — prove the lifecycle, don't polish.

**Verify**: a React test (faked stream) drives chunk → done and unmount → cancel.

### Step 4: Write the design doc + open questions

`plans/052-streaming-hook-design.md`: the proposed public API (names, signature,
return shape), how it differs from the existing client→server `use-stream.ts`,
codegen implications (does the generated `api` need a stream-aware reference?), and
open questions: reconnect policy, error/retry semantics, backpressure, whether
this returns an async iterable vs callbacks vs a state object, and the naming
collision resolution.

**Verify**: the doc lists a concrete proposed API and ≥3 open questions for a
maintainer.

## Done criteria

ALL must hold:

- [ ] `plans/052-streaming-hook-design.md` exists with a proposed API + open questions.
- [ ] A `@lunora/client` prototype consumes a `.stream()` SSE endpoint with typed chunks (test proves inference).
- [ ] A React prototype hook drives chunk/done/cancel (test).
- [ ] `pnpm --filter "@lunora/client" run lint:types` passes; prototype tests pass.
- [ ] No naming collision with the existing `use-stream.ts` (client→server) — the consumer hook has a distinct name.
- [ ] `git status` shows only spike/prototype + design files modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The SSE wire format from the pump can't be reliably parsed client-side without
  server changes — STOP and report; that reshapes the design.
- Type inference from the server stream route to the client requires codegen
  changes beyond a prototype's reach — STOP, document the codegen requirement in
  the design, and present it as the gating decision.
- The existing `use-stream.ts` already does server→client consumption (i.e. the
  asymmetry was misread) — STOP and report; this plan would be unnecessary.

## Maintenance notes

- The spike's output should make the build decision a yes/no for a maintainer: a
  concrete API and a short list of trade-offs.
- If approved, the build plan ports the hook to Vue/Solid/Svelte using plan 047's
  per-adapter pattern.
