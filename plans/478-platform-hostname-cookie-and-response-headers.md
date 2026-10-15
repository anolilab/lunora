# Plan 478 — Stop sibling tenants from setting cookies the control plane reads; add opt-in response headers at the dispatcher

**Baseline:** `origin/feat/cloud-platform-dx` @ `1d8f444fe` (2026-10-11)
**Status:** PHASE 0 DONE (2026-10-11). Workstream B (`__Host-` session cookies, `apps/cloud/src/auth.ts`) and workstream C (`nosniff` and the default referrer policy, `apps/cloud/src/dispatcher/platform-headers.ts`) are implemented on `feat/cloud-cookie-host-prefix`.
**Review follow-up (PR #1125):** the dispatcher copies a response once (`withPlatformHeaders` stamps `x-lunora-id` in that copy, with the one 101 check). The rethrown-exception path is not covered: the runtime builds that response, and the existing test pins the rethrow. The first auth request that still carries a pre-rename session cookie, or a sign-out, clears the eight of them (`apps/cloud/src/auth-legacy-cookies.ts`). Users who never sign out are cleaned up on their next auth request; the `__Host-` names are never cleared by the platform. The tenant `nosniff` effect is documented in `cloud/who-can-open-my-app.mdx`.
**Not done, and not in this PR:**

- Staging browser rerun against the real control plane, and the sign-in notice (B). Not reachable from this workspace; needs a staging control plane.
- Safari check on `http://localhost`. Not run here. The cookie configuration stays as it is.
- PSL submission for `lunora.app` (A). External process; owned outside this repo.
- Opt-in CSP (D). Not started. A separate feature; it is not implemented by this PR.

## 0. Verified finding

Every tenant is served from a sibling host of the control plane, under one registrable domain. `lunora.app` is not on the Public Suffix
List (PSL). Checked 2026-10-11 with a positive control (`app` is listed, so the grep is live; `lunora.app` is absent).

A browser test on 2026-10-11 (Chrome, real hosts mapped to localhost, no DNS touched) and the pinned better-auth 1.7.7 source give these results:

| Question                                                   | Result                                                                                                                                                               | Evidence                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Can a tenant page set a cookie the control plane receives? | **Yes.** `better-auth.session_token; Domain=lunora.app` is accepted.                                                                                                 | Browser run, `domainCookieAccepted: true`                                                       |
| Does the `__Host-` prefix stop it?                         | **Yes.** A `__Host-` cookie with a `Domain` attribute is rejected. A tenant can set a `__Host-` cookie only on its own host, which the control plane never receives. | Browser run, `hostPrefixWithDomainAccepted: false`                                              |
| Does better-auth's **default** prefix stop it?             | **No.** On HTTPS the default is `__Secure-`, and a `__Secure-` cookie with `Domain=lunora.app` is accepted.                                                          | Browser run, `securePrefixWithDomainAccepted: true`; `better-auth` 1.7.7 `cookies/index.mjs:23` |
| Which value does the server read when two are sent?        | **The first one.** `parseCookies` keeps the first occurrence of a name. A tenant cookie scoped to a more specific path (`/whoami`) is sent first by the browser.     | `better-call` 1.4.0 `dist/cookies.cjs` (`if (!cookies.has(key))`); browser run                  |
| Can the attacker forge a session?                          | **No.** `get-session` verifies an HMAC over the value (`api/routes/session.mjs:40`, `getSignedCookie`).                                                              | Source; a forged signature returns `session: null` (see readback test)                          |
| So what can a sibling do?                                  | **Plant the attacker's own signed session** in the victim's browser. Login CSRF: what the victim does lands in the attacker's account. Not account takeover.         | Follows from the three rows above                                                               |

Severity: **M**, as originally rated. The browser run shows the injection is real, but the impact is login CSRF, not takeover.

Second finding, same root: every tenant is same-site with the control plane and with each other, so `SameSite=Lax` gives no protection between them.

Third finding, independent: the dispatcher sets no `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy` or `X-Content-Type-Options` on tenant responses.

**Correction to the earlier plan:** `__Host-` is the primary fix, not defence in depth. It works with better-auth 1.7.7 and needs no external process. The PSL submission is still worth doing, but for tenant-to-tenant isolation, which `__Host-` does not cover.

## 1. Current state (audit)

- `apps/cloud/src/auth.ts:81` — `baseURL: env.AUTH_URL ?? requestOrigin`. No cookie options set.
- `apps/cloud/src/auth.ts:115` — `advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } }`. The only `advanced` setting.
- `apps/cloud/wrangler.jsonc:111, 122` — `LUNORA_APP_DOMAIN: "lunora.app"` and `LUNORA_OTLP_ENDPOINT: "https://cloud.lunora.app"`.
- **Control-plane hostname (P0.2, checked 2026-10-11):** `cloud.lunora.app` does not answer (`curl` returns no HTTP status). `lunora.app` resolves to `51.89.70.16`, an OVH failover IP that is not a Cloudflare address, and serves plain HTTP `200`. So the control plane is not reachable at the hostname this plan assumed. Where it runs is unknown, and the fix below does not depend on it.
- `apps/cloud/dispatcher.wrangler.jsonc:41` — the dispatcher's route is `*/*` on `lunora.app`, so every sibling host is served by it.
- The dispatcher sets only `x-lunora-id` on responses (`apps/cloud/src/dispatcher/worker.ts:506`) and the preview cookie (`:237`). No CSP or framing header in `src/dispatcher`, `src/targets` or `src/edge`.
- Preview cookies (`apps/cloud/src/dispatcher/preview-auth.ts:146`) are `HttpOnly; Secure; SameSite=Lax`, path `/`, no `Domain`: host-only. That is the shape to copy.

## 2. Existing seams (do not reinvent)

- `preview-auth.ts` already builds a hardened cookie (`previewCookieHeader`). Use the same attribute set.
- better-auth's `advanced.cookies` option sets a cookie's name and attributes. Verified below.
- `worker.ts:237` already sets `set-cookie` for the preview login; the dispatcher's response path is where header policy goes.

## 3. The behavioural contract to preserve

- A signed-in user stays signed in across the change, or is signed out once with a stated reason. The cookie rename signs everyone out once.
- Tenant apps that set their own CSP keep it when the platform policy is opt-in. The platform never overrides a tenant policy silently.
- Preview password cookies keep their current attributes.

## 4. Design decisions

1. **Primary fix: `__Host-` session cookies, configured explicitly.** Verified with better-auth 1.7.7 in a real run (see §5, P0.4). The configuration:

    ```ts
    advanced: {
      // Turn off the automatic __Secure- prefix; it does not stop a sibling's Domain attribute.
      useSecureCookies: false,
      // One prefix names every cookie, including the plugin, OAuth state and passkey cookies,
      // which better-auth names by bare key. Shipped form; see auth.ts.
      cookiePrefix: "__Host-better-auth",
      defaultCookieAttributes: { httpOnly: true, path: "/", sameSite: "lax", secure: true },
    },
    ```

    Output of the run: `__Host-better-auth.session_token; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax` (no `Domain`). `get-session` returns the session for that cookie, and a forged signature returns `null`.
    _Rejected:_ `useSecureCookies: true` alone. It gives `__Secure-`, which a sibling can still set with `Domain`. _Rejected:_ a name starting `__Host-` with the automatic prefix on. better-auth prepends `__Secure-`, which produces an invalid name.
    _Superseded:_ a per-cookie `advanced.cookies` list. It missed the passkey cookie and needed an entry for every plugin, so `cookiePrefix` replaces it.

2. **Secondary: PSL submission of `lunora.app`.** Browsers then treat each tenant host as its own site. That isolates tenants from each other, which `__Host-` does not do, and it makes cross-tenant `SameSite` work. It is an external process with a lead time of weeks. Start it, but it does not block item 1.
   _Rejected:_ moving the control plane to another domain. The `__Host-` fix makes it unnecessary.
3. **Platform headers are opt-in, report-only first.** A per-project setting selects `report-only` CSP, then `enforce`. Default off.
   _Rejected:_ enforce by default. It breaks arbitrary Lunora apps with inline scripts and third-party embeds on deploy.
4. **Always-on headers:** `X-Content-Type-Options: nosniff` on every response, and `Referrer-Policy: strict-origin-when-cross-origin` only when the tenant sets no value.

## 5. Workstreams and results

**Phase 0 — verify.**

- **P0.1 done (2026-10-11):** PSL membership, with the positive control above.
- **P0.2 done (2026-10-11), result negative:** `cloud.lunora.app` is not reachable; `lunora.app` resolves to a non-Cloudflare host. The production control plane's location must be confirmed before deploy. Not a blocker for the cookie fix.
- **P0.3 done (2026-10-11), result positive:** the cross-host browser test (table in §0). Script kept at `/tmp/cookie-check/run.mjs` (throwaway).
- **P0.4 done (2026-10-11), result:** the session cookie is signed (`api/routes/session.mjs:40`). The `__Host-` configuration in §4.1 was run against better-auth 1.7.7 with an in-memory adapter. It sets the expected name and attributes, reads the session back, and rejects a forged signature.
- **P0.5 done (2026-10-11), result:** the default names on HTTPS are `__Secure-better-auth.session_token`, `__Secure-better-auth.session_data`, and the matching `account_data` and `dont_remember`. Confirmed by the run (default config).

**B. `__Host-` configuration and migration (S, ready).** Apply §4.1. Tests: `Set-Cookie` names and attributes for all four cookies; a session is read back with the new name; the old `__Secure-` name is not read as a session (users are signed out once). Release note and sign-in page notice.
**C. Always-on headers (S).** `nosniff` and the conditional referrer policy in the dispatcher's response path for non-101 responses, one test per rule.
**D. Opt-in CSP (M).** `report-only` then `enforce`, a `Content-Security-Policy-Report-Only` header with a report endpoint, and a studio toggle. Default policy allows `'self'` and reports everything else. No enforce setting before a clean report-only window.
**A. PSL submission (S of work, long lead time, ops).** Prepare and submit. Track the submission date here. Re-check the list on any deploy that touches cookie scope.

## 6. Platform parity

Not applicable. Control-plane and dispatcher behaviour, not a framework `ctx.*` surface or binding.

## 7. Phasing & ordering

| Phase | Work           | Gate                                                                                                                                                                                          |
| ----- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | P0.1–P0.5      | Done (above). P0.2 needs the production control-plane location before deploy.                                                                                                                 |
| 1     | B              | Cookie-attribute tests green; a manual sign-in check on staging in two browsers; the browser cross-host test rerun against the staging control plane shows the sibling cookie is **not** read |
| A     | PSL submission | Submitted; acceptance date recorded. Parallel with 1.                                                                                                                                         |
| 2     | C              | Header tests per rule; no change to the existing end-to-end suite                                                                                                                             |
| 3     | D              | Report-only policy on staging for one week, reports reviewed before any enforce setting is offered                                                                                            |

## 8. Risks & STOP conditions

- **STOP** if the staging browser test still reads a sibling-set cookie after B. The problem is then not the name; re-scope.
- **Risk:** the `useSecureCookies: false` override changes other better-auth behaviour. _Mitigate:_ the run in §5 showed the expected attributes; the tests in B cover sign-in, get-session and sign-out on staging.
- **Risk:** the sign-out migration locks a user out mid-task. _Mitigate:_ a one-time notice and the normal sign-in flow.
- **Risk:** a CSP breaks a tenant app. _Mitigate:_ report-only first; per-project switch defaults off.
- **Perf watch:** none material; header work is O(1) per response.

## 9. Open questions — decided

1. **Is the staging test conclusive?** Decided: the browser run already shows the mechanism. The staging rerun in §7 Phase 1 confirms it on the real control plane.
2. **Where do CSP reports go?** Decided: a control-plane endpoint writing to the platform metrics dataset.

## 10. Checked and not gaps (2026-10-11)

- **Client-supplied header trust, framework runtime: not a gap on the paths read.** The upgrade path strips every client-supplied `x-lunora-*` header and re-sets identity from the server (`packages/runtime/src/create-worker.ts:2626-2675`). A test asserts it (`packages/runtime/__tests__/identity-layer.test.ts:235`). **Residual:** plain HTTP paths build their forward context through `resolveForwardContext`; not every HTTP route was traced.
- **Client-supplied header trust, dispatcher: not a gap.** The dispatcher deletes only `x-lunora-lineage` (`apps/cloud/src/dispatcher/worker.ts:393`). `x-lunora-client-ip` (`worker.ts:206`) is set on the dispatcher's own outbound request, not copied from the client.
- **Preview data isolation: not a gap, by construction.** A preview is a separate provisioning stack keyed by its own script name: `release-core.ts:331` sets `alias: release.scriptName`, and `previewScriptName(alias, branch)` (`apps/cloud/src/deploy/preview.ts:25`) names it. The provision box keys stacks by alias (`apps/cloud/src/targets/provision-box/contract.ts:72`). **Residual:** confirm the resource names on a staging preview.
