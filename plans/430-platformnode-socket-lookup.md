# Plan 430: Make the Node socket host's per-frame lookup O(1) and its restore path persistable

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/platform-node/src/node-socket-host.ts`
> If the file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug / perf (experimental-tier package)
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

Two defects in `packages/platform-node/src/node-socket-host.ts` (the experimental Node host, plan 234):

1. **`handleFor` is O(live sockets) per inbound frame.** `packages/do/src/shard-do.ts:1714-1720` calls `socketFor(ws)` on every `webSocketMessage`, and the Node host answers with `[...runtimeSockets.values()].find((state) => state.raw === raw)` — an array materialization plus linear scan per frame. The Cloudflare host went to documented lengths to avoid exactly this cost (`packages/platform-cloudflare/src/cloudflare-host.ts:437-462`: a `notOurs` negative cache + a generation-keyed membership WeakSet, with a comment naming "O(live sockets) per message" as the bug it fixes). The host meant to prove the contract is portable reintroduces it.
2. **A restored socket's durable writes silently no-op when its row is missing.** `restoreSocket` builds state with `raw: undefined` and never inserts a row — it only `selectRow.get(id)`s. `persistAttachment`/`persistTags` are UPDATE-only prepared statements, so for a restored id with no row, a later `serializeAttachment` writes nothing, violating SocketHost guarantee 2 (attachment survives a recycle).

## Current state

- `packages/platform-node/src/node-socket-host.ts:188`:
  ```ts
  handleFor: (raw) => [...runtimeSockets.values()].find((state) => state.raw === raw)?.handle,
  ```
- `:107-118` — `persistAttachment` / `persistTags` run `updateAttachment.run(...)` / `updateTags.run(...)` (UPDATEs; verify the prepared statements near the top of the factory).
- `:241-258` — `restoreSocket` reads `selectRow.get(id)`, builds `NodeSocket` with `raw: undefined`, `runtimeSockets.set(id, state)`, returns `createHandle(state)`. No `upsertRow.run(...)` — contrast `accept` at `:156-180`, which does `upsertRow.run(id, ..., ...)`.
- The conformance TCK (`@lunora/platform/conformance`) covers `handleFor` and the attachment round-trip across `simulateRecycle` — it is the verification harness for this change.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/platform-node..." run build` | exit 0 |
| Tests (incl. TCK) | `pnpm --filter "@lunora/platform-node" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/platform-node" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/platform-node" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/platform-node/src/node-socket-host.ts`
- `packages/platform-node/__tests__/` — the socket-host test file (find it: `ls packages/platform-node/__tests__ | grep -i socket`)

**Out of scope**:
- `packages/platform-cloudflare/**` — its cache design stays as is.
- `packages/platform/src/**` — no contract change; this is an adapter fix.
- `restoreSocket`'s `raw: undefined` semantics — a restored socket legitimately has no raw connection; do not invent one.

## Git workflow

- Branch: `improve/wave22-platform-node`
- Commit: `fix(platform-node): O(1) socket lookup, restore upserts row`

## Steps

### Step 1: O(1) `handleFor`

Add `const byRaw = new WeakMap<object, NodeSocket>()` beside `runtimeSockets`. `accept` sets `byRaw.set(raw as object, state)`; the close/cleanup path deletes (find where a closing socket leaves `runtimeSockets` and mirror it — grep `runtimeSockets.delete`). `handleFor` becomes `(raw) => (raw === undefined ? undefined : byRaw.get(raw as object)?.handle)` — note the explicit `undefined` guard so a restored socket's absent raw can never be used as a lookup key. The Node host needs no negative cache (unlike Cloudflare, no external party hands it foreign sockets — every raw enters via `accept`).

**Verify**: `pnpm --filter "@lunora/platform-node" run test` → all pass (the TCK's `handleFor` legs cover behavior).

### Step 2: Upsert on restore

In `restoreSocket`, after building `state`, persist the row with the same `upsertRow.run(...)` shape `accept` uses (id, serialized attachment or NULL, JSON tags), guarded on `database.open`. This makes later `persistAttachment`/`persistTags` effective for a restored-but-previously-unknown id.

**Verify**: new unit test — `restoreSocket("id-x", {...})` with no prior row, then `handle.serializeAttachment(value)`, then re-`restoreSocket("id-x")` on a fresh host over the same database returns the written attachment.

### Step 3: Regression test for the lookup

One test: accept N sockets, assert `handleFor(rawK)` returns socket K's handle and `handleFor(undefined)` returns `undefined` (this was previously able to match a restored socket).

**Verify**: `pnpm --filter "@lunora/platform-node" run test` → all pass, including 2 new tests.

## Test plan

- The two new tests above, in the existing socket-host suite (model on its existing accept/restore cases).
- The `@lunora/platform/conformance` TCK run inside the package's test suite is the contract-level gate — it must stay green untouched.

## Done criteria

- [ ] `grep -n "runtimeSockets.values()].find" packages/platform-node/src/node-socket-host.ts` → no matches
- [ ] `pnpm --filter "@lunora/platform-node" run test` exits 0 with the 2 new tests
- [ ] `lint:types` + `lint:eslint` exit 0
- [ ] No files outside the in-scope list modified

## STOP conditions

- The "Current state" excerpts don't match the live file.
- The TCK fails on the upsert-on-restore change (it would mean the contract encodes the no-row behavior — report, don't force).
- `getSockets`' array materialization tempts you to "fix it too" — it is per-fan-out, not per-frame; out of scope.

## Maintenance notes

- If the Node host ever receives sockets it didn't accept (a relay tier), it will need the Cloudflare-style negative cache; the WeakMap alone assumes accept-only entry.
- Reviewer: check the WeakMap delete on close so a closed raw can't resolve.
