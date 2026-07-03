# Plan 112: Add a Studio Containers observability page

> **Executor instructions**: Follow step by step; run each verify. STOP
> conditions halt you. Do NOT run the studio Vitest suite (jsdom hang in this
> sandbox) — verify with `lint:types`/`lint:eslint`. Update `plans/README.md` when
> done unless a reviewer owns it.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- packages/studio packages/container`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction (feature)
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

Containers are stateful, long-lived, and expensive — exactly the thing an admin UI
should show (which instances are up, on what ports, health). But the Studio has no
Containers surface: `use-studio-features.ts` toggles panels for analytics, auth,
flags, kv, mail, payments, queues, scheduler, storage, vectors, and workflows —
**no `ai`, `containers`, or `ratelimit`**. Container lifecycle events already flow
into the Studio (the container lifecycle envelope feeds the Studio Logs panel),
and per-instance metadata is attached "for metrics/observability" — so the data
exists; it just has no dedicated panel. A shipped runtime with observable state
and no admin surface is an asymmetry users notice. (Containers is the strongest of
the three missing features; AI and rate-limit panels are optional follow-ups.)

## Current state

Studio feature flags (`packages/studio/src/hooks/use-studio-features.ts:18-52`) —
the authoritative list; note the absence of `containers`:

```ts
const DEFAULT_STUDIO_FEATURES: StudioFeaturesResult = {
    analytics: true,
    auth: true,
    flags: true,
    kv: true,
    mail: true,
    payments: true,
    queues: true,
    scheduler: true,
    storage: true,
    vectors: true,
    workflows: true,
};
// coerceFeatures() mirrors the same keys.
```

Studio feature panels (`packages/studio/src/features/`): `advisors, analytics,
api, auth, data, database, flags, functions, home, kv, logs, payments,
permissions, queues, reports, schema, settings, sql, storage, vectors, workflows`
— no `containers`.

Container lifecycle events (`packages/container/src/lifecycle-event.ts:20-30`):

```
 * The single envelope feeds BOTH the terminal … and the best-effort push into
 * the ShardDO `LogBuffer` (the Studio Logs panel), so the two views can never diverge.
 */
interface ContainerLifecycleEvent {
    container: string;      // the lunora/containers.ts export name
    // … lifecycle transition + metadata …
}
```

Per-instance metadata is attached "for metrics/observability"
(`packages/container/src/types.ts:171`). Read `lifecycle-event.ts` +
`types.ts` in full to learn the exact event/instance shape the panel will render.

Studio codegen wiring: the feature flags are "discovered statically per
deployment" — codegen decides which features the app wires up, and the studio nav
filters on the result (`use-studio-features.ts` doc comment). So adding a
`containers` feature requires the **producer** of these flags (codegen /
`discover-feature-usage`) to emit `containers`, not just the studio to read it.
Read `packages/codegen/src/discover-feature-usage.ts` — note the `container`
package is NOT in `PROBES` today (the PROBES list shown in plan 106 has no
`container` entry). The panel's visibility depends on this signal.

How existing panels get their data: they use `useAdminQuery` against admin RPC
functions (`ADMIN_FUNCTIONS.*`) and/or a live subscription. The Containers panel
needs a data source — either a new admin RPC that lists running container
instances (+ ports/health from the metadata), or consumption of the lifecycle
event stream already in the LogBuffer. Determine which is feasible in Step 1.

## Commands you will need

| Purpose              | Command                                                  | Expected          |
| -------------------- | -------------------------------------------------------- | ----------------- |
| Read lifecycle event | `sed -n 1,80p packages/container/src/lifecycle-event.ts` | event shape       |
| Read container types | `sed -n 150,200p packages/container/src/types.ts`        | instance metadata |
| Typecheck studio     | `pnpm --filter "@lunora/studio" run lint:types`          | exit 0            |
| Lint studio          | `pnpm --filter "@lunora/studio" run lint:eslint`         | exit 0            |
| Typecheck codegen    | `pnpm --filter "@lunora/codegen" run lint:types`         | exit 0            |

**Do NOT run studio Vitest** (sandbox hang).

## Scope

**In scope**:

- `packages/studio/src/features/containers/` — a new read-only panel listing
  running container instances (name, port(s), health, lifecycle state) from the
  available data source.
- `packages/studio/src/hooks/use-studio-features.ts` — add a `containers` flag to
  `DEFAULT_STUDIO_FEATURES` + `coerceFeatures`.
- `packages/studio/src/app/studio.tsx` — register the panel/route (as a lazy route
  if plan 107 has landed; else eager, matching the current pattern) + a `TABS`
  entry + `StudioTab` union member.
- The feature-flag **producer** (`packages/codegen/src/discover-feature-usage.ts`
    - wherever `buildStudioFeatures` maps usage → studio flags) so `containers` is
      emitted when the app uses `@lunora/container`. Add a `container` PROBE.
- A data source: consume the lifecycle events already in the LogBuffer, OR a small
  new admin RPC that lists instances. Prefer reusing the existing event stream if
  it carries enough (see Step 1).

**Out of scope**:

- AI and rate-limit panels (optional follow-ups — note them).
- Any container runtime change (`@lunora/container` behavior) — the panel is
  read-only over data already emitted.
- Container actions (start/stop/restart) — read-only observability only.

## Git workflow

- Branch: `advisor/112-studio-containers-page`
- Commit(s): `feat(codegen): emit the containers studio feature flag` + `feat(studio): containers observability panel`.
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Determine the data source

Read `lifecycle-event.ts` + `types.ts`. Decide:

- **Option A**: the lifecycle events in the ShardDO `LogBuffer` already carry
  enough (name, transition, port, metadata) to render a "current instances" view
  by folding the event stream. If so, the panel subscribes to (or queries) that
  stream and reduces it to current state — no new RPC.
- **Option B**: if the events are transitions without a queryable "current
  instances" snapshot, add a small admin RPC (`listContainers`) that returns live
  instances + metadata, mirroring how other admin reads are registered (grep for
  an existing `ADMIN_FUNCTIONS` registration to copy).

Prefer A. Document the choice.

**Verify**: you can name the exact data source + shape the panel renders.

### Step 2: Emit the `containers` feature flag from codegen

Add a `container` entry to `PROBES` in
`packages/codegen/src/discover-feature-usage.ts` (module specifier
`@lunora/container`, and/or the `ctx.containers` context property — check the
`CLAUDE.md` container notes: typed `ctx.containers` is the signal). Wire the usage
result into the studio feature flags (`buildStudioFeatures`) so `containers` is
`true` when the app uses containers. Add `containers` to the studio's
`StudioFeaturesResult`/`DEFAULT_STUDIO_FEATURES`/`coerceFeatures`.

**Verify**: `pnpm --filter "@lunora/codegen" run test` → golden tests pass
(feature detection changed — confirm the goldens reflect the new flag only when
containers are used; a no-container app's flags must be byte-identical except the
new key defaulting appropriately). `pnpm --filter "@lunora/studio" run lint:types`
→ exit 0.

### Step 3: Build the panel

Create `packages/studio/src/features/containers/containers-panel.tsx` modeled on
an existing simple read-only panel (e.g. the queues or scheduler panel — read one
for the `useAdminQuery` + table/list rendering conventions, loading/empty/error
states, and i18n usage). Render instances: name, port(s), health/lifecycle state,
last transition. Read-only.

**Verify**: `pnpm --filter "@lunora/studio" run lint:types` +
`run lint:eslint` → exit 0.

### Step 4: Register the route + nav

Add a `StudioTab` union member, a `TABS` entry, the panel to the `panels` map (or
a lazy route if plan 107 landed), and gate its nav visibility on the `containers`
feature flag (matching how other feature-gated tabs are hidden).

**Verify**: `pnpm --filter "@lunora/studio" run lint:types` +
`run lint:eslint` → exit 0.

## Test plan

- Studio jsdom component tests are NOT runnable here. Gates:
    - `pnpm --filter "@lunora/codegen" run test` (golden feature-flag output) passes.
    - `pnpm --filter "@lunora/studio" run lint:types` + `run lint:eslint` pass.
- If the data-source reducer (Option A) is extractable as a pure function
  (event stream → current instances), add a plain Vitest unit test for it
  (non-jsdom) covering: instance up, instance down/removed, port/health parsing.
- Verification: codegen tests + studio lint:types/eslint pass; any pure-function
  reducer test passes.

## Done criteria

- [ ] Codegen emits a `containers` studio feature flag when the app uses `@lunora/container`; no-container apps' generated output is unchanged except the flag defaulting.
- [ ] The studio has a read-only Containers panel showing live instances (name, port(s), health/state), gated on the `containers` feature.
- [ ] `pnpm --filter "@lunora/codegen" run test` passes (goldens); studio `lint:types` + `lint:eslint` pass.
- [ ] `git status` shows only in-scope files.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The lifecycle events do NOT carry enough to render a useful "current instances"
  view AND adding a `listContainers` admin RPC requires container-runtime changes
  (not just a read) — STOP and report; a panel that shows only sparse log-derived
  data may not be worth it, or the RPC scope is bigger than this plan.
- Adding the `container` PROBE changes unrelated golden output — reconcile until
  only the intended flag changes; if it can't be isolated, STOP.
- The container package's typed `ctx.containers` / metadata shape doesn't actually
  expose ports/health (the DIR evidence said metadata is "for metrics/
  observability" — confirm it includes what the panel needs) — if it only has
  opaque metadata, scope the panel to what's actually available and note the gap.

## Maintenance notes

- Optional follow-ups (noted, not in scope): an AI-usage panel and a
  rate-limit bucket/deny-list panel, each behind its own feature flag — same
  read-only pattern.
- A reviewer should manually smoke-test the panel in a dev studio with a
  container-using app (the sandbox can't), confirming instances render and the tab
  hides for non-container apps.
- If plan 107 (studio code-splitting) lands, register this panel as a lazy route,
  not an eager entry.
