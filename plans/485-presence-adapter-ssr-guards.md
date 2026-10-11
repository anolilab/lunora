# Plan 485: Stop presence `setData` from sending heartbeats before mount or on the server

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat dcffa4d73..HEAD -- packages/solid/src packages/angular/src packages/solid/__tests__ packages/angular/__tests__`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `dcffa4d73`, 2026-10-11

## Why this matters

`presence` / `createPresence` start all network work in the mount hook (`onMounted` in Solid, the `shouldOpenSubscription` gate in Angular). The exported `setData` helper is defined outside that gate and calls `sendHeartbeat()` unconditionally. A caller that invokes `setData` during render, in a constructor, or in a field initializer therefore fires a `presence:heartbeat` mutation on the server (SSR) or before the component mounts. The mount-time path is correctly guarded; this one path is not. The impact is a stray write per render plus a server-side network call, not a crash. P3.

## Current state

Finding size: the title's "SSR guards for Solid `createAuth` and Angular `setData`" was partly wrong. `createAuth` has no defect; the real gap is the presence `setData` in both adapters.

- **Solid `createAuth` — already clean, no change.** `packages/solid/src/create-auth.ts` touches no browser global (`grep -n "window\|document\|localStorage\|BroadcastChannel\|WebSocket"` returns nothing). It reads `client.getAuthToken()` and `getIdentityStore(client)` at call time only.

- **Solid `createPresence` — `document` is guarded; `setData` is not.**
    - `packages/solid/src/create-presence.ts:94-97`:

        ```ts
        const setData = (next: Record<string, unknown> | undefined): void => {
            latestData = next;
            sendHeartbeat();
        };
        ```

    - `packages/solid/src/create-presence.ts:99` opens `onMounted(() => {`, which `packages/solid/src/solid-compat.ts:163-175` documents as not running during SSR. So `setInterval`, `document.addEventListener` (`:111-113`), and `acquireConnectionContext` (`:122`) are safe on the server.
    - `document` at `:106`, `:111`, `:144` is `typeof`-guarded.

- **Angular `presence` — `document` is guarded; `setData` is not.**
    - `packages/angular/src/presence.ts:127-130`:

        ```ts
        const setData = (next: Record<string, unknown> | undefined): void => {
            latestData = next;
            sendHeartbeat();
        };
        ```

    - `:136` gates the whole mount block with `if (shouldOpenSubscription(fromInjectionContext))`, and `packages/angular/src/platform.ts:29-35` returns `false` on `PLATFORM_ID === "server"`. `setData` sits outside that gate.
    - `document` at `:146`, `:156`, `:186` is `typeof`-guarded and sits inside the gate or a guarded callback.

- **Tests.** `packages/angular/__tests__/ssr.test.ts:102-106` asserts "presence starts no network side effects on the server platform", but never calls `setData`. Solid's vitest project uses `environment: "jsdom"` (`packages/solid/vitest.config.ts:15`) and has no SSR test for presence; `packages/solid/__tests__/create-presence.test.tsx` covers the mounted path only.

## Commands

| Purpose       | Command                                                                    | Expected on success |
| ------------- | -------------------------------------------------------------------------- | ------------------- |
| Build deps    | `pnpm --filter "@lunora/solid..." --filter "@lunora/angular..." run build` | exit 0              |
| Solid tests   | `pnpm --filter "@lunora/solid" run test -- create-presence`                | all pass            |
| Angular tests | `pnpm --filter "@lunora/angular" run test -- presence`                     | all pass            |
| Typecheck     | `pnpm --filter "@lunora/solid" run lint:types` and `…"@lunora/angular"…`   | exit 0              |
| Lint          | `pnpm --filter "@lunora/solid" run lint:eslint` and `…"@lunora/angular"…`  | exit 0              |

If a script name differs, `pnpm --filter "<pkg>" run` lists them. Do not guess.

## Scope

**In scope** (the only files you should modify):

- `packages/solid/src/create-presence.ts`
- `packages/solid/__tests__/create-presence.test.tsx`
- `packages/angular/src/presence.ts`
- `packages/angular/__tests__/ssr.test.ts` (or `presence.test.ts`, whichever holds the server-platform case)

**Out of scope** (do NOT touch):

- `packages/solid/src/create-auth.ts` — no defect; see Current state.
- `packages/angular/src/platform.ts` and `packages/solid/src/solid-compat.ts` — the gates are correct as they are.
- `api-snapshots/` — the exported types do not change, so no snapshot update is expected.
- The heartbeat/interval/visibility behavior when mounted — only the pre-mount / server path changes.

## Git workflow

- Branch: `advisor/485-presence-ssr-guards`, branched from `alpha`.
- One commit. Subject: `fix(solid): skip presence heartbeat from setData before mount`, or the Angular equivalent if the two are split. Keep the body free of any external source name, and wrap body lines at 100.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing test first (Angular, server platform)

In `packages/angular/__tests__/ssr.test.ts`, next to the case at `:102`, add a case that builds `presence` with `makeInjector(fake, "server")`, calls the returned `setData({ status: "typing" })`, and asserts `fake.mutationCalls` is empty.

**Verify**: `pnpm --filter "@lunora/angular" run test -- ssr` → the new case FAILS with one mutation call recorded. If it passes, STOP: the bug is not reproduced (see STOP conditions).

### Step 2: Write the failing test (Solid, before mount)

In `packages/solid/__tests__/create-presence.test.tsx`, add a case that calls `setData` before the owning root has mounted (inside `createRoot`, before the mount callback runs, or by calling it from a render-time context) and asserts no `presence:heartbeat` mutation was sent. The jsdom environment cannot run a real server render, so this pre-mount case is the closest faithful reproduction. Say so in the test name.

**Verify**: `pnpm --filter "@lunora/solid" run test -- create-presence` → the new case FAILS. If it passes, the pre-mount call path is not reached in the test harness; STOP and report rather than weakening the assertion.

### Step 3: Gate `setData`'s send on the mounted state

- Solid (`create-presence.ts`): add `let mounted = false;`. Set `mounted = true` at the top of the `onMounted` setup and `mounted = false` in its teardown. Change `setData` to:

    ```ts
    const setData = (next: Record<string, unknown> | undefined): void => {
        latestData = next;
        if (mounted) {
            sendHeartbeat();
        }
    };
    ```

- Angular (`presence.ts`): add `let active = false;` before the `if (shouldOpenSubscription(...))` block. Set `active = true` inside the block and `active = false` in the `destroyRef.onDestroy` callback. Change `setData` to send only when `active`.

Keep `latestData = next` unconditional so the value is picked up by the first mount-time heartbeat.

**Verify**: both Step 1 and Step 2 tests now PASS; re-run `pnpm --filter "@lunora/solid" run test -- create-presence` and `pnpm --filter "@lunora/angular" run test -- presence` → all pass.

### Step 4: Confirm the mounted path is unchanged

Existing mounted tests (heartbeat on mount, `setData` after mount sends immediately) must still pass without edits. If any of them needs an edit to pass, STOP.

**Verify**: the Step 3 test commands show zero failures other than the new cases, which now pass.

### Step 5: Package gates

```bash
pnpm --filter "@lunora/solid..." --filter "@lunora/angular..." run build
pnpm --filter "@lunora/solid" run lint:types
pnpm --filter "@lunora/angular" run lint:types
pnpm --filter "@lunora/solid" run lint:eslint
pnpm --filter "@lunora/angular" run lint:eslint
```

Run Prettier before ESLint if any line is hand-edited (see `CLAUDE.md`).

**Verify**: all five exit 0.

## Test plan

- New: one Angular server-platform case (`packages/angular/__tests__/ssr.test.ts`) and one Solid pre-mount case (`packages/solid/__tests__/create-presence.test.tsx`).
- Structural pattern: the existing case at `ssr.test.ts:102-106` for Angular; the mounted cases in `create-presence.test.tsx` for Solid.
- Framework SSR test: Angular has one (`ssr.test.ts`). Solid has none for presence and its project is jsdom; do not claim SSR coverage for Solid beyond the pre-mount case.
- `workerd`: check with `grep -n "workerd" packages/solid/vitest.config.ts packages/angular/vitest.config.ts`. Neither is expected to have one. Not required if absent.

## Platform parity

Not applicable. `presence` is a client-side adapter primitive, not a `ctx.*` surface or provider binding. No `PlatformCapabilities` row changes.

## Done criteria

- [ ] Step 1 and Step 2 regression cases were observed failing before Step 3, then pass
- [ ] `grep -n "sendHeartbeat();" packages/solid/src/create-presence.ts` shows the call only inside `setData` behind `if (mounted)` and the interval/mount paths
- [ ] Angular `setData` sends only when `active`
- [ ] `pnpm --filter "@lunora/solid" run test` and `pnpm --filter "@lunora/angular" run test` exit 0 for the presence specs
- [ ] `lint:types` and `lint:eslint` exit 0 for both packages
- [ ] `git status` shows changes only inside the in-scope list
- [ ] `plans/README.md` row for 485 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts at `create-presence.ts:94-97` or `presence.ts:127-130` do not match live code (drift).
- Step 1 or Step 2 passes before any change, meaning the path is already unreachable and the plan is moot. Report and mark the plan REJECTED.
- Making `setData` conditional breaks a mounted-path test (Step 4). The design is wrong; re-scope.
- The same verification fails twice after a reasonable fix attempt.

## Risks

- **Risk:** a caller relies on `setData` before mount to queue a heartbeat. Mitigate: `latestData` is still stored and sent on the first mount heartbeat, so the value is not lost.
- **Perf watch:** none; the change removes work.

## Open questions

1. Should the Solid and Angular fixes ship as one commit or two? Default: one commit, since they share the same defect shape.
2. Is `createAuth` worth a separate audit for `localStorage` reads in `@lunora/client`? Out of scope here; the token store lives outside these two packages.
