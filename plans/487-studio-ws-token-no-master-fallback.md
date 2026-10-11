# Plan 487: Remove the master-token WebSocket fallback and the query-string opt-out

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat dcffa4d73..HEAD -- packages/studio/src/lib packages/studio/src/app/app.tsx packages/do/src/shard-do.ts packages/runtime/src/create-worker.ts shared/ws-admin-token.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `dcffa4d73`, 2026-10-11

## Why this matters

The master admin token (`LUNORA_ADMIN_TOKEN`) gates every `/_lunora/admin/*` route. On alpha it is still sent in a WebSocket URL in two situations, and both put it where it leaks:

- **Studio fallback.** When the worker answers the ws-token mint call with 404 or 405, the studio's token provider returns the master token itself, and the client appends it as `?token=<master>`. A 404 or 405 is exactly what a proxy or CDN returns for an unknown POST, so this is reachable without an old worker. The request line is logged by every proxy, CDN and access log on the path before the worker can reject it, and it lands in browser history and `Referer` headers.
- **Server opt-out.** Both the worker and the shard DO accept a raw master token in `?token=` when `LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN` is set to `0`/`false`/`off`/`no`/`disabled`. The default is to reject it, but the opt-out is a documented way to put the master credential into URLs.

The server-side rejection stops the socket from opening. It does not stop the request line from being logged. The fix is to delete the master-in-URL paths entirely on alpha: the studio stops falling back, and the server stops accepting the master in the query string. The scoped credential that remains in the URL is the 60-second HMAC sub-token minted by `POST /_lunora/admin/ws-token`.

## Current state

**The studio's URL construction and fallback**

- `packages/client/src/lunora-client.ts:2553` appends the resolved credential: `const url = token === undefined ? base : \`${base}?token=${encodeURIComponent(token)}\`;`. The same shape is at `:5394`in`wsUrlFor`.
- `packages/studio/src/lib/ws-token-provider.ts:84-90` is the fallback:

    ```ts
    // A pre-095 worker has no mint route: fall back to the master token
    // (the old behavior) and remember the miss so reconnects don't re-probe.
    if (response.status === 404 || response.status === 405) {
        endpointMissing = true;
        return adminToken;
    }
    ```

- `packages/studio/src/lib/ws-token-provider.ts:109-111` returns the master on every later connect while the latch is set: `if (endpointMissing) { return adminToken; }`.
- `packages/studio/src/lib/ws-token-provider.ts:125-137` (`invalidate`) clears the latch on rotation. Its comment says leaving it set "pinned the WS credential to the MASTER admin token".
- `packages/studio/src/app/app.tsx:185-186` wires the provider in: `createAdminWsTokenProvider({ adminToken: debouncedToken, baseUrl: origin })` and `new LunoraClient({ url: origin, wsToken: provider.getToken })`.

**Server acceptance (two independent gates; both must change)**

- Worker: `packages/runtime/src/create-worker.ts:2652-2676` (`checkAdminWsToken`). It reads `?token=` at `:2657`, accepts a sub-token at `:2663`, and then accepts the raw master at `:2676`: `return constantTimeEqual(expected, supplied);`. The opt-out is read from the `requireEphemeralWsToken` option (`:1336`, public type) and from the env (`:2942`, `:2960-2965`). `:3864` and `:4332` call it.
- Durable Object: `packages/do/src/shard-do.ts:13761` reads `?token=` in `suppliedWsToken`. `isAdminSocket` at `:13795-13808` reads the opt-out at `:13802` (`isEnvFlagEnabled(env.LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN, true)`) and accepts the raw master at `:13808`: `return constantTimeEqual(supplied, adminToken);`.
- Shared helper: `shared/ws-admin-token.ts:60` (`isEnvFlagEnabled`), exported at `:168`. Its only importers are the two gates above.

**Documentation that describes the opt-out**

- `apps/docs/src/content/docs/production-checklist.mdx:57` and `:69` describe `LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN` as a knob.
- `api-snapshots/runtime.api.md:2298` lists `requireEphemeralWsToken?: boolean;`.

**Tests that pin the fallback and the opt-out**

- `packages/studio/__tests__/lib/ws-token-provider.test.ts:104` ("falls back to the master token on a 404"), `:118` (the `invalidate()` latch case), and `:142` (non-404 throws; keep as-is).
- `packages/do/__tests__/shard-do.admin-subscription.test.ts`, `packages/runtime/__tests__/ws-admin-token.test.ts`, `packages/runtime/__tests__/scheduled-admin.test.ts`. Each has cases that set the opt-out and expect a raw master in `?token=` to be admitted.

**Credentials that are NOT in scope**

- `Authorization: Bearer <master>` on a WS upgrade. Browsers cannot set it, so it never rides a URL, and it stays valid on both gates.
- `examples/expo/src/server/index.ts:89-92` rewrites a `?token=` into an `Authorization` header for a user bearer. It is not the admin credential. Leave it alone.

**No first-message auth exists.** `packages/client/src/lunora-client.ts` has no auth frame for a socket. A ticket or first-message design would be a new protocol, so it is a deferred follow-up (see Maintenance notes), not part of this plan.

## Commands

| Purpose                   | Command                                                                              | Expected on success                                       |
| ------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Build deps                | `pnpm run build:packages` (or `pnpm --filter "@lunora/do..." run build`)             | exit 0                                                    |
| Clear shared-helper cache | `pnpm run build:packages --no-cache` after any edit to `shared/`                     | exit 0                                                    |
| Studio tests              | `pnpm --filter "@lunora/studio" run test`                                            | all pass                                                  |
| Runtime tests             | `pnpm --filter "@lunora/runtime" run test`                                           | all pass                                                  |
| DO tests                  | `pnpm --filter "@lunora/do" run test`                                                | all pass                                                  |
| Durable Object gate       | `pnpm run test:workerd`                                                              | exit 0 (mandatory: touches `shard-do.ts`)                 |
| Public API                | `pnpm run build:packages && pnpm run api:check`                                      | exit 0 (`api:update` only if drift is in `runtime` alone) |
| Lint                      | `pnpm --filter "@lunora/studio" run lint:eslint` and the same for `runtime` and `do` | exit 0                                                    |
| Types                     | `pnpm --filter "@lunora/studio" run lint:types` and the same for `runtime` and `do`  | exit 0                                                    |

If a script name differs, `pnpm --filter "<pkg>" run` lists them. Do not guess.

## Scope

**In scope** (the only files you should modify):

- `packages/studio/src/lib/ws-token-provider.ts`
- `packages/studio/__tests__/lib/ws-token-provider.test.ts`
- `packages/studio/src/app/app.tsx` (only if a call-site comment needs updating)
- `packages/do/src/shard-do.ts` (`isAdminSocket`, `suppliedWsToken` only if it has a master-query branch, the docstring at `:13690-13782`)
- `packages/do/__tests__/shard-do.admin-subscription.test.ts`
- `packages/runtime/src/create-worker.ts` (`checkAdminWsToken`, the `requireEphemeralWsToken` option at `:1336`, the env capture at `:2942` and `:2960-2965`, and the doc comments)
- `packages/runtime/__tests__/ws-admin-token.test.ts`
- `packages/runtime/__tests__/scheduled-admin.test.ts`
- `shared/ws-admin-token.ts` (delete `isEnvFlagEnabled` only if Step 1 confirms no other importer)
- `api-snapshots/runtime.api.md` (regenerate after the build)
- `apps/docs/src/content/docs/production-checklist.mdx` (remove the opt-out paragraph, lines around `:57` and `:69`)

**Out of scope** (do NOT touch):

- The `Authorization: Bearer` path on both gates.
- The ephemeral sub-token mint (`POST /_lunora/admin/ws-token`) and its HMAC verify (`verifyWsAdminToken`, `mintWsAdminToken`).
- `examples/expo/src/server/index.ts` (user bearer, not admin).
- `packages/client/src/lunora-client.ts`. The client correctly appends whatever `wsToken` resolves to. Changing the provider is the fix.
- Studio locale strings `packages/studio/src/app/studio.tsx:543` and `packages/studio/src/locales/en.ts:506` ("Token rides the WebSocket URL…"). That copy describes the ephemeral token, which still rides the URL. Rewording it touches the locale catalog and is a separate change.
- `plans/135-stable-1.0-roadmap.md`. It is a historical plan.

## Git workflow

- Branch: `advisor/487-studio-ws-token`, branched from `alpha`.
- One commit. Subject: `fix(studio): never send the master admin token in a WebSocket URL`.
- The commit body must say this is a breaking change on alpha:
    - `LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN` and the `requireEphemeralWsToken` option are removed. A raw master token in `?token=` is always rejected.
    - The studio no longer falls back to the master token on a 404 or 405 from the mint endpoint. It fails the connect and retries with backoff. A worker without `/_lunora/admin/ws-token` cannot be used with the studio.
- Wrap body lines at 100 characters.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the caller set before editing

Run:

```bash
grep -rn "LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN\|requireEphemeralWsToken\|isEnvFlagEnabled" . --include="*.ts" --include="*.tsx" --include="*.md" --include="*.mdx" --include="*.json*" --include="*.toml" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git
grep -rn "wsToken\|setWsToken" packages apps examples templates tests sdks --include="*.ts" --include="*.tsx" | grep -v __tests__ | grep -v node_modules | grep -v /dist/
```

Expected: the hits match the "Current state" list. Any new hit under `templates/`, `sdks/`, `examples/` or `apps/` that passes the admin token as a plain string `wsToken` or sets the opt-out is a STOP condition (see below).

**Verify**: record the output in the commit body only as a short list. Confirm that `examples/expo` is the only first-party caller that rewrites `?token=`, and that it is not the admin credential.

### Step 2: Write the failing tests first

1. **Studio, 404 is an error.** In `packages/studio/__tests__/lib/ws-token-provider.test.ts`, change the case at `:104` to: a 404 mint response makes `getToken()` reject, and the fetch spy is never asked to return the master token. A second call re-probes the mint endpoint and does not return the master string. Use `expect.assertions(n)`.
2. **Studio, 405 is an error.** Same as case 1 with a 405.
3. **Studio, `invalidate()` no longer clears a latch.** Remove the latch-specific case at `:118`. Replace it with: after a 404 rejection, `invalidate()` then a successful mint returns the minted token (the cache is cleared, but no master-token memory exists).
4. **Worker, master in the query is always rejected.** In `packages/runtime/__tests__/ws-admin-token.test.ts`, the cases that set `requireEphemeralWsToken: false` or `LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN=off` now expect the upgrade to be refused when the only credential is the raw master in `?token=`. The `Authorization: Bearer <master>` header case still passes.
5. **DO, master in the query is always rejected.** In `packages/do/__tests__/shard-do.admin-subscription.test.ts`, the opt-out cases expect `isAdminSocket` to return `false` for a raw master in `?token=`, whatever the env says. A minted sub-token in `?token=` still returns `true`.
6. **Scheduled admin.** In `packages/runtime/__tests__/scheduled-admin.test.ts`, drop the opt-out branch and assert the same as case 4.

**Verify**: run `pnpm --filter "@lunora/studio" run test -- ws-token-provider`, then the runtime and do tests for these files. The new and flipped cases must **fail** on alpha. A case that passes before the change is not testing the new behaviour; fix the test before continuing.

### Step 3: Remove the studio fallback

In `packages/studio/src/lib/ws-token-provider.ts`:

1. Delete `endpointMissing` and every read or write of it, including the `invalidate()` latch clear at `:137`.
2. Replace the 404/405 branch at `:86-90` with a throw that names the cause. For example: `throw new Error("ws-token mint endpoint is missing: this worker predates the ephemeral admin WS token")`. Do not return `adminToken`.
3. Remove the `if (endpointMissing) { return adminToken; }` block at `:109-111`.
4. Update the module docstring at `:1-26` and the `getToken` doc at `:49`. Remove the sentences about falling back to the master token and the 404 memory. Keep the rest of the caching contract.

Keep the `Authorization: Bearer ${adminToken}` header on the mint request. It is the only place the master token belongs.

**Verify**: `pnpm --filter "@lunora/studio" run test -- ws-token-provider` → exit 0. `pnpm --filter "@lunora/studio" run lint:types` → exit 0.

### Step 4: Remove the server opt-out and the master-in-query branch

1. **Worker** (`packages/runtime/src/create-worker.ts`):
    - In `checkAdminWsToken` (`:2652-2677`), delete the `requireEphemeral` parameter and the `return constantTimeEqual(expected, supplied);` at `:2676`. The function returns `true` only for a verified sub-token and otherwise `false`. Update the doc comment at `:2644-2651`.
    - Delete the `requireEphemeralWsToken` option (`:1336`) and its doc comment.
    - Delete `envRequireEphemeralWsToken`, `effectiveRequireEphemeralWsToken` and the env capture at `:2942`, `:2960-2965` and `:2964`.
    - Change the two call sites (`:3864`, `:4332`) to drop the third argument.
2. **DO** (`packages/do/src/shard-do.ts`):
    - In `isAdminSocket` (`:13795-13808`), delete the `fromQuery`/`requireEphemeral` block and the final `constantTimeEqual(supplied, adminToken)` for the query path. The Authorization-header path must still reach the constant-time master compare. Split the logic: header bearer → constant-time master compare; query → sub-token verify only.
    - Update the docstring at `:13769-13782` to remove the opt-out sentence.
3. **Shared helper**: run Step 1's grep again. If `isEnvFlagEnabled` has no other importer, delete it from `shared/ws-admin-token.ts` (`:60` and the export at `:168`). If it does, keep it.

**Verify**: `pnpm --filter "@lunora/runtime" run test` and `pnpm --filter "@lunora/do" run test` → all pass, including the flipped cases from Step 2. `grep -rn "LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN\|requireEphemeralWsToken" packages shared` → no matches.

### Step 5: Docs and public API snapshot

1. Remove the opt-out paragraph from `apps/docs/src/content/docs/production-checklist.mdx` (around `:69`). Keep the sentence at `:57`, which is still true.
2. Build, then refresh the snapshot:

```bash
pnpm run build:packages
pnpm run api:check
```

If `api:check` reports drift only in `runtime`, run `pnpm run api:update` and confirm the diff in `api-snapshots/runtime.api.md` is limited to removing `requireEphemeralWsToken`. If it reports drift in any other package, STOP.

**Verify**: `pnpm run api:check` → exit 0.

### Step 6: Full gates

```bash
pnpm --filter "@lunora/studio" run test
pnpm --filter "@lunora/runtime" run test
pnpm --filter "@lunora/do" run test
pnpm run test:workerd
pnpm --filter "@lunora/studio" run lint:eslint
pnpm --filter "@lunora/runtime" run lint:eslint
pnpm --filter "@lunora/do" run lint:eslint
pnpm --filter "@lunora/studio" run lint:types
pnpm --filter "@lunora/runtime" run lint:types
pnpm --filter "@lunora/do" run lint:types
pnpm run lint:package-json
```

Run Prettier before ESLint on any hand-edited file (`prettier --write` first, then `eslint --fix`).

**Verify**: all commands exit 0. `pnpm run test:workerd` is mandatory because `shard-do.ts` changed.

## Test plan

- Studio: a 404 and a 405 from the mint endpoint reject; neither returns the master token. A minted sub-token is returned and cached, as before.
- Worker: a raw master in `?token=` is refused, with no env or option able to admit it. The `Authorization: Bearer <master>` header still admits the socket.
- DO: the same two cases for `isAdminSocket`. A sub-token in `?token=` still admits, and a sub-token that has expired is refused.
- Regression proof: run the Step 2 cases against the unfixed code first. The fallback and opt-out cases must fail there.
- Workerd: `pnpm run test:workerd` covers the Durable Object path that the local Node tests cannot exercise.

## Platform parity

Not applicable to the matrix. This change removes an authentication path. It adds or moves no `ctx.*` surface, binding or host contract. No `PlatformCapabilities` row changes.

## Done criteria

- [ ] `grep -rn "endpointMissing\|return adminToken" packages/studio/src` returns no matches
- [ ] `grep -rn "LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN\|requireEphemeralWsToken" packages shared apps/docs/src` returns no matches
- [ ] `grep -n "constantTimeEqual(supplied, adminToken)" packages/do/src/shard-do.ts` returns only the header-path comparison, and none on the query path
- [ ] Every test in Step 2 exists and passes; the fallback and opt-out cases were red before Step 3
- [ ] `pnpm run test:workerd` exits 0
- [ ] `pnpm run api:check` exits 0
- [ ] `git status` shows changes only inside the in-scope list
- [ ] Commit body states the break and lists the removed env var and option
- [ ] `plans/README.md` row for 487 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `ws-token-provider.ts:84-90`, `create-worker.ts:2676` or `shard-do.ts:13808` does not match the excerpts above (drift).
- Step 1 finds a first-party caller (in `templates/`, `sdks/`, `examples/`, `apps/`, or `tests/`) that passes the admin master as a `wsToken` string or sets the opt-out. Report the site. Do not keep a bypass to make it work.
- A worker deployed from alpha (not from a pre-095 release) lacks `/_lunora/admin/ws-token`. That means the mint route was removed somewhere, and the plan's premise is wrong.
- `api:check` reports drift outside `runtime`.
- Any verification fails twice after a reasonable fix attempt. Do not make a third blind fix.

## Maintenance notes

- **Known residue.** The studio's ephemeral sub-token still rides `?token=` for up to 60 seconds. It is scoped and expires, so it is an accepted risk for now. A future ticket or first-message design would remove it from the URL entirely. That is a new protocol and is not part of this plan.
- **Proxies still see the sub-token.** Logging of the 60-second token is the remaining exposure. Document it in the production checklist, which this plan keeps at `:57`.
- **Studio copy.** `studio.tsx:543` and `en.ts:506` still say "Token rides the WebSocket URL". Revisit it when the ticket design lands.
- **Pre-095 workers.** A studio built from alpha no longer connects to a worker without the mint endpoint. This is the intended break on alpha, per the no-backcompat rule.
