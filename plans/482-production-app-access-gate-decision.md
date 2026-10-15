# Plan 482 — Should Lunora Cloud gate a production app's users at the platform edge? (decided: option A now)

**Baseline:** `origin/feat/cloud-platform-dx` @ `1d8f444fe` (2026-10-11)
**Status:** DECIDED — option A (no platform gate; the app owns its auth; say so clearly). Option D is deferred to plan 166. Options B and C are rejected for now. A1: the docs page "Who can open my app?" (`apps/docs/src/content/docs/cloud/who-can-open-my-app.mdx`) is shipped on `feat/cloud-cookie-host-prefix`; the Access card copy and the preview-gate notice are not done. The docs page also states that tenant JS/CSS with a wrong `Content-Type` is blocked (`nosniff`, plan 478 C). A3 (one-time deploy hint) is not shipped. The natural place is the success summary, `renderDeploySummary` in `packages/cli/src/util/deploy-summary.ts`, called from `packages/cli/src/commands/deploy/handler.ts`. Showing it once per project needs a persisted flag in the link file (`.lunora/project.json`, written by `@lunora/config`), a published package with its own API snapshot. That cross-package change is outside this workstream, so A3 waits for it. A2 (Access card in the studio) is not started.

## 0. Headline finding

Previews are gated at the platform: a protected preview asks for a password, then sets a signed cookie the dispatcher checks. Production tenants have no equivalent.
Anyone who can reach `<alias>.lunora.app` reaches the app, and access rules exist only if the app's own code enforces them. That is a legitimate design, because a
Lunora app owns its auth. It is a real gap for organisations that want company-wide sign-in in front of internal tools, a common requirement.

## 1. Current state (audit)

- `apps/cloud/src/dispatcher/worker.ts:461-467` — the protected-preview gate runs before dispatch. Production scripts have no equivalent check.
- `apps/cloud/src/dispatcher/preview-auth.ts:140-146` — the preview cookie is `HttpOnly; Secure; SameSite=Lax`, an HMAC over the script name. Plan 478 covers its hostname scope.
- `apps/cloud/src/dispatcher/worker.ts:195-222` — the preview password is verified by the control plane (`POST /v1/tenants/preview-auth`).
- `apps/cloud/src/auth.ts` — the control plane's sign-in is better-auth (OAuth, 2FA, passkeys). That identity is for control-plane users, not for an app's end users.
- `apps/cloud/GAPS.md:839` — "Dashboard SSO (SAML/OIDC) + SCIM (🌐) — `sso` plan flag exists, unwired." Plan `166-enterprise-auth-saml-scim.md` is open.
- The framework provides app auth through its own registry item (the `auth` item, via `lunora add auth`), so an app's end-user auth is a few commands away.

## 2. Existing seams (do not reinvent)

- The preview gate (`worker.ts:461-467`, `preview-auth.ts`). Any future production gate reuses that mechanism and its tests.
- Plan 166 for enterprise identity. Any group rule needs its identity source; 166 is where it would come from.

## 3. The behavioural contract (unchanged by this decision)

- A production app with no platform gate behaves exactly as today.
- Any future gate never serves a gated app to an unauthenticated request, even during a control-plane outage (plan 476's rule).
- A gate lives in the dispatcher, outside tenant code, so a tenant cannot bypass it by editing its own response.

## 4. The decision

Options considered:

- **A. No platform gate; the app owns its auth.** Zero build cost. Honest, and matches the "same code, no lock-in" promise.
- **B. Shared password for production.** Rejected: a shared password is a weak control for a company tool and needs rotation the platform would then own.
- **C. Email allowlist with a one-time code.** Rejected for now: it needs the mail path on the login route and a control-plane call per login, which sits on the request path plan 476 is making survivable.
- **D. Gate on company identity (plan 166), with group membership.** Right answer for enterprise, but it depends on an identity model that does not yet exist for end users. Deferred to plan 166.

**Decided: A now, D when plan 166 lands.** It is the option that is honest on day one, costs nothing on the request path, and leaves the enterprise answer intact.

## 5. Best DX and UX for option A

A "no gate" default is only good UX if nobody mistakes it for a gate. So the work is in the wording and the path to a real auth:

- **Access card in the studio** (the production project page): one line that says who can open the app — "Anyone with the link. Your app controls who signs in." — with a button "Add sign-in" that opens the auth setup path (`lunora add auth`, the `lunora-setup-auth` skill).
- **Docs page** "Who can open my app?" with a short table: the platform gate for previews (password), the app's own auth for production, and the enterprise option coming with SSO.
- **Preview gate notice:** a preview's password page says it protects the preview only, so a team does not assume production is gated the same way.
- **Deploy output:** when a production deploy has no auth registry item, the CLI prints one line with the command to add it. No warning on every deploy; once per project.

## 6. Workstreams

**A1. Docs and copy (S).** The "Who can open my app?" page and the Access card copy in §5. Reviewed for the wording above.
**A2. Add-sign-in path (S).** The Access card's button links to the auth setup flow. Verify the link resolves on staging.
**A3. Deploy hint (S).** The one-time CLI line in §5.

## 7. Platform parity

Not applicable to the framework; no `ctx.*` surface and no binding. On BYO-Cloudflare the platform gate would not exist anyway (no dispatcher), so the copy in §5 is the same on every target.

## 8. Phasing & ordering

| Phase | Work             | Gate                                                                                          |
| ----- | ---------------- | --------------------------------------------------------------------------------------------- |
| 1     | A1, A2, A3       | Copy reviewed; the Access card link tested on staging; the deploy hint shows once per project |
| Later | D, with plan 166 | Its own plan, when plan 166 has an identity model for end users                               |

## 9. Risks & STOP conditions

- **Risk:** customers assume a gate exists because previews have one. _Mitigate:_ §5's copy and the preview notice; A1 is the first deliverable.
- **STOP** if a customer's written requirement is company-wide group rules before plan 166 lands. Then the decision is revisited, not patched with option B or C.

## 10. Open questions — decided

1. **Which option?** Decided: A now, D with plan 166. B and C are rejected for now (§4).
2. **Is any customer asking for company-wide rules on a production app?** Recorded as a trigger, not a blocker: if a named customer needs it before plan 166, that customer's need reopens the decision, and the answer is still A plus a pointer, unless they can wait for 166.
