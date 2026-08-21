# Plan 443: Key the flags OpenFeature client memo by definition and env

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/flags/src/flags.ts`
> On any change, compare the "Current state" excerpts; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The flags facade memoizes its bound OpenFeature client in a bare module-level scalar: the **first** `createFlags` call's `provider()`, `logger`, and `hooks` win forever, and every later call — with a different definition or a different Worker `env` — silently reuses them. In binding mode the provider factory resolves `env[bindingName]` inside the factory, so the memo permanently captures whichever request's `env` won the race. The sibling facade `@lunora/notify` solved the identical problem explicitly with a `WeakMap<definition, WeakMap<env, runtime>>` cache whose docstring spells out the rationale ("tests using fresh objects never leak state into each other"). In tests, any suite that forgets `resetFlags()` leaks a provider into the next file — the documented "test-only" escape hatch exists precisely because the memo is mis-keyed.

**Deliberate scope cut**: the OpenFeature `DOMAIN = "lunora"` constant stays. Changing the domain per definition would fix the global-registry collision too, but it breaks any external `OpenFeature.getClient("lunora")` reader — that half is explicitly deferred and recorded below.

## Current state

- `packages/flags/src/flags.ts:16` — `const DOMAIN = "lunora";`
- `packages/flags/src/flags.ts:24` — `let clientBinding: Promise<Client> | undefined;` with a docstring asserting "The provider is set + initialized exactly once per DO isolate".
- `packages/flags/src/flags.ts:32-57` — `bindClient({ hooks, logger, provider })` memoizes into the scalar; a rejected bind self-clears:
  ```ts
  if (clientBinding === undefined) {
      clientBinding = (async (): Promise<Client> => {
          await OpenFeature.setProviderAndWait(DOMAIN, provider());
          const client = OpenFeature.getClient(DOMAIN);
          ...
      })();
      clientBinding.catch(() => { clientBinding = undefined; });
  }
  return clientBinding;
  ```
- `packages/flags/src/flags.ts:59-68` — `resetFlags()` (test-only) clears the scalar + `OpenFeature.clearProviders()`.
- `packages/flags/src/providers/flagship.ts:70-85` — binding mode returns `(env) => new FlagshipServerProvider({ binding: env[bindingName], ... })`: the memoized bind captures one `env`.
- The pattern to copy — `packages/notify/src/notify.ts:105-130`:
  ```ts
  const runtimeCache = new WeakMap<NotifyDefinition, WeakMap<NotifyEnv, NotifyRuntime>>();
  const runtimeFor = (definition, env) => { /* two-level WeakMap get-or-create */ };
  ```
- Find what identity object `bindClient`'s caller has in hand: read `createFlags` in the same file — whatever stable objects it receives (the definition/options object and the `env`) are the memo keys. If `createFlags` is not handed the `env` object itself at bind time, STOP (see STOP conditions).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/flags..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/flags" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/flags" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/flags" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/flags/src/flags.ts`
- The flags test file(s) in `packages/flags/__tests__/`

**Out of scope**:
- The `DOMAIN` constant and OpenFeature's global registry semantics (deferred — see Why this matters).
- `providers/flagship.ts` and other providers.
- Client hooks (`useFlag`/`useFlags`).

## Git workflow

- Branch: shared wave branch `improve/wave22-flags`.
- Commit: `fix(flags): key the client memo by definition and env`

## Steps

### Step 1: Replace the scalar with a two-level WeakMap

Mirror `notify.ts`'s `runtimeCache`/`runtimeFor` shape: `WeakMap<object, WeakMap<object, Promise<Client>>>`, keyed first by the definition/options identity `createFlags` receives, then by the `env` object. Keep the rejected-bind self-clear (delete the entry on rejection instead of clearing a scalar). Keep `resetFlags()` working: it must clear the whole cache — since WeakMaps aren't clearable, hold the cache in a `let` and reassign a fresh WeakMap in `resetFlags()` alongside the existing `OpenFeature.clearProviders()`.

Update the scalar's docstring to the new keying rationale (adapt notify's wording). Note in a comment that OpenFeature's registry is still global under one `DOMAIN` — the memo prevents *silent config discard*, not registry collision — and that a second distinct definition binding in one isolate now surfaces as a second `setProviderAndWait` on the same domain (last one wins in the registry): add a one-line `console.warn` when the cache holds a binding for a *different* definition key than the one being bound, so the collision is no longer silent. (Check how the package logs elsewhere first — if it has a logger convention, use it.)

**Verify**: `pnpm --filter "@lunora/flags" run test` → existing suite passes.

### Step 2: Tests

In the existing flags test file (find it: `ls packages/flags/__tests__/`), add: (a) two `createFlags` binds with different definition objects each get their own provider instance (spy on `provider()` factory invocations), (b) same definition + same env binds once (memo hit), (c) `resetFlags()` still clears (existing tests likely cover this — extend if not). Model on the existing bind/reset tests.

**Verify**: `pnpm --filter "@lunora/flags" run test` → all pass including the new cases.

## Test plan

As Step 2; existing suite green throughout.

## Done criteria

- [ ] `grep -n "let clientBinding" packages/flags/src/flags.ts` → no match (replaced by the keyed cache)
- [ ] `pnpm --filter "@lunora/flags" run test` exits 0 with the new tests
- [ ] `pnpm --filter "@lunora/flags" run lint:types` exits 0
- [ ] `pnpm run api:check` exits 0 (no public surface change expected; if the snapshot moves, api:update after a fresh build and include it)

## STOP conditions

- `createFlags`/`bindClient` callers do not have a stable definition or `env` object identity to key on (e.g. options are spread-rebuilt per call) — report the actual call shape instead of keying on something unstable.
- Fixing the memo requires touching the `DOMAIN`/registry behavior after all.

## Maintenance notes

- Deferred: per-definition OpenFeature domains (fixes the registry last-writer-wins for multi-definition isolates) — breaks external `OpenFeature.getClient("lunora")` readers; needs its own decision.
- Reviewer: check the `resetFlags` reassignment doesn't race an in-flight bind promise.

## REVISION (2026-08-21, after execution STOP)

The original single-file WeakMap fix is unimplementable: the only production
caller is codegen-emitted (packages/codegen/src/emit.ts:3031 and :3152, in the
per-request ctx builder) and builds the options object and provider closure
FRESH per request — there is no stable options identity to key on, and keying
on a per-request object degrades to one `OpenFeature.setProviderAndWait` per
request. The bug itself stands: the module-scalar memo means the FIRST
request's provider/logger/hooks win forever, and later definitions/envs are
silently ignored.

Revised scope — mirror notify's `runtimeFor` (packages/notify/src/notify.ts:111-129) end to end:

1. Change `createFlags` in packages/flags/src/flags.ts to accept the stable
   identities: `createFlags(definition, env, options)` where `definition` is
   the module-level flags config object (stable import identity per isolate)
   and `env` is the Worker env object. Memo:
   `WeakMap<definition, WeakMap<env, Promise<Client>>>`. DOMAIN stays the
   constant "lunora" (deferred as before); keep `resetFlags` for tests.
2. Update the two codegen emission sites (emit.ts:3031, :3152) to pass
   `flagsConfig` and `env` as the identity arguments, keeping the existing
   per-request provider closure semantics inside `options`.
3. Regenerate codegen golden fixtures (the emitted ctx builder changes) and
   update flags tests to the new signature.
4. In scope: packages/flags/src/flags.ts, packages/flags/__tests__/,
   packages/codegen/src/emit.ts, codegen golden fixtures + their regen script,
   any emit tests asserting the createFlags call shape. Branch:
   improve/wave22-flags. Breaking API change on alpha — record in commit body.
5. STOP conditions: if `flagsConfig`/`env` are not both in scope at the two
   emission sites; if any non-codegen production caller of `createFlags`
   exists (grep first); if fixture regen produces diffs beyond the createFlags
   call shape.
