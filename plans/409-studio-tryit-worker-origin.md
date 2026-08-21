# Plan 409: Send the studio try-it REST request to the worker origin with the admin bearer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/studio/src/features/api/openapi/run-context.tsx packages/studio/src/app/app.tsx`
> On any change, compare the "Current state" excerpts against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The API try-it console has two dispatch branches. RPC operations go through the `LunoraClient` (worker origin + admin token). Plain REST routes (`httpRouter()` operations, no `functionPath`) do a bare same-origin `fetch(operation.httpPath, …)` with no Authorization header. Under `lunora dev`, the CLI studio server answers **every** non-`/_lunora/*` path with the SPA document as a 200 (history fallback), so pressing "Send" on any REST route renders the studio's own HTML in the response panel as a *successful* response — silently wrong. Under the Vite host the request reaches the app but unauthenticated, so guarded routes 401.

## Current state

- `packages/studio/src/features/api/openapi/run-context.tsx:97-114` — the REST branch:
  ```tsx
  if (operation.functionPath === undefined) {
      // Plain REST route: best-effort fetch of the path with a JSON body.
      const hasBody = operation.method !== "GET" && operation.method !== "HEAD";
      const fetchResponse = await fetch(operation.httpPath, {
          body: hasBody ? JSON.stringify(parsedArgs) : undefined,
          headers: hasBody ? { "content-type": "application/json" } : undefined,
          method: operation.method,
      });
  ```
  The RPC branch below (`dispatchByKind(client, …)`) uses the mounted client.
- `packages/cli/src/util/studio-server.ts:301-308` — the catch-all: `sendAsset(response, document, "text/html; charset=utf-8")` for anything that isn't a static asset or `/_lunora/*`.
- The worker origin and token exist at app level: `packages/studio/src/app/app.tsx:155-190` — `StudioApp` computes `const origin = resolveOrigin(baseUrl)` (`:188`) and holds the admin token in `token`/`debouncedToken` state (`:158`), constructing `new LunoraClient({ url: origin, … })` (`:190`).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/studio..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/studio" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/studio" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/studio" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/studio/src/features/api/openapi/run-context.tsx`
- `packages/studio/src/app/app.tsx` and any provider file needed to thread `origin` + token down (smallest seam wins — check first whether an existing context already carries them: `grep -rn "resolveOrigin\|createContext" packages/studio/src/app packages/studio/src/features/api | head`)
- `packages/studio/__tests__/` (one new test)

**Out of scope**:
- `packages/cli/src/util/studio-server.ts` — the SPA fallback is correct for the router; do not special-case try-it paths server-side.
- The RPC branch of `run-context.tsx`.

## Git workflow

- Branch: `improve/wave22-studio`
- Commit: `fix(studio): dispatch try-it rest calls to the worker`

## Steps

### Step 1: Thread the worker origin + admin token to the try-it context

Find the least invasive existing seam (an app-level context/provider the API feature already consumes). If none exists, extend the props/context that already deliver the `client` to `run-context.tsx` with `{ origin: string; adminToken: string | undefined }` computed in `app.tsx` from the same `resolveOrigin(baseUrl)` / `debouncedToken` values used at `:188-190`.

**Verify**: `pnpm --filter "@lunora/studio" run lint:types` → exit 0.

### Step 2: Use them in the REST branch

Change the REST fetch to `fetch(new URL(operation.httpPath, origin), { … })` and add `Authorization: Bearer ${adminToken}` when a token is set (merge with the existing content-type header object). When `origin` is unresolvable (empty), keep the current same-origin behaviour.

**Verify**: `pnpm --filter "@lunora/studio" run test` → pass.

### Step 3: Test

Add a test next to the existing try-it/run-context tests (find them: `grep -rln "run-context\|try-it" packages/studio/__tests__ packages/studio/src --include="*.test.*"`) stubbing `fetch` and asserting: REST operation dispatch calls the stub with (a) an absolute URL on the worker origin, and (b) the bearer header when a token is present, (c) no Authorization header when the token is empty.

**Verify**: `pnpm --filter "@lunora/studio" run test` → all pass including the new one.

## Test plan

- The 3-assertion fetch-stub test above; model on whatever existing test already renders the run-context provider (or unit-test the extracted request-building function if the executor extracts one — extraction is allowed inside `run-context.tsx`).

## Done criteria

- [ ] `pnpm --filter "@lunora/studio" run test` exits 0 with the new test
- [ ] `pnpm --filter "@lunora/studio" run lint:types` and `lint:eslint` exit 0
- [ ] `grep -n "await fetch(operation.httpPath," packages/studio/src/features/api/openapi/run-context.tsx` → no match (the relative-URL form is gone)
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The "Current state" excerpts don't match the live code.
- Threading origin/token requires touching more than 3 files — report the seam problem instead of building a new global store.
- React lint gates (`react-x`: no setState-in-effect, no impure render) reject the approach — restructure per the lint's guidance, and STOP if that forces architectural change.

## Maintenance notes

- If the studio ever gains per-request auth schemes for REST routes (cookies, custom headers), this branch is where they attach.
- Reviewer: confirm the Authorization header is NOT sent when the worker origin equals an untrusted third-party origin (it can't today — origin comes from `baseUrl` config — but check no user-controlled URL reaches this fetch).
