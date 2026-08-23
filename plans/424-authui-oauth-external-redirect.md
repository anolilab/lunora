# Plan 424: Route the OAuth consent redirect through the browser, not the framework router

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. Your reviewer maintains
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/auth-ui/src/core/oauth-provider.ts packages/auth-ui/src/core/redirect-to.ts packages/auth-ui/src/core/default-nav.ts`
> NOTE: the main checkout has uncommitted auth-ui edits from a concurrent
> session. You work in a fresh worktree from HEAD (what this plan was written
> against) — on ANY reported drift, compare the excerpts; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

After an OAuth consent decision, `oauth-provider.ts` navigates to `response.data?.redirectURI` — the third-party client's **absolute callback URL carrying the authorization code** — via `context.nav.replace(redirect)`. `NavAdapter` is documented as the meta-framework router bridge (`config.ts:24-27`: "Next passes `router.push`/`replace`, react-router its `navigate`, SvelteKit `goto`"). SvelteKit's `goto` rejects external URLs outright; vue-router and Solid's router resolve a string as an in-app path. So with the zero-config `defaultNav` (`location.replace`) consent works, but the moment an app wires its router — which the provider docs tell it to — approving consent either throws or navigates in-app, and the authorization code never reaches the relying party. Every other `nav.replace` call site in `core/` passes an in-app path; `oauth-provider.ts` is the sole off-origin one.

## Current state

All excerpts from committed HEAD:

- `packages/auth-ui/src/core/oauth-provider.ts:97-110` (`decide`):
    ```ts
    const response = assertOk(await context.authClient.oauth2.consent({ accept }));
    const redirect = response.data?.redirectURI;
    if (redirect === undefined || redirect === "") { …consentExpired error…; return; }
    store.update({ status: "success" });
    context.nav.replace(redirect);
    ```
- `packages/auth-ui/src/core/config.ts:28-31` — `NavAdapter { navigate(to); replace(to); }`, documented as the router bridge.
- `packages/auth-ui/src/core/default-nav.ts` — the fallback drives `globalThis.location.assign/replace`.
- The in-app-path test that already exists — `packages/auth-ui/src/core/redirect-to.ts:38-51` `isSafeRedirect(target)`: true only for a same-origin _path_ (rejects absolute URLs, `//host`, `/\` variants, control chars).

## Commands you will need

| Purpose       | Command                                             | Expected on success                             |
| ------------- | --------------------------------------------------- | ----------------------------------------------- |
| Install       | `pnpm install`                                      | exit 0                                          |
| Tests         | `pnpm --filter "@lunora/auth-ui" run test`          | all pass                                        |
| Typecheck     | `pnpm --filter "@lunora/auth-ui" run lint:types`    | exit 0                                          |
| Lint          | `pnpm --filter "@lunora/auth-ui" run lint:eslint`   | exit 0                                          |
| Registry sync | `pnpm --filter "@lunora/auth-ui" run sync:registry` | exit 0                                          |
| Registry gate | `pnpm run lint:registry:sync`                       | exit 0                                          |
| API gate      | `pnpm run build:packages && pnpm run api:check`     | exit 0 (`api:update` only for intended changes) |

## Scope

**In scope**:

- `packages/auth-ui/src/core/oauth-provider.ts`
- A small helper in `core/` (new function; put it in `redirect-to.ts` next to `isSafeRedirect` rather than a new file)
- The oauth-provider core test file
- `registry/auth-ui-*/` via `sync:registry` only

**Out of scope**:

- `NavAdapter`'s interface/contract and every other `nav.replace`/`nav.navigate` call site — they pass in-app paths and are correct.
- `isSafeRedirect` itself — reuse, don't modify.

## Git workflow

- Branch: shared wave branch `improve/wave22-auth-ui`.
- Commit: `fix(auth-ui): browser-navigate external consent redirect`

## Steps

### Step 1: Add `externalNavigate` next to `isSafeRedirect`

In `redirect-to.ts`, export a helper that routes a target through the framework nav only when it is an in-app path:

```ts
/**
 * Navigate to `target` — through the app router when it is a same-origin
 * path, else through the browser directly. A framework router (SvelteKit
 * `goto`, vue-router, …) cannot perform an off-origin navigation, and the
 * OAuth consent redirect is an absolute third-party URL by design.
 */
const navigateTo = (nav: NavAdapter, target: string): void => {
    if (isSafeRedirect(target)) {
        nav.replace(target);
        return;
    }
    globalThis.location.assign(target);
};
```

(Exact name/shape: match the file's existing export style; named export only.)

### Step 2: Use it in `decide`

Replace `context.nav.replace(redirect)` with the helper. Nothing else in the function changes.

**Verify**: `pnpm --filter "@lunora/auth-ui" run lint:types` → exit 0.

### Step 3: Tests

In the oauth-provider core test file (model on its existing `decide` tests): stub consent to return an absolute `https://client.example/cb?code=…` and assert the framework nav was NOT called and `location.assign` was (stub `globalThis.location` the way existing tests do — check `redirect-to` tests for the pattern); a second case with a relative `/done` path asserts the framework nav IS used.

**Verify**: `pnpm --filter "@lunora/auth-ui" run test` → all pass including 2 new tests.

### Step 4: Registry sync + gates

`sync:registry` → `pnpm run lint:registry:sync` → exit 0; API gate per table.

## Test plan

Covered in Step 3 (absolute-URL and in-app-path cases).

## Done criteria

- [ ] `decide` no longer passes the consent `redirectURI` straight to `nav.replace` (read the diff)
- [ ] `pnpm --filter "@lunora/auth-ui" run test` exits 0 with the 2 new tests
- [ ] `lint:types` + `lint:eslint` + `pnpm run lint:registry:sync` exit 0
- [ ] No files outside scope modified

## STOP conditions

- Drift check reports in-scope changes and live code no longer matches the excerpts.
- `location` stubbing is impossible in this test setup (jsdom navigation) — report the pattern the suite needs rather than skipping the assertion.

## Maintenance notes

- Any future flow that receives a server-provided absolute redirect (e.g. SSO logout) must use the same helper; reviewer should grep new `nav.replace(` sites for server-provided values.
