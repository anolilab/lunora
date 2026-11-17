# Plan 334 — Runtime determinism for query/mutation bodies

- **Category**: correctness (silent nondeterminism in a replayable path)
- **Status**: PARTIAL — steps 2 (`ctx.random`) and 3 (`ctx.fetch` refused in query/mutation, including the mutation view composed from an action) landed; step 1 and step 4 remain open research. A global-swap implementation was built, proven unsound under concurrency, and reverted
- **Related**: `nondeterministic_query_mutation` advisor lint, `ctx.now`

## The gap

A mutation may be re-executed and its result is cached by idempotency key, so
ambient nondeterminism inside one is a real defect class: `Date.now()` read twice
in one handler yields two instants, `Math.random()` makes a replay write
different rows, and a `fetch` in the write path makes an atomic transaction
depend on someone else's uptime.

Today this is caught by a static advisor lint plus the `ctx.now` surface. A lint
only sees the call sites it can read — not the ones inside a dependency.

## What was tried, and why it was reverted

`withDeterministicScope` captured `Date.now` / `Math.random` / `globalThis.fetch`,
swapped in deterministic replacements for the duration of a mutation, and
restored them in `finally`. It was wired into `ShardDO.runInTransaction`.

The soundness argument was "a mutation holds the DO's single-writer gate, so
nothing else runs during it". That gate is **per Durable Object**; the globals are
**per isolate**, and workerd hosts many DOs of the same class in one isolate. This
repo already documents that premise, in a comment written to fix the same class of
bug:

> `packages/observability/src/query-metrics.ts` — "Keyed by the storage handle
> rather than a module-level scalar: workerd hosts several Durable Object
> instances of the same class in one isolate…"

Two interleaved scopes corrupt the save/restore stack:

```
A enter: saves real     → patches
B enter: saves A's stub → patches
A exit : restores real  → B loses its guarantee mid-mutation
B exit : restores A's stub → globalThis is permanently patched
```

Reproduced in a scratch test: after two interleaved scopes `Date.now` is still the
frozen stub and `globalThis.fetch` still throws — for every shard, query,
subscription, alarm, and telemetry flush in that isolate, until it is recycled. On
`@lunora/platform-node` it is worse: `runSerialized` is per shard host while
`globalThis` is process-wide, so any two concurrent shard mutations trip it.

A refcount would stop the permanent poisoning but still cannot give the
overlapping mutation its guarantee, because there is only one set of globals.

## What a sound version looks like

Per-context injection, not global mutation:

1. **`ctx.now` already exists** and is frozen per dispatch. The remaining gap is
   code that calls ambient `Date.now()` — which only a lint or a bundler-level
   transform can see.
2. **`ctx.random`** as a seeded PRNG, so a handler that wants replay-stable
   randomness has a supported way to get it. _Landed_: `createStableRandomFactory`
   in `@lunora/do` derives each value from the same replay key and scope as
   `ctx.newId()`, with its own domain tag so a value is not a function of the id
   at the same index. Without a replay key it is `Math.random()`. The values are
   derived, not random, so secrets keep `crypto.getRandomValues`. The advisor's
   `Math.random` remedy in a mutation now points here. Queries and actions get it
   too, but only a keyed mutation reproduces it: a query re-run is not replay-stable.
3. **`ctx.fetch` refused in query/mutation.** This one IS sound per-context and is
   the Convex-equivalent rule (network I/O belongs in an action). It needs a
   codegen change: the emitted `buildCtx` already knows the dispatch mode, so it
   can install a throwing `fetch` for the non-action modes without touching
   `globalThis`. Note it is a breaking change for any mutation using `ctx.fetch`.
   _Landed_: `refuseFetch` in `packages/codegen/src/emit/shard-context.ts` throws
   `FORBIDDEN` for `query` and `mutation` ctx. A query view composed from an action
   gets it too, and so does a mutation view built by `ctx.runMutation` from an
   action, which is copied from the action's ctx and overrides its `fetch`.
4. An `AsyncLocalStorage`-backed scope would cover ambient calls soundly, but
   `node:async_hooks` availability on workerd (and its cost per dispatch) needs
   measuring before that is promised. _Finding_: the shard DO does not have it.
   `packages/do/src/shard-do.ts` documents that workerd enables ALS only under
   `nodejs_compat`, and shard DOs run the `sqlite_compat` profile without it. So a
   scope there would need a wrapper around `globalThis`, which is the design this
   plan rejected. Open: whether to pursue that, and at what dispatch cost.

Ordering: (3) and (2) have landed. (1) and (4) are the open research; (4) is
blocked on the workerd ALS finding above.
