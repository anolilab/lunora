# Plan 090 — [Design] Wire-serializable types in cache-keyed args (subscription / useQuery / shape)

> **Status (branch `feat/capnweb-wire-fidelity`): DRAFT / design-only — not implemented.**
> The last known gap from the Cap'n Web wire-fidelity work. Deferred from a session
> sweep **on purpose**: it's a cross-cutting change on the reactive hot path where a
> mistake means _silently wrong live-query data_ (the worst bug class), so it needs a
> dedicated pass with workerd e2e verification, not a session-end edit. Anchor at HEAD
> of `feat/capnweb-wire-fidelity`; re-verify line refs.

## 0. The gap

Args and results round-trip `bigint` / bytes / `Date` / `Map` / `Set` / `URL` /
`Error` losslessly across RPC, streams, whispers, and batches. **But an arg that
doubles as a reactive cache key can't** — a subscription / `useQuery` / shape arg
feeds `stableStringify`, which now (correctly) **fails loud** on those types rather
than throwing cryptically (`bigint`) or silently colliding to `{}` (`Date`/bytes,
the old data-corruption bug). So today:

```ts
client.subscribe(api.messages.list, { since: 123n }, cb); // ← throws: "cannot use a bigint in a cache key"
```

The developer gets a clear, actionable error ("pass it as a string") — a papercut
with a workaround, not a silent failure. This plan removes the papercut.

## 1. Why it's deferred, not trivial

Two independent problems, both must be fixed for the feature to work end-to-end:

1. **The WS wire.** `sendSubscribeIfOpen` / `sendShapeSubscribeIfOpen` send `args`
   raw, so `JSON.stringify(frame)` throws on a `bigint` and silently drops bytes to
   `{}`. Fix mirrors the proven stream-args path (`encodeWire` on send, `decodeWire`
   on the DO).
2. **The cache key.** `stableStringify(args)` can't stably encode these types. Fix:
   key on the **encoded** form — `stableStringify(encodeWire(args))`. Because
   `encodeWire` is identity for pure JSON, every existing key is byte-identical (no
   cache invalidation), and `bigint`/bytes/`Date` become distinct stable tokens;
   `RegExp`/etc. still fail loud (via `encodeWire`'s prototype guard).

The risk is **breadth + the reactive hot path**, not the individual change.

## 2. Sites to change (traced at HEAD)

**Key computation → `stableStringify(encodeWire(args))`** (identity for pure JSON):

- `packages/client/src/subscription.ts` — `SubscriptionRegistry.key`.
- `packages/client/src/lunora-client.ts` — `subscribe()` `argsKey` (~L2265) + the
  query hydrated-cache key (~L2242); the `createLocalStore(...)` injected stringify
  (~L2931) **must** match `SubscriptionRegistry.key` (same dedup namespace).
- `packages/client/src/query-cache.ts` — `queryCacheKey`.
- `packages/react/src/query-key.ts` — the hook key encoder (feeds
  `use-subscription` / `use-stream` / `use-flag`); local memo keys, but must not
  throw on wire-typed args.
- `packages/do/src/reactive-cache.ts` — `reactiveCacheKey`.
- `packages/do/src/relay.ts` — `shapeRoutingKey`.
- `packages/do/src/relay-hub.ts` — `stableStringify(base.effectiveWhere)` /
  `columns` (a `where` predicate can carry a `bigint` literal → must encode).

**Wire round-trip:**

- Client: `sendSubscribeIfOpen`, `sendShapeSubscribeIfOpen` (and the reconnect
  resubscribe, which reuses them) → `encodeWire` the args.
- DO: `decodeWire` the args **at the two entry points** — the `subscribe` handler
  (`shard-do.ts` ~L2196) and `handleShapeSubscribe` (~L2243) — _before_ storing them
  in the socket attachment and _before_ `seedSubscription`. Storing the decoded args
  means every downstream consumer (re-execution on poke, `reactiveCacheKey`, RLS
  predicate eval, `resolveShape` ×3) sees real values, and structured-clone
  attachment persistence carries `bigint`/bytes through hibernation. **Verify** no
  consumer re-reads the raw envelope after decode.

## 3. The hard part — verification (why this needs workerd)

Unit tests (node) cover the key changes (identity for pure JSON; `bigint`/bytes now
key without throwing) and the client send frame (carries encoded args). But the
**DO decode-at-entry → hibernate → re-execute** path is exactly what a live-data
regression would hide in, and only the workerd pool exercises it:

1. Subscribe with a `bigint`/bytes arg → the seeded result and every poke-driven
   re-execution run the query with the **real** value (not `["bigint","123"]`).
2. Evict/hibernate the DO, then trigger a re-exec → decoded args survive the
   attachment round-trip.
3. Two subscriptions whose args differ only by a `bigint`/`Date`/bytes value get
   **distinct** reactive-cache keys (no cross-feed).
4. RLS predicate over a `bigint` arg evaluates correctly.
5. Back-compat: pure-JSON subscription args produce byte-identical keys + frames.

Gate with `LUNORA_WORKERD_TESTS=1` (runtime/`__tests__/workerd/`).

## 4. Fences

- **Keys stay fail-loud on non-serializable types** (`RegExp`, `Headers`, class
  instances) — supporting them as _values_ is separate; they can never be a stable
  key. `encodeWire`'s prototype guard already enforces this.
- **`Map`/`Set` as cache-key args**: `encodeWire` preserves insertion order, so two
  equal-but-differently-ordered Maps would key differently. Acceptable (Maps as
  query args are pathological); or fail-loud on them as keys. Decide during impl.
- No protocol/format change beyond args now riding `encodeWire` (a pure-JSON arg is
  unchanged on the wire).

## 5. Effort & risk

**M–L.** The key half is low-risk (identity for pure JSON, unit-testable). The wire
half mirrors the shipped stream-args pattern. The risk concentrates in the DO
decode-at-entry completeness — hence the workerd e2e gate before merge. Do it in a
worktree (per the repo's agent-isolation guidance), key sites first (independently
shippable + safe), then the wire round-trip with workerd coverage.

## 6. Interim state (already shipped on this branch)

`stableStringify` **fails loud** on these types instead of silently colliding, so
the current behavior is _safe and clear_ (a `TypeError` with "pass it as a string"),
just not _complete_. This plan upgrades clear-error → works. Documented for users in
`packages/client/docs/index.mdx` (Wire protocol → Supported value types).
