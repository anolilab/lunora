# Plan 052 — Typed HTTP-SSE stream consumer: design & decisions

> Companion to (and closing artifact of) `plans/052-streaming-hook-spike.md`.
> The spike was executed as a full React-first build: the codegen emit, the
> `@lunora/client` consumer, and the React hook shipped together with tests.
> This doc records the shipped API, the codegen decision the spike was asked to
> answer, and the open questions a maintainer should settle before the
> follow-up build (other framework adapters, reconnect policy).

## The two stream primitives (naming, end-to-end)

| Primitive                 | Declared by                              | Transport                    | Client consumer                    | Hook            |
| ------------------------- | ---------------------------------------- | ---------------------------- | ---------------------------------- | --------------- |
| **WS procedure stream**   | `query`/`action` returning AsyncIterable | WebSocket (`kind: "stream"`) | `client.stream(api.…)`             | `useStream`     |
| **HTTP-SSE route stream** | `httpRoute.<verb>(path).stream<R>()`     | HTTP `text/event-stream`     | `client.httpStream(httpStreams.…)` | `useHttpStream` |

## Wire format (transcribed from `packages/server/src/http.ts` `buildStreamHandler`/`sseFrame`)

- Chunk: `data: <JSON.stringify(chunk)>\n\n` — default event, no `event:` line;
  the JSON never contains a raw newline, so one `data:` line per frame.
- Completion: `event: complete\ndata: {}\n\n`, then the body closes.
- Error: `event: error\ndata: {"code":"…","message":"…"}\n\n` (redacted through
  `toErrorBody`; internal errors surface as `INTERNAL_SERVER_ERROR`/"Internal error"),
  then the body closes.
- Headers: `content-type: text/event-stream; charset=utf-8`,
  `cache-control: no-cache, no-transform`, `x-accel-buffering: no`.
- Cancel: client aborts the fetch → workerd cancels the response
  `ReadableStream` → the pump aborts its `AbortController` → the handler's
  `signal` fires.
- URL shape: the route's own verb + path (`:name` hono params in the path,
  `.searchParams()` in the query string). Streams have no parsed body.

## Codegen decision (the spike's gating question)

**`R` could NOT flow to the client from `HttpRouteIR` as it stood** — the IR
carried `stream: boolean` but no chunk type, and the emitter produced no
reference for HTTP routes at all. The emit was within reach, so it was built:

- `HttpRouteIR.chunkType?: string` — rendered TS type of the handler's yielded
  `R`, captured in `discover-http-routes.ts` by reusing function discovery's
  `unwrapHandlerReturn` on the `.stream(handler)` argument (unwraps
  `AsyncGenerator<R,…>`/`AsyncIterable<R>`, falls back to `"unknown"` on a
  degraded checker or a non-inline handler).
- `_generated/api.ts` gains (only when a project declares a `.stream()` route):

    ```ts
    import type { FunctionReference, HttpStreamRef } from "@lunora/client"; // or lunorash/client

    export interface HttpStreamsRef {
        http: {
            streamTokens: HttpStreamRef<{ text: string }, { prompt: string }, {}>;
        };
    }

    export const httpStreams: HttpStreamsRef = {
        http: {
            streamTokens: { method: "GET", path: "/api/tokens" },
        },
    };
    ```

    `HttpStreamRef<Chunk, SearchParams, Params>` lives in `@lunora/client` (like
    `FunctionReference`); the runtime value carries only `{ method, path }` —
    unlike `api.*` it is a real object, not the `anyApi` proxy, because the
    consumer needs the verb + path, not a `__lunoraRef`.

## Shipped public API

### `@lunora/client`

```ts
httpStream(route, args?, options?): StreamIterable<Chunk>          // standalone
client.httpStream(route, args?, options?): StreamIterable<Chunk>   // bound: baseUrl = client.url, fetch = client's fetch, bearer token attached
```

- `args`: `{ params?, searchParams? }` (typed from the ref's phantom); `:name`
  path segments are filled from `params` (percent-encoded), `searchParams`
  append to the query string (`undefined` entries skipped).
- `options`: `baseUrl`, `fetch`, `headers`, `maxBuffer`, `signal`.
- Returns the same `StreamIterable` shape as the WS stream (`for await` +
  `.cancel()`), backed by the same bounded `createStream` queue — identical
  backpressure (`STREAM_BACKPRESSURE`) and termination semantics.
- Coded failures (`LunoraError`): server `event: error` code passthrough,
  `HTTP_STREAM_STATUS` (non-2xx, carries `status`), `HTTP_STREAM_NO_BODY`,
  `HTTP_STREAM_BAD_CHUNK` (non-JSON data), `HTTP_STREAM_INTERRUPTED` (EOF
  without a terminal frame), `HTTP_STREAM_TRANSPORT` (fetch/network throw),
  `HTTP_STREAM_MISSING_PARAM` (thrown synchronously — caller bug).
- Cancel/abort (consumer `.cancel()`, external `signal`, unmount) ends the
  iterator cleanly (`done`), never as an error.

### `@lunora/react`

```ts
const { chunks, status, error, cancel } = useHttpStream(httpStreams.http.tokens, { searchParams: { prompt } });
```

Mirrors `useStream`'s state machine (`idle → streaming → complete | error`),
`"skip"` sentinel, reset-on-args-change, and unmount → abort (→ server
`request.signal`). Distinct name resolves the collision with the WS hook.

## Open questions for a maintainer (before the follow-up build)

1. **Reconnect/backoff**: `httpStream` is one-shot — a dropped connection
   surfaces `HTTP_STREAM_INTERRUPTED` and the caller re-opens. Should the
   client auto-reconnect (SSE `Last-Event-ID` style resume would also need the
   server pump to emit `id:` fields — a server change the spike scoped out)?
2. **Adapter parity**: port `useHttpStream` to Vue/Solid/Svelte via plan 047's
   per-adapter pattern (the client consumer is already framework-neutral).
3. **POST bodies**: the server `.stream()` builder exposes the raw `request`
   but decodes no body; if streaming POST routes become a real use case the
   consumer needs a `body` option (and the builder a `.body()` that decodes).
4. **OpenAPI**: `openapi.ts` renders stream routes like plain routes; should
   they be marked (`text/event-stream` content type) in the spec?
5. **Wire fidelity**: SSE chunks ride plain `JSON.stringify` (the server pump's
   format) — `bigint`/bytes in a chunk will throw server-side, unlike the WS
   path's wire codec. Acceptable, or should the pump adopt `encodeWire`?
