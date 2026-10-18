# Plan 531 — Typed live topics: declared topic names and payloads, generated refs, typed publish and subscribe

**Baseline:** `5eba0f6a6` (2026-10-18), the live-topic hook work on top of `origin/alpha` (`eafd564ad`). That work (`subscribeLiveTopic` and the five adapter bindings) must land first; this plan builds on it.
**Status:** TODO

## 0. Headline finding

Live topic streams are the one realtime surface where the "types inferred end to end" promise stops. A topic is a free-form string and a payload is `unknown`, on both sides:

- `ctx.live.publish(topic: string, payload: unknown, { stream: string })` — a typo in `stream` publishes to nobody and nothing says so.
- `useLiveTopic({ url: "/live/posts/connect", topic: "post:1" })` — the client hand-writes the route path and the topic, and receives `unknown`.
- `onSubscribe({ topic })` — authorization is written as `topic.split(":")` over an attacker-controlled string. That is where an authorization bug is most likely to be written.
- The two route handlers are mounted by hand, so a stream declared but never mounted fails only when a browser connects.

Queries, mutations and actions have none of these problems because codegen emits `api.*`. This plan gives topics the same treatment.

## 1. Current state (audit)

- `defineLiveStream({ id, onSubscribe?, allowAnonymousControl? })` (`packages/server/src/live-stream.ts:169`) knows its `id` and nothing about its topics. Paths are `/live/<id>/connect` and `/live/<id>/control` (`:170-171`).
- Publish is `ctx.live.publish(topic, payload, { stream, shardKey? })`; `stream` is required since #1218 and is an unchecked string.
- The client core is string-based: `subscribeLiveTopic({ url, topic, onEvent, … })` (`packages/client/src/live-topic.ts`), wrapped by `useLiveTopic` (React, Vue), `createLiveTopic` (Solid), `liveTopic` (Svelte, Angular). None of them calls `useLunora()`, so none needs a provider.
- Codegen detects `ctx.live` reads (`packages/codegen/src/discover/platform-signals.ts:24`, `:329`) and gates emission on `liveStreams` (`emit/shard.ts:97`, `emit/app-worker-options.ts:436`) and on the platform matrix (`platform-target.ts:457-499`). It does **not** discover `defineLiveStream` declarations.
- The precedent for literal-only discovery is `defineWebSocket`: `socketRouteOf` (`packages/codegen/src/discover/functions/index.ts:69-130`) reads a literal `path` and `auth` and throws a named `LunoraError` otherwise. `defineWebSocket` is typed on the server (a `v` validator for `message`) but not on the client, which opens `client.connectWebSocket("/chat")` by path. Typed client topics would go further than that precedent.

## 2. Existing seams (do not reinvent)

- **Literal discovery:** `socketRouteOf` and `classify-procedure-call.ts` (the `defineWebSocket: "socket"` lifecycle entry). A `defineLiveStream` registration is classified the same way.
- **Validators:** `v.*` from `@lunora/values`, with `Infer`/`parseValidatorMap` as `socket.ts` uses them. No second schema language.
- **Generated references:** `_generated/api.ts` already emits plain `{ __lunoraRef: "…" }` objects so client bundles carry no server code. A topic ref follows the same shape.
- **The relay and SSE frames, the subscription registry, `LIVE_CONTROL_PATH`:** unchanged. This plan changes how topic strings are produced and checked, not how they travel.
- **`adapter-export-parity.test.ts`:** the adapters change together, in one phase.

## 3. The behavioural contract to preserve

A test can assert each of these:

- The SSE frame format and the `{"type":"live","stream":…,"topic":…,"data":…}` relay frame are byte-identical.
- At most 64 topics per connection and 1024 connections per shard.
- Default-deny: no `onSubscribe` denies everything except `allowAnonymousControl` for anonymous callers. Only a literal `true` allows. A throw denies.
- A subscription belongs to the stream that authorized it; a publish reaches only that stream's subscribers.
- Publish is not reachable from the browser `control` route.
- Codegen refuses an app that declares a live stream and also calls `.deliveryAuthorization(...)`.
- The platform ratings for `liveStreams` do not change.
- Delivery stays shard-local. Cross-DO fan-out is not part of this plan.

## 4. Design decisions

**D1. Topics are declared on the stream, as a map.**

```ts
export const posts = defineLiveStream({
    id: "posts",
    topics: {
        post: { key: { postId: v.id("posts") }, payload: v.object({ event: v.literal("comment_added"), commentId: v.id("comments") }) },
        feed: { payload: v.object({ postId: v.id("posts") }) }, // no key: the topic is just "feed"
    },
    onSubscribe: async ({ ctx, topic, key }) => topic === "post" && (await ctx.runQuery(api.posts.canRead, { postId: key.postId })),
});
```

Rejected: template strings (`"post:{postId}"`) — they need a grammar and an escaping story for a feature whose whole risk is string parsing. Rejected: one `defineTopic` per topic — it separates a topic from the stream whose `onSubscribe` authorizes it, and the stream scoping is the security boundary. Rejected: a type-only generic on `defineLiveStream` — nothing for codegen to read and no runtime check.

**D2. The wire topic is an injective encoding of the declared name and key.** `name` for a keyless topic, otherwise `name:<seg>:<seg>…`, each key segment percent-encoded (including `:`), in declaration order. The server parses a subscribe's raw topic back into `(name, key)` **before** `onSubscribe` runs and denies anything that is not a declared name with the declared arity and validating segments. Why this is the security-critical decision: if a key value could contain the delimiter, two declarations (or one declaration and a crafted string) could parse the same wire string, and an `onSubscribe` that authorized `post:1` would also admit `post:1:x`. Two further rules. A declared topic name that would encode into a reserved prefix (`room:`, `__lunora_socket__:`) is rejected by `defineLiveStream` and by codegen, since publish refuses those prefixes with `FORBIDDEN_TOPIC` and the failure would otherwise appear only at runtime. The 256-character topic limit applies to the encoded string, which percent-encoding makes longer than the raw key, so the key validators should carry a length bound. Required tests: a key containing `:` round-trips and cannot alias another topic; a wrong-arity string is denied; an undeclared name is denied without calling `onSubscribe`.

**D3. Codegen emits `_generated/live.ts`, a client-safe ref module.** `live.posts.post({ postId })` returns `{ __lunoraLive: "posts", topic: "post:<encoded>" }` typed with the payload. It exists for the same reason `api.ts` does: importing the stream value into client code would pull `httpAction`, the validators and the server graph into the browser bundle. Types come from `import type` of the declaration plus inference. Codegen reads the literal stream `id`, the literal topic names, **and each topic's literal `key` field names in declared order**, because the generated encoder must turn `{ postId }` into `post:<seg>` in the declaration's order, not in the order of the caller's object. A non-literal `id`, a spread or computed `topics` map, or a spread or computed `key` map throws a named `LunoraError` (`LIVE_STREAM_NOT_LITERAL`), as `SOCKET_PATH_NOT_LITERAL` does.

**D4. Publish and subscribe take the ref; the string forms go.** `ctx.live.publish(live.posts.post({ postId }), payload)` — the stream id comes from the ref, so the `stream` option and its typo class disappear. `useLiveTopic(live.posts.post({ postId }), { onEvent })` replaces `{ url, topic }` in the five adapters. `AGENTS.md` says to delete the old path on `alpha`, so there is no dual form and no deprecated alias. Rejected: keeping the string form as an escape hatch for dynamic topics — dynamic topics are keyed topics (`post:<any id>`), so the escape hatch would only be a way around D2. Break noted in the commit body so semantic-release records it. `subscribeLiveTopic` in `@lunora/client` stays string-based: it is the transport layer the typed adapters call, not a second public path.

**D5. The base URL comes from the client.** A ref carries a path. The adapters resolve it against `LunoraClient`'s URL, so they start reading the client from context (`useLunora()` and its siblings) where they do not today. Consequence to document: Nuxt SSR already provides the client for every other composable, so this adds no new requirement there. Rejected: embedding an absolute URL in the ref — codegen does not know the deployment origin, and `lunora dev` changes ports.

**D6. Publish validates the payload against the declared validator.** One parse per publish; a bad payload throws `BAD_REQUEST` to the publisher. Rejected: types only — the publisher that drifts is usually a queue consumer parsing an untyped message body, which is exactly where compile-time types do not reach. Subscribers do not re-validate; the server is the trusted side.

**D7. `onSubscribe` receives the parsed topic.** `{ ctx, topic, key, raw }`, with `topic` and `key` narrowed by declaration. Default-deny, the literal-`true` verdict and throw-denies are unchanged.

**D8. Out of scope, stated so it is not re-litigated:** typing `defineWebSocket`, `defineRoom` or whispers on the client; publishing from a mutation (a mutation can already `ctx.scheduler.runAfter(0, internal.x.publish, …)`, which is buffered until the commit); cross-DO fan-out.

## 5. Workstreams

| #   | Work                                                                                                                                                                           | Size |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| A   | `defineLiveStream({ topics })`: declaration types, the injective encode/parse (D2), publish validation (D6), parsed `onSubscribe` (D7), in `@lunora/server`. Runtime only.     | M    |
| B   | Codegen: discover literal stream id and topic names, `LIVE_STREAM_NOT_LITERAL`, emit `_generated/live.ts`, type `ctx.live.publish` on HTTP, action and queue contexts (D3/D4). | L    |
| C   | `@lunora/client` ref type and `subscribeLiveTopic` ref overload; the five adapters take a ref and read the client for the base URL (D4/D5); parity manifest updated in step.   | M    |
| D   | Docs and skills: rewrite `concepts/live-streams.mdx` for the typed form, update the `lunora-realtime` skill and the decision guide.                                            | S    |
| E   | (Optional, separate decision) Codegen auto-mounts `connect` and `control`, removing the manual `app.get` / `app.post` and the declared-but-unmounted failure.                  | M    |

## 6. Platform parity

A typed `ctx.live` changes a `ctx.*` surface, so the mapping is stated. It is a typing change over an existing capability: no new host contract, and nothing reaches past `ShardHost` / `SocketHost`.

| Feature                     | `cloudflare` | `celld` | `node`   | Notes                                                                                            |
| --------------------------- | ------------ | ------- | -------- | ------------------------------------------------------------------------------------------------ |
| `ctx.live` (typed publish)  | native       | native  | emulated | Ratings are the existing `liveStreams` entries; unchanged. Codegen still omits it when withheld. |
| `_generated/live.ts` (refs) | native       | native  | native   | Client-side module with no runtime host dependency.                                              |

## 7. Phasing & ordering

| Phase | Work                                                | Gate                                                                                                                                                              |
| ----- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Hook work (`subscribeLiveTopic` + 5 adapters) lands | Merged to `alpha`; `adapter-export-parity.test.ts` green.                                                                                                         |
| 1     | A                                                   | Tests for D2 (alias, arity, undeclared-name-denied-without-calling-`onSubscribe`), D6 (bad payload rejected), D7. The existing live-stream suites pass unchanged. |
| 2     | B                                                   | Codegen golden for `live.ts`; a `LIVE_STREAM_NOT_LITERAL` case; the `.deliveryAuthorization` refusal and `liveStreamsWithheld` tests still pass.                  |
| 3     | C                                                   | Parity test green for all five adapters in the same change; `api:check` after a fresh build; a type-level test that a wrong payload or key does not compile.      |
| 4     | D                                                   | Docs build; the skill mirror check (`scripts/check-skill-mirrors.js`) passes.                                                                                     |
| 5     | E, if chosen                                        | A stream declared but never mounted is served after codegen alone.                                                                                                |

Open questions: (1) E, auto-mount, or leave mounting manual — recommended yes, since codegen must discover the stream anyway; (2) whether a keyless, payload-less topic ("something changed") needs `payload` to be optional or `v.null()`.
