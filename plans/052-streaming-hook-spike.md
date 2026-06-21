# Plan 052: [Spike] Typed HTTP-SSE stream consumer for `httpRoute.<verb>().stream()`

> **Executor instructions**: This is a DESIGN/SPIKE plan. The deliverable is a
> design document plus a minimal prototype — NOT a finished, shipped feature
> across all adapters. Follow the steps, produce the artifacts, and STOP at the
> open questions for a maintainer decision. Update this plan's status row in
> `plans/README.md` when the spike is complete.
>
> **Drift check (run first)**: `git diff --stat b51b440a..HEAD -- packages/server/src/http.ts packages/client/src/stream.ts packages/react/src/use-stream.ts packages/codegen/src`
> If the cited files changed, re-read them before proceeding.

## Status

- **Priority**: P2
- **Effort**: M (spike)
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `b51b440a`, 2026-06-17 · **Rewritten**: 2026-06-20

## Why this matters — and why the original premise was wrong

The original 052 proposed building a "server→client streaming hook" on the
assumption that the React `use-stream.ts` was the _opposite_ direction
(client→server). **That was a misread.** Verified in code:

- `packages/client/src/stream.ts` and `packages/react/src/use-stream.ts` already
  implement a **server→client** consumer — the server pushes one `chunk` message
  per yielded value and the client iterates `for await (const chunk of stream)`.
  This is the **WS-transport procedure stream** (`kind: "stream"`, `ir.ts:144`):
  a `query`/`action` whose handler returns an `AsyncIterable<T>`. **Fully covered.**

So the WS path is _not_ the gap. The genuine, grounded asymmetry is a **different**
streaming primitive:

- `packages/server/src/http.ts:149` — `httpRoute.<verb>(path).stream<R>(handler)`
  declares an **HTTP Server-Sent Events** route. The pump (`http.ts:391-502`)
  serializes each yielded chunk to a `data: <json>\n\n` SSE frame, writes a final
  `event: complete` frame on iterator completion, and an `event: error` frame with
  `{code, message}` on throw. Cancel is wired through `request.signal`.
- Codegen already _recognizes_ these routes — `HttpRouteIR.stream: boolean`
  (`packages/codegen/src/ir.ts:567-568`), discovered in
  `discover-http-routes.ts` (`TERMINAL_STEPS` includes `"stream"`). But the emitter
  produces **no typed client reference** for a streaming HTTP route, and
  `@lunora/client` has **no SSE/`fetch`+`ReadableStream` consumer** (verified:
  `grep -rn "EventSource\|text/event-stream\|getReader" packages/client/src` → none).

The result: a developer declaring `httpRoute.get("/tokens").stream<Token>(…)` for
LLM token streaming or progressive results must drop to a raw `EventSource` /
`fetch` reader in the browser, losing the end-to-end type inference (`R` flows from
server to client) that Lunora otherwise guarantees. This spike designs the typed
consumer for that HTTP-SSE path.

## Current state

- **Server (the producer, do not change)** — `packages/server/src/http.ts`:
    - `:149` `stream: <R>(handler) => LunoraRouteHandler` — terminal builder step.
    - `:391-398` `sseFrame(event, data)` — frame format: `event:` prefix omitted for
      the default `data` event; `data: ${json}\n\n` (double-newline terminator).
    - `:403-502` the pump: `content-type: text/event-stream; charset=utf-8`, a final
      `event: complete` frame, an `event: error` frame carrying `{code, message}` on
      throw, and `request.signal` → handler cancel.
- **Codegen** — `HttpRouteIR` (`ir.ts:550-568`) carries `method`, `path`, the args
  validator, and `stream: boolean`. `discover-http-routes.ts` captures it. The
  **emitter (`emit.ts`) does not currently emit a typed reference for HTTP routes**
  (confirm by reading the httpRoute-related emit paths — the `stream` references in
  `emit.ts:808-2696` are about the _WS procedure_ `kind:"stream"`, NOT httpRoutes).
- **Client (the gap)** — `@lunora/client` owns transport + the `ArgsOf`/`ReturnOf`/
  `FunctionReference` type helpers. `client/src/stream.ts` is the **WS** stream queue
  (no `fetch`/`EventSource`). There is no HTTP-SSE consumer.
- **React** — `use-stream.ts` consumes the **WS** procedure stream. A new HTTP-SSE
  hook must have a **distinct name** to avoid collision (e.g. `useHttpStream` /
  `useEventStream` — decide in the design).

## Scope

**In scope (spike only)**:

- A design doc: `plans/052-streaming-hook-design.md`.
- A minimal prototype `@lunora/client` consumer that, given the path + args of a
  streaming HTTP route, opens the endpoint with `fetch` + `ReadableStream`
  `getReader()`, parses the SSE framing (`data:` chunks, `event: complete`,
  `event: error`) exactly as the pump writes it, and yields typed chunks `R`.
- A React consumer hook over that client function (distinct name from `use-stream.ts`),
  proving the lifecycle: chunks → done, `event: error` → error, unmount → cancel
  (via `AbortController` → `request.signal`).
- Just enough codegen investigation to answer: _can `R` flow to the client from
  `HttpRouteIR` today, or does the emitter need a new `HttpStreamRef`?_ — document
  the answer; build the emit only if it's within prototype reach.

**Out of scope (defer to a build plan)**:

- Shipping the hook in Vue/Solid/Svelte (belongs with plan 047's per-adapter pattern
  once the API is settled).
- Reconnect/backoff policy (note as an open question).
- Changing the server `.stream()` builder or the pump.
- The WS procedure-stream path (`use-stream.ts`) — already done, untouched.

## Steps

### Step 1: Map the end-to-end HTTP-SSE path

Document how a `httpRoute.<verb>(path).stream<R>()` route is: defined (server),
captured in codegen (`HttpRouteIR.stream`), and reached over HTTP. Transcribe the
**exact** SSE wire format from the pump (`http.ts:391-502`) so the client parser
matches byte-for-byte: default-event `data:` frames, the `event: complete`
terminator, the `event: error` `{code, message}` frame, and the `\n\n` separator.

**Verify**: the design doc states the exact wire format, the URL/route shape the
client must hit (HTTP verb + path, how args map to query/body), and whether codegen
emits a reference for HTTP routes today.

### Step 2: Prototype the client consumer

Add a minimal `@lunora/client` function (e.g. `httpStream(route, args, { signal })`)
that opens the endpoint via `fetch` and reads `response.body!.getReader()`, decoding
SSE frames and yielding parsed chunks typed as the route's `R`. Handle the three
frame kinds (chunk / complete / error) and surface a structured error on `event: error`.
Prove the type flows (a test where the chunk type is inferred, not `any`).

**Verify**: `pnpm --filter "@lunora/client" run lint:types` → exit 0; a test asserts
a typed chunk sequence + a terminal error frame from a faked SSE `ReadableStream`.

### Step 3: Prototype the React hook

Add a consumer hook (distinct name — e.g. `useHttpStream(route, args, { onChunk,
onError, onDone })`) over the Step-2 function, cancelling on unmount via an
`AbortController` whose signal reaches the fetch (→ server `request.signal`).
Minimal — prove the lifecycle, don't polish.

**Verify**: a React test (faked stream) drives chunk → done and unmount → abort.

### Step 4: Write the design doc + open questions

`plans/052-streaming-hook-design.md`: the proposed public API (names, signature,
return shape — async-iterable vs callbacks vs state object), how it differs from the
existing WS `use-stream.ts`, the codegen decision (does the generated `api` need a
stream-aware `HttpStreamRef`, or can callers pass a path + validator?), and open
questions: reconnect policy, error/retry semantics, backpressure, and the naming
collision resolution.

**Verify**: the doc lists a concrete proposed API and ≥3 open questions for a
maintainer.

## Done criteria

ALL must hold:

- [ ] `plans/052-streaming-hook-design.md` exists with a proposed API + open questions.
- [ ] A `@lunora/client` prototype consumes a `httpRoute.<verb>().stream()` SSE endpoint with typed chunks (test proves inference + the `event: error` frame).
- [ ] A React prototype hook drives chunk/done/cancel (test).
- [ ] `pnpm --filter "@lunora/client" run lint:types` passes; prototype tests pass.
- [ ] No naming collision with the existing WS `use-stream.ts` — the HTTP consumer hook has a distinct name.
- [ ] The codegen question (emit `HttpStreamRef` vs caller-supplied path) is answered in the design.
- [ ] `git status` shows only spike/prototype + design files modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The SSE wire format from the pump can't be reliably parsed client-side without
  server changes — STOP and report; that reshapes the design.
- Type inference from `HttpRouteIR` to the client requires emitter changes beyond a
  prototype's reach — STOP, document the codegen requirement in the design, and
  present it as the gating decision.
- It turns out an HTTP-SSE consumer _already_ exists (the asymmetry was re-misread) —
  STOP and report; this plan would be unnecessary.

## Maintenance notes

- The spike's output should make the build decision a yes/no for a maintainer: a
  concrete API and a short list of trade-offs.
- If approved, the build plan ports the hook to Vue/Solid/Svelte using plan 047's
  per-adapter pattern, and (if chosen) wires the `HttpStreamRef` codegen emit.
- Keep the two stream primitives clearly named end-to-end: **WS procedure stream**
  (`kind:"stream"`, `use-stream.ts`) vs **HTTP-SSE route stream**
  (`httpRoute.…stream()`, this plan's new hook).
