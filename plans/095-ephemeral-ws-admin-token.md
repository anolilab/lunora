# Plan 095: Ephemeral, signed admin-WebSocket token (`?token=` credential hygiene)

> **Executor instructions**: Follow step by step; run every verification and
> confirm the expected result before continuing. This closes run-1 audit finding
> **L4** (the master `LUNORA_ADMIN_TOKEN` travels in the WS `?token=` query
> string). Ship it in the three phases below — Phase 1 is fully backward
> compatible and can land alone. On any STOP condition, stop and report. When
> done, update the status row in `plans/README.md`.
>
> **Coordination note**: this touches `packages/runtime/src/create-worker.ts` and
> the 7,450-line `packages/do/src/shard-do.ts`, both under active edit by a
> concurrent session. Land after that work settles, or rebase; re-run the drift
> check first.
>
> **Drift check (run first)**: `git diff --stat 8b71a38b..HEAD -- packages/runtime/src/create-worker.ts packages/do/src/shard-do.ts packages/runtime/src/scheduled-admin-routes.ts packages/studio/src/hooks/use-admin-query.ts`
> If any changed, re-verify the "Current state" line references before proceeding.

## Status

- **Priority**: P2 (LOW-severity audit finding — the compare is already
  constant-time; the exposure is the master credential in URLs/logs)
- **Effort**: M (Phase 1 ~½ day; Phase 2 ~½–1 day; Phase 3 ~1–2h)
- **Risk**: MEDIUM (two isolates' auth gates + a sync→async ripple; files owned
  by a concurrent session)
- **Depends on**: none (but sequence after the concurrent create-worker/shard-do work)
- **Category**: fix (security / runtime)
- **Planned at**: commit `8b71a38b`, 2026-07-02

## Why this matters

The admin WebSocket upgrade can't set an `Authorization` header (browsers forbid
it on the WS handshake), so the studio sends the master `LUNORA_ADMIN_TOKEN` in
the `?token=` query string. Query strings land in access/proxy logs, browser
history, and `Referer` headers, so the **master admin credential leaks** — full
raw-SQL / export / `runAs` authority. The fix is to never put the master token in
a URL: mint a short-lived HMAC-signed sub-token (via an endpoint authenticated by
the master token in the **header**) that every WS gate accepts.

## Current state (verified at `8b71a38b`)

Two independent token gates, in two isolates, both read `?token=` and compare to
`LUNORA_ADMIN_TOKEN`; the studio supplies the token:

- **Worker** — `checkAdminWsToken` (`packages/runtime/src/create-worker.ts:1419`,
  sync) ← `checkWsAdmin` (`:1957`, sync `(req) => boolean`) ← scheduled-admin WS
  gate (`packages/runtime/src/scheduled-admin-routes.ts:79`). Reusable crypto:
  `verifyHmacSignature` (`:1373`, WebCrypto HMAC→base64url), `constantTimeEqual`
  (`:1348`). Admin-header gate: `checkAdminAuth`.
- **Durable Object** — WS upgrade gate (`packages/do/src/shard-do.ts:~7230`) +
  `readWsToken` (`:7252`, reads `?token=`) + `isAdminSocket` (`:7256`), stamping
  the socket's admin flag; admin subscriptions re-check that flag per frame. DO
  `constantTimeEqual` (`:1365`), `isAdminAuthorized` (RPC bearer, `:5818` — header
  based, **out of scope**).
- **Studio** — supplies the token as bearer/`wsToken`
  (`packages/studio/src/hooks/use-admin-query.ts`, token state in
  `packages/studio/src/app/app.tsx:169`).

Both isolates share `LUNORA_ADMIN_TOKEN` via `env`, so both can independently
**verify** an HMAC-signed token with no shared state; only the worker **mints**.

## Token design

```
token = "v1." + expEpochMs + "." + base64url(HMAC_SHA256(key = LUNORA_ADMIN_TOKEN,
                                                         msg = "v1." + expEpochMs))
```

- **TTL** default 60_000 ms. **Verify:** split `[version, expStr, sig]`; require
  `version === "v1"`, `exp = Number(expStr)` finite and `> now`; recompute the
  HMAC over `"v1." + expStr`; **constant-time** compare to `sig`. No state.
- Keying on the master token means rotating `LUNORA_ADMIN_TOKEN` instantly
  invalidates every outstanding sub-token.
- `Date.now()` in workerd is coarse (advances on I/O) but fine for a 60s TTL.

## Commands you will need

| Purpose            | Command                                                                | Expected       |
| ------------------ | ---------------------------------------------------------------------- | -------------- |
| Build deps first   | `pnpm run build:packages`                                              | exit 0 (once)  |
| Typecheck          | `pnpm --filter "@lunora/runtime" --filter "@lunora/do" run lint:types` | exit 0         |
| Runtime tests      | `pnpm --filter "@lunora/runtime" run test`                             | pass incl. new |
| DO tests (workerd) | `LUNORA_WORKERD_TESTS=1 pnpm --filter "@lunora/do" run test`           | pass incl. new |
| Studio/client      | `pnpm --filter "@lunora/studio" --filter "@lunora/client" run test`    | pass incl. new |
| Lint               | `pnpm run lint:eslint`                                                 | exit 0         |

## Scope

**In scope:**

- `shared/ws-admin-token.ts` (new, bundler-inlined): `mintWsAdminToken` +
  `verifyWsAdminToken` (WebCrypto, inline constant-time compare + base64url).
- Worker: `POST /_lunora/admin/ws-token` mint endpoint (header-gated);
  `checkAdminWsToken` accepts master **or** ephemeral; `checkWsAdmin` → async +
  the one `await` in `scheduled-admin-routes.ts:79`.
- DO: WS upgrade gate + `isAdminSocket` accept ephemeral (async).
- Client SDK: async token **provider** for the admin WS token.
- Studio: mint before connect, cache + refresh, re-mint on `4001` close, fall
  back to the master token when the endpoint 404s (older worker).
- Phase 3: `requireEphemeralWsToken` flag (worker option + `LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN` env) that rejects the raw master token in `?token=`.

**Out of scope:** the admin **RPC** bearer path (`Authorization` header, no URL
leak); rotating the token minting to a per-connection nonce; any change to
non-admin sockets.

## Git workflow

Branch `fix/l4-ephemeral-ws-token` off the current head. One commit per phase
(`feat(runtime): ...`, `feat(studio): ...`, `feat(runtime): enforce ...`) so
Phase 1 can merge independently. Conventional-commit types; do not author release
commits.

## Steps

1. **Phase 1 — runtime capability (backward compatible, no behavior change).**
    - Add `shared/ws-admin-token.ts` (`mint`/`verify`). Ensure `@lunora/runtime`'s
      tsconfig drops `outDir`/`rootDir` per the shared/-consumer convention (see
      `packages/d1/tsconfig.json` / `packages/do/tsconfig.json`).
    - Worker: add the `POST /_lunora/admin/ws-token` route (gated by
      `checkAdminAuth`, `cache-control: no-store`, returns `{ token, expiresAtMs }`).
      Make `checkAdminWsToken` async (master OR `verifyWsAdminToken`); make
      `checkWsAdmin` async; update its type + `await` at `scheduled-admin-routes.ts:79`.
    - DO: make the upgrade gate + `isAdminSocket` async (master OR ephemeral); the
      upgrade path is already async — thread `await` at both call sites.
    - Update the `checkAdminWsToken` docstring (drop the "short-lived rotating
      token is preferable" note — now implemented).
2. **Phase 2 — studio + client adoption (where the benefit lands).**
    - Client SDK: allow the admin WS token to be an async `() => Promise<string>`
      provider (re-mint on connect + after a `4001`/expiry drop).
    - Studio (`use-admin-query.ts`, `app.tsx`): `POST /_lunora/admin/ws-token` with
      `Authorization: Bearer <adminToken>`; cache `{token, expiresAtMs}`; refresh
      ~10s before expiry; fall back to the master token on a 404 (mixed-version deploy).
3. **Phase 3 — enforce (optional).** Add `requireEphemeralWsToken` (default off);
   when set, both gates reject a raw master token in `?token=`. Ship after Phase 2.

## Test plan

- **`shared/ws-admin-token`**: valid round-trip; expired → false; tampered sig →
  false; wrong secret → false; malformed → false.
- **Worker**: mint endpoint 403 without the master bearer; a minted token passes
  `checkAdminWsToken`; the master token still passes (compat); expired fails.
- **DO** (workerd harness, `LUNORA_WORKERD_TESTS=1`): `isAdminSocket` accepts a
  minted token and the master token; rejects expired/tampered on the upgrade path.
- **Studio**: mock the mint endpoint — a subscription mints before connect and
  re-mints after a `4001` close.
- **Phase 3**: with the flag on, a raw master token in `?token=` is rejected at
  both gates.

## Done criteria

- Studio opens admin subscriptions using a minted ephemeral token; the master
  token no longer appears in any WS URL from the studio.
- Both gates accept master (compat) + ephemeral; expired/tampered rejected.
- All suites green; `lint:eslint` + `lint:types` clean; docstrings updated.

## STOP conditions

- The DO admin-socket upgrade path can't be made async without a broad refactor of
  `shard-do.ts` → stop, report, and reconsider verifying only at the worker with a
  DO trust-forward header (design change).
- `crypto.subtle` HMAC is unavailable in either isolate under test → stop (the
  whole scheme depends on it; it should be present in workerd + the worker).
- The concurrent session has rewritten `checkWsAdmin`/`isAdminSocket` since
  `8b71a38b` → re-baseline the "Current state" refs before touching them.

## Maintenance notes

- **Rotation**: rotating `LUNORA_ADMIN_TOKEN` invalidates all outstanding
  sub-tokens by construction — document alongside the existing admin-token docs.
- **Clock**: the 60s TTL tolerates workerd's coarse `Date.now()`; do not shorten
  below a few seconds or a slow handshake could race the expiry.
- **Enforcement**: leave `requireEphemeralWsToken` off by default; flipping it on
  is the step that actually closes the log-leak, so gate it on the studio having
  shipped Phase 2 everywhere the deployment uses.
