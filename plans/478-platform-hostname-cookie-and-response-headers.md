# Plan 478 — Stop sibling tenants from setting cookies the control plane reads; add opt-in response headers at the dispatcher

**Baseline:** `origin/feat/cloud-platform-dx` @ `1d8f444fe` (2026-10-11)
**Status:** TODO — Phase 0 verification comes first and may change the priority.

## 0. Headline finding

Every tenant is served from a sibling host of the control plane, under one registrable domain. `lunora.app` is not on the Public
Suffix List (PSL), so the browser treats every tenant host and the control plane as one site with a shared cookie scope.

Checked 2026-10-11 with a positive control: the PSL file contains `app` (so the grep is live), and no entry for `lunora.app`.
`pages.dev` is listed; `workers.dev` was not matched by an exact-line grep, so this plan makes no claim about it.

Consequences:

1. **Cookie tossing (M, not H).** A tenant page can set a cookie with `Domain=lunora.app`, and the browser sends it to the control
   plane. better-auth signs its session cookies with the server secret (to confirm against the installed version in Phase 0), so a
   sibling can plant only a session the server has signed. In practice that is a session for the attacker's own account. The impact is
   login CSRF: the victim's actions land in the attacker's account. It is not account takeover.
2. **Same-site requests across tenants (M).** Because every tenant is same-site with the control plane and with each other, `SameSite=Lax`
   gives no protection between them.
3. **No platform response headers (M).** The dispatcher sets no `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`,
   `Referrer-Policy` or `X-Content-Type-Options` on tenant responses.

Items 1 and 2 are the same fix, and it is a PSL submission, not a cookie change. The `__Host-` prefix is defence in depth on top of it.
Item 3 is independent.

## 1. Current state (audit)

- `apps/cloud/src/auth.ts:81` — `baseURL: env.AUTH_URL ?? requestOrigin`. No `crossSubDomainCookies`, no `cookiePrefix`, no explicit cookie attributes.
- `apps/cloud/src/auth.ts:115` — `advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } }`. This is the only `advanced` setting. `grep`
  finds no `__Host-`, `__Secure-` or `SameSite` configuration in `src` or `lunora`.
- `apps/cloud/wrangler.jsonc:111, 122` — `LUNORA_APP_DOMAIN: "lunora.app"` and `LUNORA_OTLP_ENDPOINT: "https://cloud.lunora.app"`. The control
  plane's own route is **not** in `wrangler.jsonc`, so `cloud.lunora.app` is inferred. Confirm the hostname in the dashboard (Phase 0).
- `apps/cloud/dispatcher.wrangler.jsonc:41` — the dispatcher's route is `*/*` on `lunora.app`, so every sibling host is served by it.
- The dispatcher sets only `x-lunora-id` on responses (`apps/cloud/src/dispatcher/worker.ts:506`) and the preview cookie (`:237`); `grep` finds no
  CSP or framing header anywhere in `src/dispatcher`, `src/targets` or `src/edge`.
- Preview cookies (`apps/cloud/src/dispatcher/preview-auth.ts:146`) are `HttpOnly; Secure; SameSite=Lax` with path `/` and no `Domain`: host-only.

## 2. Existing seams (do not reinvent)

- `preview-auth.ts` already builds a hardened cookie (`previewCookieHeader`). Control-plane cookies should use the same attribute set.
- better-auth's `advanced` cookie options are where prefixes and attributes are set. Check the installed version's option names first.
- `worker.ts:237` already sets `set-cookie` for the preview login; the dispatcher's response path is where header policy would go.

## 3. The behavioural contract to preserve

- A signed-in user of the control plane stays signed in across the change, or is asked to sign in once, with a stated reason.
- Tenant apps that set their own CSP keep it when the platform policy is opt-in. The platform never overrides a tenant policy silently.
- Preview password cookies keep their current attributes.

## 4. Design decisions

1. **Primary fix: submit `lunora.app` to the PSL private section.** Each tenant host becomes its own site, so a tenant can no longer set a cookie
   that the control plane or another tenant reads, and cross-tenant `SameSite` protection starts working. It is an external process with a lead
   time of weeks, so it starts first and does not block the rest.
   *Rejected:* moving the control plane to another registrable domain (DNS and customer-facing URL changes for a problem the PSL entry solves);
   the `__Host-` prefix alone (it protects the control plane's cookie, but tenants stay same-site with each other).
2. **Defence in depth: `__Host-` prefix on control-plane session cookies.** Must be `Secure`, `Path=/`, no `Domain`, so no other host can set it.
   Configure through better-auth's options, against the installed version, and verify the `Set-Cookie` names in a test.
3. **Platform headers are opt-in, report-only first.** A per-project setting selects `report-only` CSP, then `enforce`. The default is off.
   *Rejected:* enforce by default. Tenant apps are arbitrary Lunora apps with inline scripts and third-party embeds; an enforced default breaks them on deploy.
4. **Always-on headers:** `X-Content-Type-Options: nosniff` on every response, and `Referrer-Policy: strict-origin-when-cross-origin` only when the tenant
   sets no value.

## 5. Workstreams

**Phase 0 — verify (S, staging).**
- P0.1 (done 2026-10-11): PSL membership, with the positive control above.
- P0.2: confirm the control plane's production and staging hostnames in the dashboard.
- P0.3: the cross-host cookie test. From a tenant host on staging, set a cookie with `Domain=<apex>` named like the control plane's session cookie, then send
  a control-plane request and record which cookie the server reads. Decisive: a negative result means item 1 is not exploitable on current browsers and the cookie work drops.
- P0.4: read the installed better-auth source and confirm the session cookie is signed; a test that an unsigned or mis-signed value is rejected.
- P0.5: record the exact cookie names the control plane sets today.

**A. PSL submission (S of work, long lead time, ops).** Prepare and submit. Track the submission date in this file. Re-check the list on any deploy that touches cookie scope.

**B. `__Host-` prefix and migration (S, if P0.3 reproduces or P0.4 shows a weak point).** Configure prefix and attributes; test the `Set-Cookie` attributes and that an
old-named cookie is not read as a session. Users with the old cookie are signed out once; state this in the release notes and on the sign-in page.

**C. Always-on headers (S).** `nosniff` and the conditional referrer policy in the dispatcher's response path for non-101 responses, one test per rule.

**D. Opt-in CSP (M).** `report-only` then `enforce`, a `Content-Security-Policy-Report-Only` header with a report endpoint, and a studio toggle. Default policy allows `'self'` and
reports everything else. No enforce setting is offered before a clean report-only window.

## 6. Platform parity

Not applicable. Control-plane and dispatcher behaviour, not a framework `ctx.*` surface or binding.

## 7. Phasing & ordering

| Phase | Work | Gate |
| ----- | ---- | ---- |
| 0 | P0.2–P0.5 | Results recorded here. If P0.3 is negative, B drops and item 1 becomes a note. |
| A | PSL submission | Submitted; acceptance date recorded. Runs in parallel with 1. |
| 1 | B | Attribute tests; a manual sign-in check on staging in two browsers |
| 2 | C | Header tests per rule; no change to the existing end-to-end suite |
| 3 | D | Report-only policy on staging for one week, reports reviewed before any enforce setting is offered |

## 8. Risks & STOP conditions

- **STOP** if P0.3 shows the control plane reads a sibling-set cookie even with the `__Host-` prefix in place. The problem is in the session lookup; re-scope.
- **Risk:** the PSL submission is rejected or delayed. *Mitigate:* B still closes the control-plane cookie; tenant-to-tenant isolation waits for the list.
- **Risk:** the sign-out migration locks a user out mid-task. *Mitigate:* a one-time notice and the normal sign-in flow.
- **Risk:** a CSP breaks a tenant app. *Mitigate:* report-only first; per-project switch defaults off.
- **Perf watch:** none material; header work is O(1) per response.

## 9. Open questions

1. Is the staging test conclusive? Recommendation: yes; the browser rule is the same on staging and production, and the test uses the real hostnames.
2. Where do CSP reports go? Recommendation: a control-plane endpoint writing to the existing logs or the platform metrics dataset.

## 10. Checked and not gaps (2026-10-11)

- **Client-supplied header trust, framework runtime: not a gap on the paths read.** The upgrade path strips every client-supplied `x-lunora-*` header and re-sets
  identity from the server (`packages/runtime/src/create-worker.ts:2626-2675`, `SERVER_MINTED_HEADER_NAMES` and `buildUpgradeHeaders`). A test asserts it
  (`packages/runtime/__tests__/identity-layer.test.ts:235`). **Residual:** plain HTTP paths build their forward context through `resolveForwardContext`; not every HTTP route was traced.
- **Client-supplied header trust, dispatcher: not a gap.** The dispatcher deletes only `x-lunora-lineage` (`apps/cloud/src/dispatcher/worker.ts:393`). The rest reaches
  the tenant runtime, which applies the check above. `x-lunora-client-ip` (`worker.ts:206`) is set on the dispatcher's own outbound request, not copied from the client.
- **Preview data isolation: not a gap, by construction.** A preview is a separate provisioning stack keyed by its own script name: `release-core.ts:331` sets
  `alias: release.scriptName`, and the preview name is `previewScriptName(alias, branch)` (`apps/cloud/src/deploy/preview.ts:25`). The provision box keys stacks by alias
  (`apps/cloud/src/targets/provision-box/contract.ts:72`). **Residual:** confirm the resource names on a staging preview. A preview sharing production's data would be H and reopen this section.
