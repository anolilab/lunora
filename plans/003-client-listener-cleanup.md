# Plan 003: `CirrusClient.close()` releases auth/status listeners and scheduled-jobs socket

> **Executor instructions**: Follow step by step; run each verification and
> confirm before proceeding. Obey STOP conditions. Update `plans/README.md` when
> done.
>
> **Drift check (run first)**: `git diff --stat 151a3eca..HEAD -- packages/client/src/cirrus-client.ts`
> If the file changed, reconcile the "Current state" excerpts against the live
> code; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (resource leak)
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

`CirrusClient.close()` tears down streams, connections, the offline queue and
queued identities, but never clears the two listener registries
`authTokenListeners` and `statusListeners`. Any callback registered via
`onAuthTokenChange` / `onConnectionStatus` stays referenced after the client is
closed, keeping its closure scope (React state setters, framework refs, user
data) alive — a leak that grows when an app creates and discards multiple client
instances (tests, hot-reload, multi-tenant switching). Secondarily, the
`subscribeScheduledJobs` reconnect path adds listeners to each new socket and
its teardown closes the socket but does not detach them; closing on teardown is
correct, but a stale socket reference can linger. This plan makes `close()`
fully release client-held references.

## Current state

- `packages/client/src/cirrus-client.ts:424` and `:427` — the registries:

    ```ts
    private readonly authTokenListeners = new Set<(token: string | null) => void>();
    // ...
    private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
    ```

    Added via `onAuthTokenChange` (`:514`) and `onConnectionStatus` (`:613`), each
    returning an unsubscribe that `.delete()`s the listener. Fired at `:495` and
    `:1613`.

- `packages/client/src/cirrus-client.ts:1526-1561` — `close()` as it stands
  (clears streams, connection timers/heartbeats/sockets, `offlineQueue`,
  `queuedIdentities`) **but not** the two Sets:

    ```ts
    public close(): void {
        this.closed = true;
        // ... clears streams, connections, sockets ...
        this.offlineQueue.clear();
        this.queuedIdentities.clear();
    }
    ```

- `packages/client/src/cirrus-client.ts:848-887` — `subscribeScheduledJobs`'
  inner `connect()` adds `open`/`message`/`close`/`error` listeners to a fresh
  `socket` each reconnect; the returned teardown (`:879-887`) sets `closed = true`,
  clears the timer, and calls `socket?.close()`. The `close` listener nulls
  `socket` on disconnect. (Listeners on a closed+dereferenced socket are
  collectible, so this is a minor hardening, not the primary leak.)

## Commands you will need

| Purpose           | Command                                         | Expected                           |
| ----------------- | ----------------------------------------------- | ---------------------------------- |
| Build deps (once) | `pnpm run build:packages`                       | exit 0 (dist gitignored/on-demand) |
| Typecheck         | `pnpm --filter "@cirrus/client" run lint:types` | exit 0                             |
| Tests             | `pnpm --filter "@cirrus/client" run test`       | all pass                           |

## Scope

**In scope**:

- `packages/client/src/cirrus-client.ts` — only `close()` (and, for the
  optional hardening in Step 2, the `subscribeScheduledJobs` teardown).
- `packages/client/__tests__/` — the existing client test file covering
  `close()` / lifecycle; extend it.

**Out of scope**:

- The firing logic at `:495` / `:1613` and the subscribe methods at `:514` /
  `:613` — leave the add/remove/fire semantics unchanged.
- Stream/connection teardown already in `close()` — do not refactor it.

## Git workflow

- Branch: `advisor/003-client-listener-cleanup`
- Commit: `fix(client): clear listener registries on CirrusClient.close()`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Clear the listener Sets in `close()`

At the end of `close()`, after `this.queuedIdentities.clear();`, add:

```ts
this.authTokenListeners.clear();
this.statusListeners.clear();
```

These Sets are `private readonly` (the binding is const; `.clear()` mutates
contents, which is allowed). After `close()` the client is terminal, so dropping
listeners is correct — nothing should fire post-close.

**Verify**: `pnpm --filter "@cirrus/client" run lint:types` → exit 0.

### Step 2 (optional hardening): detach scheduled-jobs listeners on teardown

Only if it does not complicate the code: in `subscribeScheduledJobs`, capture
each `addEventListener` callback in a named const and call
`socket?.removeEventListener(...)` for each in the teardown before
`socket?.close()`. If this materially complicates the closure, skip it — Step 1
is the load-bearing fix. Do not change reconnect behavior.

**Verify**: `pnpm --filter "@cirrus/client" run test` → all pass.

### Step 3: Regression test

Add a test that:

1. Creates a `CirrusClient` (using the existing test harness/mock WebSocket).
2. Registers an `onAuthTokenChange` and an `onConnectionStatus` listener.
3. Calls `close()`.
4. Asserts the internal Sets are empty — either via a test-visible accessor if
   one exists, or by asserting the registered callbacks are no longer invoked
   when a token/status change would otherwise fire (the observable proxy for
   "the Set was cleared"). Match how existing client tests assert internal
   state; do not add a new public getter solely for the test if the behavior can
   be asserted observably.

**Verify**: `pnpm --filter "@cirrus/client" run test` → all pass, new test
included.

## Test plan

- New test in the existing client lifecycle test file: "close() releases
  auth/status listeners".
- All existing client tests stay green.
- Verification: `pnpm --filter "@cirrus/client" run test` → all pass.

## Done criteria

ALL must hold:

- [ ] `close()` clears `authTokenListeners` and `statusListeners`
- [ ] `pnpm --filter "@cirrus/client" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/client" run test` exits 0; new lifecycle test passes
- [ ] `git status` shows only in-scope files modified
- [ ] `plans/README.md` row updated

## STOP conditions

- `close()` or the listener-Set declarations no longer match the excerpts.
- Asserting the cleared Sets would require exposing new public API that the
  codebase's test conventions clearly avoid (report; propose the observable
  assertion instead).

## Maintenance notes

- Any future listener registry added to `CirrusClient` should also be cleared in
  `close()`. Consider a comment in `close()` listing the registries it owns.
- Reviewer: confirm nothing fires the cleared listeners after `close()`.
