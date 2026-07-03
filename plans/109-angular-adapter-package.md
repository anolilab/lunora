# Plan 109: Ship a first-class `@lunora/angular` reactive adapter

> **Executor instructions**: This is a new-package feature plan with a clear
> reference implementation (the Analog template's hand-rolled service). Follow
> step by step; run each verify. STOP conditions halt you. Update `plans/README.md`
> when done unless a reviewer owns it.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- templates/analog packages/solid packages/svelte`

## Status

- **Priority**: P2
- **Effort**: M–L
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction (feature)
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

Lunora ships reactive client adapters for React, Vue, Solid, and Svelte — but not
Angular. The shipped Analog (Angular) template hand-rolls a `LunoraService`
bridging the vanilla `LunoraClient` to Angular signals, with a comment that says
verbatim: _"there is no `@lunora/angular` adapter, so this service is the bridge…
Swap this for a real `@lunora/angular` adapter once one ships; the component API…
is deliberately small so the migration is mechanical."_ This is a CRUD-minus-one
on the adapter set and a promise already made in shipped code. The template's
service is the reference implementation and the desired API.

## Current state

The reference implementation (`templates/analog/src/app/lunora.service.ts`, 55
lines — read it in full). Key surface:

```ts
@Injectable({ providedIn: "root" })
export class LunoraService {
    private readonly client = new LunoraClient({ url: globalThis.location?.origin ?? "" });

    public liveQuery<F extends FunctionReference>(reference: F, args: ArgsOf<F>, options: { shardKey?: string } = {}): Signal<ReturnOf<F> | undefined> {
        const value = signal<ReturnOf<F> | undefined>(undefined);
        const unsubscribe = this.client.subscribe(reference, args, (next) => value.set(next), options);
        inject(DestroyRef).onDestroy(unsubscribe);
        return value.asReadonly();
    }

    public async mutate<F extends FunctionReference>(reference: F, args: ArgsOf<F>, options: { shardKey?: string } = {}): Promise<ReturnOf<F>> {
        return this.client.mutation(reference, args, options);
    }
}
```

The structurally closest existing adapters (signal/store based) — model the
package after these, especially `@lunora/solid`:

- `packages/solid/src/` — `context.ts`, `create-query.ts`, `create-mutation.ts`,
  `create-subscription.ts`, `create-connection-status.ts`, `create-presence.ts`,
  `create-paginated-query.ts`, `create-mutator.ts`, `create-rate-limit.ts`,
  `create-flag.ts`, `create-auth.tsx`, `lunora-provider.tsx`, `hydrate-preloaded.ts`,
  `index.ts` (named exports only).
- `packages/solid/src/create-query.ts` shows the reactive-subscription pattern
  (subscribe → signal → teardown on cleanup), which maps directly onto Angular's
  `signal` + `DestroyRef.onDestroy`.

Package conventions (from `CLAUDE.md` + a sibling `package.json`): ESM
(`"type": "module"`), `"sideEffects": false`, conditional exports, `tsconfig`
extends `../../tsconfig.base.json`, `project.json` with vis tags (`type:package`,
`category:client`), `.releaserc.json` extending the preset, `__tests__/` Vitest.
Angular is a peer dependency (do not bundle it). The client dep is
`@lunora/client` (+ `@lunora/client/query` subpath, per solid's imports).

**Scaffolding**: use `vis generate lunora-package --name=angular
--description='…'` to create the workspace skeleton (per `CLAUDE.md`), then fill
it in. **Remember**: a new internal package 404s on install until added to
`overrides` in `pnpm-workspace.yaml` (`"@lunora/angular": "workspace:*"`) — see
the repo memory `project-new-package-pnpm-overrides`.

## Commands you will need

| Purpose              | Command                                                                                          | Expected                    |
| -------------------- | ------------------------------------------------------------------------------------------------ | --------------------------- |
| Scaffold the package | `vis generate lunora-package --name=angular --description='Angular reactive adapter for Lunora'` | creates `packages/angular/` |
| Build (deps)         | `pnpm --filter "@lunora/angular..." run build`                                                   | exit 0                      |
| Typecheck            | `pnpm --filter "@lunora/angular" run lint:types`                                                 | exit 0                      |
| Test                 | `pnpm --filter "@lunora/angular" run test`                                                       | all pass                    |
| Lint                 | `pnpm --filter "@lunora/angular" run lint:eslint`                                                | exit 0                      |

If install fails with a 404 on `@lunora/angular`, add it to `overrides` in
`pnpm-workspace.yaml` and re-install.

## Scope

**In scope**:

- New `packages/angular/` package: an injectable Lunora client provider +
  signal-based `liveQuery` (query subscription), `mutate`, and — for parity —
  connection status and presence if cheap. Minimum viable surface: provider +
  `liveQuery` + `mutate` (matches the template). Parity extras (paginated query,
  mutator/optimistic, rate-limit, flags, auth) are desirable but can be phased —
  ship the core first.
- `pnpm-workspace.yaml` — add the `overrides` entry.
- Repoint `templates/analog` at the new package (replace the hand-rolled service
  with the adapter; keep the template's component API working).
- `__tests__/` for the adapter.

**Out of scope**:

- Full feature parity with React on day one (paginated/optimistic/auth can be a
  follow-up if the core lands clean — note it).
- SSR/Analog-server-specific helpers beyond what the template needs.
- Changing `@lunora/client`.

## Git workflow

- Branch: `advisor/109-angular-adapter-package`
- Commit(s): `feat(angular): reactive Lunora adapter package` + `refactor(templates): use @lunora/angular in the analog template`.
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Scaffold + wire the workspace

Run the `vis generate lunora-package` command. Add `@lunora/angular:
"workspace:*"` to `pnpm-workspace.yaml` `overrides`. Set Angular as a peer dep,
`@lunora/client` as a dep. Set the `project.json` tags
(`type:package`, `category:client`). Install.

**Verify**: `pnpm --filter "@lunora/angular" run lint:types` → exit 0 (empty
package type-checks).

### Step 2: Implement the core adapter

Lift the template's `LunoraService` into the package, generalizing:

- A provider/injectable that owns one `LunoraClient` (configurable URL, defaulting
  to same-origin like the template).
- `liveQuery(ref, args, { shardKey? })` → read-only `Signal`, torn down on
  `DestroyRef.onDestroy`. Support the `"skip"` sentinel if the other adapters do
  (check `@lunora/solid`'s `create-query` — it supports `"skip"`); mirror that.
- `mutate(ref, args, opts)` → Promise.
- Optionally `connectionStatus()` signal (mirror solid's
  `create-connection-status`).

Follow: named exports only, no `.js` extensions, `sideEffects: false`.

**Verify**: `pnpm --filter "@lunora/angular" run lint:types` → exit 0.

### Step 3: Tests

Add `__tests__/` covering `liveQuery` (subscribes, updates the signal on a
delta, tears down on destroy) and `mutate` (calls the client). Mock
`LunoraClient` (or use a fake) as the other adapters' tests do — read
`packages/solid/__tests__` for the mocking pattern. Angular signal testing may
need `@angular/core/testing`; keep tests light (unit-level, no full component
harness) if the full Angular test setup is heavy.

**Verify**: `pnpm --filter "@lunora/angular" run test` → all pass.

### Step 4: Repoint the Analog template

Replace `templates/analog/src/app/lunora.service.ts`'s hand-rolled body with a
thin consumer of `@lunora/angular` (or delete it and use the adapter directly in
components). Keep the template's component-facing API identical so existing
template code compiles. Add `@lunora/angular` to the template's `package.json`.

**Verify**: the template's TypeScript still type-checks against the new adapter
(if the template can be type-checked in the sandbox; else confirm the imports
resolve and the surface matches).

## Test plan

- `packages/angular/__tests__/` — `liveQuery` and `mutate` unit tests with a
  mocked client, modeled on `packages/solid/__tests__`.
- Verification: `pnpm --filter "@lunora/angular" run test` + `run lint:types` +
  `run lint:eslint` exit 0.

## Done criteria

- [ ] `packages/angular/` builds, type-checks, lints, and tests green.
- [ ] The package exports at minimum a provider + `liveQuery` (signal) + `mutate`, with subscription teardown on component destroy.
- [ ] `pnpm-workspace.yaml` `overrides` includes `@lunora/angular`.
- [ ] `templates/analog` uses `@lunora/angular` (the hand-rolled service is gone or reduced to a thin re-export), and the template still compiles.
- [ ] `git status` shows only the new package, the workspace file, and the analog template.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- Angular signal APIs (`signal`, `DestroyRef`, `inject`) require an injection
  context that the adapter can't reliably provide outside a component/service —
  if `liveQuery` can't be called from a plain service the way the template does,
  STOP and report the Angular-context constraint (it may need to stay a service
  the app provides, shaping the API differently).
- Setting up the Angular peer dep / test harness balloons install or CI time
  significantly — note it and scope tests down, but if it blocks the build, STOP.
- The `vis generate lunora-package` template produces a skeleton that conflicts
  with an Angular package's needs (e.g. Angular's own build tooling) — reconcile
  or report; do not fight the generator into a broken state.

## Maintenance notes

- Parity follow-ups (deferred): paginated query, optimistic mutator, rate-limit,
  flags, auth composables — add them to match React/Solid once the core is proven.
- A reviewer should confirm subscription teardown is correct (no leaked
  WebSocket subscriptions when components are destroyed) — that is the main
  correctness risk in a reactive adapter.
- Keep the adapter's API aligned with the other framework adapters' naming where
  it makes sense, so cross-framework docs stay coherent.
