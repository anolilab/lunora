# Plan 532: Client and adapter fixes from the 2026-10-19 audit

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2376f8799..HEAD -- packages/client/src packages/react/src packages/vue/src packages/solid/src packages/svelte/src packages/db/src`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M (six S-sized fixes)
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug + perf
- **Planned at**: commit `2376f8799`, 2026-10-19
- **Issue**: https://github.com/anolilab/lunora/issues/1271
- **Platform parity**: not applicable (no `ctx.*` surface or binding changes)

## Why this matters

Six independent defects in the browser client and the framework adapters. One
wedges a user's whole offline queue silently (a throwing `precondition`), one
re-executes a query on the server for every component that joins an existing
subscription, one lets four of five presence adapters heartbeat-storm the
backend on `intervalMs: 0`, and three are hot-path waste (token re-hashing per
frame, page-key re-serialisation per cache event, full-collection stringify per
frame). All are small, local, and have a clean test story.

## Current state

Repo: pnpm monorepo, TypeScript ESM, Vitest. Conventions from `CLAUDE.md`:
relative imports WITHOUT `.js` extensions; named exports only (no default +
named mix); on branch `alpha` do NOT keep backward-compat shims; never skip
tests or silence lint. `eslint` runs with `--max-warnings=0`, so a new
`eslint-disable` comment must carry a `-- reason` like the surrounding code.

### A. `drainConflict` lets a throwing `precondition` wedge the queue

`packages/client/src/offline-queue.ts:437-452`:

```ts
    public drainConflict(): QueuedMutation[] {
        const conflicted: QueuedMutation[] = [];
        const kept: QueuedMutation[] = [];

        for (const item of this.items) {
            if (item.precondition !== undefined && !item.precondition()) {
                const error = new Error("offline mutation skipped: precondition failed before replay");

                (error as Error & { code?: string }).code = "OFFLINE_PRECONDITION_FAILED";
                item.reject(error);
                conflicted.push(item);
            } else {
                kept.push(item);
            }
        }
```

`item.precondition` is user code (`MutationCallOptions.precondition`, see
`packages/client/src/lunora-client.ts:~382`). If it throws, the throw escapes
`drainConflict`, which is the first statement of `drainOfflineQueue`
(`lunora-client.ts:~8433`), and the only catch above it
(`lunora-client.ts:~8408-8412`) swallows it:

```ts
try {
    await this.drainOfflineQueue(shardKey, authToken);
} catch {
    /* per-item verdicts are settled inside the drain — never poison the chain */
}
```

Result: nothing in that shard's queue is ever drained or settled; the awaiting
`mutation()` promises never resolve; every reconnect re-throws silently.

### B. Every `subscribe()` on an existing state re-sends the `subscribe` frame

`packages/client/src/lunora-client.ts:~3726` — at the end of `subscribe()`,
after the state was either created or looked up:

```ts
this.ensureSocket(options.shardKey);
this.sendSubscribeIfOpen(state);
```

`packages/client/src/lunora-client.ts:~6755`:

```ts
    private sendSubscribeIfOpen(state: SubscriptionState): boolean {
        const conn = this.getConnection(state.shardKey);

        if (conn?.wsState !== "open" || state.acked) {
            return false;
        }
```

Nothing records "a frame for this id is already on the wire and un-acked".
N components mounting on the same `(fn, args, shardKey)` before the ack send N
frames; the Durable Object executes the query and pushes a full snapshot per
frame (`packages/do/src/shard-do.ts` subscribe → ack → seed, unconditional).
React dedups in `packages/react/src/cache.ts`, so this hits Vue/Solid/Svelte/
Angular/`@lunora/db` and any direct `client.subscribe` caller.

NOTE: open PR #1263 (`fix/client-transport-hardening`) changes this same
function to `sendSubscribeIfOpen(state, isRetry = false)` and adds an un-acked
watchdog that re-sends once. Your change must compose with it: the watchdog's
retry call must NOT be suppressed by the in-flight flag. Implement the flag so
that a retry path can bypass it (see Step 2).

### C. Presence `intervalMs` validated in Angular only

`packages/angular/src/presence.ts:102-110` (the correct one):

```ts
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    ...
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new RangeError(`presence intervalMs must be a positive number, got ${String(intervalMs)}`);
    }
```

The other four pass the raw value to `setInterval`, so `0`/`NaN` fires a
heartbeat mutation every ~4 ms:

- `packages/react/src/use-presence.ts:95` destructures `intervalMs`, `:189` `setInterval(sendHeartbeat, intervalMs)`
- `packages/vue/src/use-presence.ts:72`, `:117`
- `packages/solid/src/create-presence.ts:73`, `:110`
- `packages/svelte/src/presence.ts:79`, `:126`

### D. `identityFingerprint()` re-hashes the bearer token on every call

`packages/client/src/lunora-client.ts:~7640-7652`:

```ts
const token = this.authToken;

if (token === null) {
    return null;
}

return this.hashToken(token);
```

`hashToken` is two full passes over the token string (FNV-1a + djb2). There
are 29 call sites of `identityFingerprint()` in the file, several on the
per-`data`-frame path (`persistQueryValue`, `credentialStamp`, leader
broadcast). A 1–2 KB JWT costs ~8k char iterations per frame for nothing.

### E. Paginated hook re-serialises all page keys per cache event

`packages/react/src/use-paginated-core.ts:353-367`:

```ts
        const unsubscribe = cache.subscribe((event) => {
            if (event.type !== "updated") {
                return;
            }

            const hash = serializeQueryKey(event.query.queryKey as QueryKey);

            if (pageEntries.some(({ key }) => serializeQueryKey(key) === hash)) {
```

`pageEntries` is stable per render; `serializeQueryKey` is `stableWireKey`
(non-trivial). Every `updated` event anywhere in the `QueryClient` costs
`pages` serialisations per mounted paginated hook.

### F. `@lunora/db` stringifies every row per frame

`packages/db/src/internals.ts:352-372` (`makeDiffEmit`):

```ts
        for (const [key, value] of next) {
            const valueJson = JSON.stringify(value);

            nextJson.set(key, valueJson);

            if (!syncedJson.has(key)) {
                writer.write({ type: "insert", value });
            } else if (syncedJson.get(key) !== valueJson) {
                writer.write({ type: "update", value });
            }
```

The client's delta-merge path preserves object identity for untouched rows, so
a row object seen before can reuse its cached string.

### G. Svelte `subscription()` normalises the error before `onError`

`packages/svelte/src/subscription.ts:14` declares `onError?: (error: Error) => void`
and `:95-104` builds a new `Error`/`LunoraError` and passes THAT to `onError`.
Svelte's own `query.ts:17` and every other adapter pass the raw
`SubscriptionError` (`SubscriptionErrorCallback` from `@lunora/client`). Consumers
lose `error.code` on this one function.

## Commands you will need

Run from the repo root. In a fresh worktree run install and the dependency
build first (the `...` suffix builds workspace deps of the package).

| Purpose      | Command                                                                                                                                                  | Expected                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Install      | `pnpm install --frozen-lockfile`                                                                                                                         | exit 0                                 |
| Build deps   | `pnpm --filter "@lunora/db..." --filter "@lunora/react..." --filter "@lunora/svelte..." --filter "@lunora/vue..." --filter "@lunora/solid..." run build` | exit 0                                 |
| Test one pkg | `pnpm --filter "@lunora/client" run test`                                                                                                                | all pass                               |
| Typecheck    | `pnpm --filter "@lunora/client" run lint:types`                                                                                                          | exit 0                                 |
| Lint         | `pnpm --filter "@lunora/client" run lint:eslint`                                                                                                         | exit 0, 0 warnings                     |
| API snapshot | `pnpm run api:check`                                                                                                                                     | exit 0 (run after the build; see STOP) |

Replace the filter for `@lunora/react`, `@lunora/vue`, `@lunora/solid`,
`@lunora/svelte`, `@lunora/db`.

## Scope

**In scope** (the only files you may modify):

- `packages/client/src/offline-queue.ts`
- `packages/client/src/lunora-client.ts`
- `packages/client/__tests__/offline-queue.test.ts` (add cases) or a new `packages/client/__tests__/offline-precondition-throw.test.ts`
- `packages/client/__tests__/subscribe-dedup.test.ts` (create)
- `packages/react/src/use-presence.ts`, `packages/vue/src/use-presence.ts`, `packages/solid/src/create-presence.ts`, `packages/svelte/src/presence.ts`
- One existing presence test per adapter (add one `it`) — find them with `ls packages/<adapter>/__tests__ | grep -i presence`
- `packages/react/src/use-paginated-core.ts`
- `packages/db/src/internals.ts` and its test (`ls packages/db/__tests__ | grep -i internals`)
- `packages/svelte/src/subscription.ts` and its test
- `api-snapshots/svelte.api.md` ONLY if `api:check` reports the Svelte `onError` type change (run `pnpm run api:update` after a fresh build, and keep only the svelte diff)

**Out of scope** (do NOT touch):

- `packages/angular/*` — already correct.
- `packages/do/*`, `packages/runtime/*` — server side; the subscribe dedup is a client-only change.
- `packages/react/src/cache.ts`, `use-query.ts` — the React double-fetch is a separate design item (see `plans/README.md`).
- Any change to wire frame shapes.

## Git workflow

- Branch: `fix/client-audit-2026-10-19` (create from `alpha`).
- One commit per step, conventional commits, e.g.
  `fix(client): settle a throwing offline precondition instead of wedging the queue`.
  Subject under ~70 chars, imperative, lowercase, no trailing period. Body lines wrap at 100.
- Do NOT push or open a PR.

## Steps

### Step 1: Guard `precondition()` in `drainConflict`

In `packages/client/src/offline-queue.ts` replace the `if` with a helper that
treats a throw as `false` and carries the thrown value as `cause`:

```ts
for (const item of this.items) {
    let holds = true;
    let cause: unknown;

    if (item.precondition !== undefined) {
        try {
            holds = item.precondition();
        } catch (error: unknown) {
            holds = false;
            cause = error;
        }
    }

    if (!holds) {
        const error = new Error("offline mutation skipped: precondition failed before replay", cause === undefined ? undefined : { cause });

        (error as Error & { code?: string }).code = "OFFLINE_PRECONDITION_FAILED";
        item.reject(error);
        conflicted.push(item);
    } else {
        kept.push(item);
    }
}
```

Add a test (model after the existing `drainConflict` cases in
`packages/client/__tests__/offline-queue.test.ts`): enqueue three items, the
middle one's `precondition` throws; `drainConflict()` returns exactly that item,
its `reject` was called with an error whose `code` is
`OFFLINE_PRECONDITION_FAILED` and whose `cause` is the thrown value; the other
two remain queued in order.

**Verify**: `pnpm --filter "@lunora/client" run test -- offline-queue` → all pass, new test included.

### Step 2: Dedupe in-flight `subscribe` frames

In `packages/client/src/lunora-client.ts`:

1. Find the `SubscriptionState` interface/type (search `interface SubscriptionState`) and add `subscribeInFlight: boolean;` with a one-line doc: "a `subscribe` frame for this id is on the wire and not yet acked, errored or dropped".
2. Initialise it `false` wherever a `SubscriptionState` is constructed (search for `acked: false` to find every constructor literal).
3. In `sendSubscribeIfOpen`, return `false` early when `state.subscribeInFlight` is true, and set it `true` right after a successful `sendOn(...)`. Give the method a second parameter `force = false` that bypasses the in-flight check (PR #1263 will pass `true` from its watchdog retry; if that PR has already merged and the parameter is named `isRetry`, reuse it instead of adding a second one).
4. Clear the flag (`false`) at every point where the frame's outcome is known: where `state.acked = true` is set, where a subscription `error` frame is handled for that id, in the resubscribe/reset path that runs on socket close/reconnect (search for `acked = false` — every place that resets `acked` must also reset `subscribeInFlight`), and in `resnapshotSubscription`.

Add `packages/client/__tests__/subscribe-dedup.test.ts` modelled on
`packages/client/__tests__/resubscribe-pacing.test.ts` (it shows how to build a
client with the socket harness from `./lib/harness` and count frames). Case:
open the socket, call `client.subscribe(fnRef("todos.list"), {}, cb)` twice
before any ack; assert exactly one frame with `type === "subscribe"` was sent.
Second case: after the socket closes and reopens, the frame is re-sent once
(the reset path cleared the flag).

**Verify**: `pnpm --filter "@lunora/client" run test` → all pass.
**Verify**: `pnpm --filter "@lunora/client" run lint:types && pnpm --filter "@lunora/client" run lint:eslint` → exit 0.

### Step 3: Cache the token fingerprint

In `lunora-client.ts`, add a private field
`tokenFingerprint: { hash: string; token: string } | undefined`. In the
branch of `identityFingerprint()` that calls `this.hashToken(token)`, return
the cached hash when `this.tokenFingerprint?.token === token`, else compute,
store and return. No invalidation hook is needed because the cache is keyed on
the token value itself (a new token misses once). Keep `hashToken` unchanged —
other call sites use it directly.

**Verify**: `pnpm --filter "@lunora/client" run test` → all pass (existing
fingerprint/identity tests cover behaviour; no new test required).

### Step 4: Presence `intervalMs` guard in four adapters

In each of `react/src/use-presence.ts`, `vue/src/use-presence.ts`,
`solid/src/create-presence.ts`, `svelte/src/presence.ts`, directly after the
line that destructures/derives `intervalMs`, add the same guard Angular has:

```ts
if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`presence intervalMs must be a positive number, got ${String(intervalMs)}`);
}
```

Add one `it` to each adapter's existing presence test:
"throws a RangeError for a non-positive intervalMs" (`intervalMs: 0`).

**Verify**: for each of react, vue, solid, svelte: `pnpm --filter "@lunora/<adapter>" run test -- presence` → all pass.

### Step 5: Paginated page-key set

In `packages/react/src/use-paginated-core.ts`, inside the `useEffect` at
`:353`, build `const pageHashes = new Set(pageEntries.map(({ key }) => serializeQueryKey(key)));`
once before `cache.subscribe(...)`, and replace the `.some(...)` with
`pageHashes.has(hash)`. Leave the effect's dependency array as is (it already
re-runs when `pageKeysHash` changes — confirm by reading it; if it does not
include `pageKeysHash` or `pageEntries`, add `pageKeysHash`).

**Verify**: `pnpm --filter "@lunora/react" run test -- paginated` → all pass.

### Step 6: Memoise row serialisation in `@lunora/db`

In `packages/db/src/internals.ts` `makeDiffEmit`: add a module-level
`const rowJson = new WeakMap<object, string>();` and replace
`const valueJson = JSON.stringify(value);` with a lookup that returns the cached
string for the same object and stores it on miss:

```ts
let valueJson = rowJson.get(value);

if (valueJson === undefined) {
    valueJson = JSON.stringify(value);
    rowJson.set(value, valueJson);
}
```

Add a test to the internals test file: call the emitter twice with the same
`Map` containing the same row objects; spy on `JSON.stringify` (or count via a
`toJSON` on the row) and assert the second call serialises 0 rows and writes
nothing.

**Verify**: `pnpm --filter "@lunora/db" run test` → all pass.

### Step 7: Svelte `subscription()` passes the raw `SubscriptionError`

In `packages/svelte/src/subscription.ts`: change the option type at `:14` to
`onError?: SubscriptionErrorCallback` (import the type from `@lunora/client`
like `query.ts:1` does) and at `:95-104` call `onError?.(subscriptionError)`
with the raw error. Keep the normalised `Error` for the `error` store only.
Update the existing subscription test to assert `onError` receives an object
with the wire `code`.

**Verify**: `pnpm --filter "@lunora/svelte" run test` → all pass.
**Verify**: `pnpm --filter "@lunora/svelte" run build && pnpm run api:check` →
if it reports only the `onError` type in `api-snapshots/svelte.api.md`, run
`pnpm run api:update` and commit that one snapshot. Any other snapshot diff is a STOP.

## Test plan

- New: throwing precondition (Step 1), subscribe dedup ×2 (Step 2), presence RangeError ×4 (Step 4), db memo (Step 6), svelte onError shape (Step 7).
- Pattern files: `packages/client/__tests__/offline-queue.test.ts`, `packages/client/__tests__/resubscribe-pacing.test.ts`.

## Done criteria

- [ ] `pnpm --filter "@lunora/client" run test` exits 0 with the new tests
- [ ] `pnpm --filter "@lunora/react" run test`, `@lunora/vue`, `@lunora/solid`, `@lunora/svelte`, `@lunora/db` each exit 0
- [ ] `run lint:types` and `run lint:eslint` exit 0 for all six packages
- [ ] `grep -n "item.precondition()" packages/client/src/offline-queue.ts` shows the call only inside a `try`
- [ ] `git status` shows no files outside the in-scope list
- [ ] `pnpm run api:check` exits 0

## STOP conditions

- The excerpts above do not match the live code (drift).
- `api:check` reports a diff outside `api-snapshots/svelte.api.md`.
- The subscribe-dedup test cannot be made to pass without touching `packages/do`.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- PR #1263 adds a watchdog retry to `sendSubscribeIfOpen`; the retry must bypass the in-flight flag. Whoever merges second resolves the conflict in that function.
- The React double-fetch (`use-query.ts` HTTP snapshot + WS seed) and the bearer-in-WS-URL exposure are tracked separately in `plans/README.md`; do not fold them in here.
