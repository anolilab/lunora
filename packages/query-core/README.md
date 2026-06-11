# @cirrus/query-core

The framework-neutral live-query state machine shared by every Cirrus UI adapter (React, Vue, Svelte, Solid). It owns the seam between a `CirrusClient` subscription and a framework's reactivity primitive — the subscribe → snapshot → error/reset → cleanup lifecycle — so the skip-handling, value/error fan-out, attach-throw normalisation, and cancellation-guarded teardown live in exactly one place instead of being hand-rolled (with drift) in four adapters.

Nothing here imports a UI framework. Each adapter supplies thin **sinks** that write into its own `ref` / store / signal / cache, and decides _when_ to run the machine (a React effect, a Vue `watch`, a Svelte store start callback, a Solid `createEffect(on(...))`).

## Install

```bash
pnpm add @cirrus/query-core
```

(Internal — consumed by `@cirrus/react`, `@cirrus/vue`, `@cirrus/svelte`, `@cirrus/solid`.)

## API

- `createQuerySubscription(client, fn, args, sinks, options?)` → `Unsubscribe` — open one `client.subscribe` registration for already-resolved `args` and drive the supplied sinks. Returns the teardown.
    - `args === "skip"` → calls `sinks.onReset?.()` and returns a no-op teardown; no subscribe is issued.
    - server pushes → `sinks.onData(value)`; a server-rejected subscription → `sinks.onError(error)` when present.
    - if `client.subscribe` throws, the error is normalised and delivered to `sinks.onError` when present, else **rethrown** (so adapters without an error channel behave exactly as before).
    - the returned teardown is idempotent and cancellation-guarded.
- `SKIP` — the `"skip"` sentinel.
- `toSubscriptionError(error)` — normalise an unknown thrown value into the client's `SubscriptionError` shape.

### Sinks

```ts
interface QuerySubscriptionSinks<T> {
    onData: (value: T) => void;
    onError?: (error: SubscriptionError) => void;
    onReset?: () => void;
}
```

## Usage

```ts
import { createQuerySubscription } from "@cirrus/query-core";

// Inside a framework effect/watch, after resolving the reactive args:
const unsubscribe = createQuerySubscription(
    client,
    fn,
    resolvedArgs,
    {
        onData: (value) => setValue(value),
        onError: (error) => setError(error),
        onReset: () => setValue(undefined),
    },
    { shardKey },
);

// On teardown / re-run:
unsubscribe();
```
