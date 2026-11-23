# Plan 617: Presence follows a room change in the Vue, Solid, Svelte and Angular adapters

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 093c5e41f..HEAD -- packages/vue/src/use-presence.ts packages/solid/src/create-presence.ts packages/svelte/src/presence.ts packages/angular/src/presence.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `093c5e41f` (2026-11-20)
**Status:** DONE, pushed: `fix/migrate-exclusive-write-and-presence-room`; PR #1643

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `093c5e41f`, 2026-11-20
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

Presence ("who is in this room") is a heartbeat mutation plus a live `listPresent` subscription, both keyed by `roomId`. In the React adapter a changed `roomId` re-arms both (fixed in PR #856: before it, a route change kept showing the old room's members). The other four framework adapters take `roomId: string` once and never look at it again. With a router that reuses the component instance between `/room/a` and `/room/b`, the user keeps heartbeating room A, sees A's members, and never joins B.

## Current state

- `packages/vue/src/use-presence.ts:71` — `const usePresence = <H, L>(roomId: string, options: UsePresenceOptions<H, L>): UsePresenceResult<L> => {`. `sendHeartbeat` (line ~89) closes over `roomId`. Inside `if (isBrowser()) { ... }` (line ~115) it: sends a heartbeat, `setInterval(sendHeartbeat, intervalMs)`, adds a `visibilitychange` listener, `const releaseConnectionContext = client.acquireConnectionContext({ roomId, sessionId }, { shardKey });`, `const unsubscribe = client.subscribe(listPresent, { roomId }, onValue, { onError, shardKey })`, and registers a `teardown` (clear interval, remove listener, `releaseConnectionContext()`, `unsubscribe()`) with `onScopeDisposeOrWarn`.
- `packages/solid/src/create-presence.ts:69-72` — `createPresence(roomId: string, options)`; same wiring inside `onMounted(() => { ...; return () => { teardown } })`.
- `packages/svelte/src/presence.ts:223` — overloads `presence(roomId: string, options)` and `presence(client, roomId: string, options)`, both delegating to `createPresenceHandle(client, roomId, options)`.
- `packages/angular/src/presence.ts:98` — `presence(roomId: string, options): PresenceResult<L>`; `sendHeartbeat` closes over `roomId`.
- Reference behaviour, `packages/react/src/use-presence.ts:189-211`: the heartbeat effect lists `roomId` (and `client`, session id, `shardKey`) as dependencies so "a new room is joined at once rather than on the next interval tick"; React also clears `present` when the room changes so the old room's members are never shown under the new one. Its regression test is `packages/react/__tests__/use-presence-room-change.test.tsx` — read it first; it defines the behaviour to port.
- How each adapter already accepts reactive arguments elsewhere (use the same idiom, do not invent one):
    - Vue: `rg -n "MaybeRefOrGetter|toValue" packages/vue/src/use-query.ts`
    - Solid: `rg -n "Accessor<|createEffect|on\\(" packages/solid/src/create-query.ts packages/solid/src/*.ts | head`
    - Svelte: `rg -n "Readable<|\\$effect|subscribe\\(" packages/svelte/src/*.ts | head` (the package targets stores; check which)
    - Angular: `rg -n "Signal<|effect\\(|toObservable" packages/angular/src/live-query.ts packages/angular/src/*.ts | head`
- Existing tests to extend/copy: `packages/vue/__tests__/use-presence.test.ts`, `packages/solid/__tests__/create-presence.test.tsx`, `packages/svelte/__tests__/presence.test.ts`, `packages/angular/__tests__/presence.test.ts`.

### Repo conventions that apply (from the repo's AGENTS.md — you have not read it, so they are inlined)

- TypeScript, ESM, `"moduleResolution": "bundler"`: relative imports have **no** file extension (`from "./foo"`, never `"./foo.js"`).
- Never mix a default export with named exports in one file. More than one export ⇒ named only.
- This is a pre-release (`1.0.0-alpha.*`) line: do **not** keep backward-compat shims or deprecated aliases; change the behaviour and update every call site.
- Comments say _why_ (a constraint or invariant), never restate the code or record history.
- An `eslint-disable` must be line-scoped, name the rule, and give a reason after `--`. Never add a file-level disable. Never skip or silence a test, type error or lint rule to get green.
- Tests are Vitest, live in the package's `__tests__/`, and **wait on a milestone, never on a clock** (no `sleep`, no real `setTimeout` waits). Existing tests start with `expect.assertions(n)`; match that.
- **A test must fail without the fix.** After writing a test, temporarily revert your fix, run the test, confirm it goes red, then restore the fix. Report that you did this.
- If you fix by hand: run Prettier before ESLint.
- Never run `pnpm -r run test`, never `pnpm run test:workerd`, never `pnpm run build:packages` (other sessions share this machine; those have crashed it). Use the single-package commands below.
- Never kill a process by name/pattern. Never `git add -A` / `git commit -a` / `git stash`; stage explicit paths.

## Commands you will need

For each `<pkg>` in `vue`, `solid`, `svelte`, `angular` (run from the repo root; fresh worktree needs `pnpm install --frozen-lockfile` once):

| Purpose      | Command                                                              | Expected   |
| ------------ | -------------------------------------------------------------------- | ---------- |
| Build + deps | `pnpm --filter "@lunora/<pkg>..." run build`                         | exit 0     |
| Tests        | `pnpm --filter "@lunora/<pkg>" run test`                             | all pass   |
| Types / lint | `pnpm --filter "@lunora/<pkg>" run lint:types` and `run lint:eslint` | exit 0     |
| Public API   | `pnpm run api:check` (after building the four packages)              | see step 5 |

## Design (decided)

- `roomId` accepts the adapter's native reactive form **in addition to** a plain string: Vue `MaybeRefOrGetter<string>`; Solid `string | Accessor<string>`; Angular `string | Signal<string>`; Svelte: `string | Readable<string>` if the package's other APIs take stores, otherwise the rune-era equivalent the package already uses. A plain string behaves exactly as today.
- On a change of room: (1) tear down the old room's wiring — interval, visibility listener, connection context, subscription; (2) clear `present` and `error`; (3) set up the same wiring for the new room, which sends a heartbeat immediately. The session id is kept. Extract the existing setup block into a local `arm(room): () => void` that returns its teardown, and call it from a watcher/effect; the final dispose calls the current teardown.
- SSR guards (`isBrowser()` in Vue, the mount gate in the others) stay exactly as they are.
- No leave-mutation is sent for the old room; the server expires the row by heartbeat timeout, same as an unmount today.

## Scope

**In scope**: the four source files above; the four test files above (or a new `*-room-change` test next to each); each package's `docs/index.mdx` presence section (one sentence: `roomId` may be reactive and presence follows it); `api-snapshots/{vue,solid,svelte,angular}.api.md` via `pnpm run api:update`.

**Out of scope**: `packages/react/**`, `packages/react-native/**`, `packages/client/**`, the server presence preset, `shared/**`. Do not change option names or the result shape.

## Git workflow

- Branch: `fix/542-presence-room-change` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Example from this repo: `fix(auth): address API key review comments`. Use: `fix(vue): follow a room change in usePresence`.
- Never use `--no-verify`. Do NOT push or open a PR. One commit per adapter, each with its own scope (`vue`, `solid`, `svelte`, `angular`).

## Steps

Do the adapters one at a time, in this order: Vue, Solid, Angular, Svelte. For each:

### Step N.1: test first

Port the React room-change test to the adapter's test harness (reuse the mock client from that adapter's existing presence test). Assert, after changing the room from `"a"` to `"b"`: a heartbeat mutation with `roomId: "b"` is sent without advancing timers; the `listPresent` subscription for `"a"` was unsubscribed and one for `"b"` opened; `acquireConnectionContext` was released for `a` and acquired for `b`; `present` is `undefined` until `b` pushes; a value pushed late for `a` does not appear. Use `vi.useFakeTimers()` for the interval; flush the framework's reactivity with its own primitive (`await nextTick()` in Vue, etc.) — never sleep.

**Verify**: the new test FAILS (this is the red check).

### Step N.2: implement per the Design

**Verify**: the adapter's whole test file set passes; `lint:types` and `lint:eslint` exit 0.

### Step N.3: docs sentence in that package's `docs/index.mdx`.

### Step 5 (after all four): API snapshots

Build the four packages, run `pnpm run api:check`. The only expected diffs are the widened `roomId` parameter types. If so run `pnpm run api:update` and commit the four snapshot files (`chore` is not needed — include them in a final `fix(angular): ...`-style commit or a separate `docs`-free commit `fix(svelte): accept a reactive room id in presence`). Any other diff is a STOP.

## Done criteria

- [ ] Each of the four adapters has a room-change test that failed before its fix and passes after
- [ ] `pnpm --filter "@lunora/{vue,solid,svelte,angular}" run test`, `lint:types`, `lint:eslint` exit 0 (run per package)
- [ ] `pnpm run api:check` exits 0
- [ ] `git status --short` lists only in-scope files

## STOP conditions

- An adapter has no existing reactive-argument idiom to copy (report which; finish the others).
- The Svelte package's reactivity model makes "a changing room id" impossible without a new public API shape beyond widening `roomId`.
- A fix needs a change in `@lunora/client`.
- Existing presence tests fail for a reason other than the intended behaviour change.

## Maintenance notes

- Five adapters now implement the same re-arm logic; the consolidation of adapter surfaces is tracked separately (repo plan 160). Any future presence fix must be applied to all five — the last one (#856) was not.
- Reviewer: check the late-value guard (a push for the old room arriving after the switch) in each adapter.
