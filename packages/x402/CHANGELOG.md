## @lunora/x402 [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.83...@lunora/x402@1.0.0-alpha.84) (2026-10-07)

### ⚠ BREAKING CHANGES

* **x402:** @lunora/x402/pay no longer exports createPayFetch,
registerWallet, resolveEvmAccount, resolveSvmSigner, buildSpendPolicy,
buildPaymentGuard, releaseSpendOnFailure, assertBoundedPolicy,
createSpendState, SpendState or WalletDeps; @lunora/x402/charge no longer
exports createFacilitatorClient or toReceipt. Use createX402Pay / lazyX402Pay
and createChargeMiddleware. SpendPolicy.decimals (already throwing) is removed.
X402PayDeps declares getSecret itself. Network and recipient misconfiguration
throws LunoraError ENV_INVALID instead of Error.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* feat(browser): verify on workerd and settle the surface

Add a LUNORA_WORKERD_TESTS-gated workerd project for plan 463 (B3). It runs
createBrowser with the real @cloudflare/playwright launch / connect / sessions
against a fake Browser Run behind a real service binding (an entrypoint of the
test worker). It asserts what reaches the binding: keep_alive in milliseconds,
allowedHosts as normalized guardrails, the session id on connect, the session
list, and quickAction arguments across the RPC boundary. It also covers the
operation deadline, the DoH re-check and its timeout, and /crawl errors on
workerd's timers and fetch. The fake refuses the DevTools upgrade, since no
Chrome runs locally, so a live page stays covered only by the Node doubles.

Keep all 25 exports, drop their @experimental tags, and export the four types
the surface already referenced (BrowserSession, BrowserConnectLike,
BrowserSessionsLike, RouteLike). Node tests cover a failing close(). Docs gain a
platform-support table and the error reference. The workerd CI matrices gain
browser (15 packages).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* chore(api): graduate x402 and browser to stable adapter

Move both from TIER_3 to TIER_2 (plan 463, B3), which puts their snapshots in
FULLY_TRACKED_SNAPSHOTS: every export signature is now gated by api:check.
Regenerate both snapshots, and update the ROADMAP tier lists and table, the
versioning page, the package index and plan 463.

Bar item 5 (used in anger outside this repo) is not something this change can
show; it is left to maintainer sign-off.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(notify): refuse a host whose DoH answer has no address

shared/ssrf-resolve classified a DoH answer with no A/AAAA record (an empty
answer, SERVFAIL, NXDOMAIN) as "public". A name's nameserver can fail the check
and answer the connecting resolver a moment later, so that passed a rebinding
attack. It is now a separate "unresolved" verdict, which callers refuse; a
lookup that could not complete at all still falls back to the string guard.

@lunora/notify refuses an unresolved web-push host at send time and does not
cache the verdict, since a SERVFAIL can be transient. A broadcast test that had
been resolving push.example over the real network now stubs DoH.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(browser): check redirect hops and guard every handed-out browser

Playwright calls a route handler only for the first request of a redirect
chain, so the page.route guard never saw a 3xx hop: a public URL could 302 the
browser to 10.0.0.5 or the metadata endpoint unchecked. The guard now sits on
the context, fetches each navigation itself with route.fetch({ maxRedirects: 0
}), and checks a redirect's Location before anything requests it. A refused
target fails the call with FORBIDDEN; an allowed one becomes a fresh, checked
navigation (withPage follows main-frame hops itself, up to 20; past that,
BROWSER_TOO_MANY_REDIRECTS). Fulfilling the 3xx instead would not work: the
hop it triggers is auto-continued by Playwright and never reaches the handler.

The browsers launch() and connect() hand to caller code carry the same guard on
every context, including the contexts already open in a re-attached session.
Browser Run cannot tag a session with an owner, so the docs now state that a
session id is a bearer secret.

Also: a keepAlive session is closed when its callback throws; allowedHosts
entries are compared in punycode; a DoH answer with no address is refused.

The Node doubles now model Playwright's rule that a redirect hop never reaches
the interceptor (__tests__/_helpers/fake-launch.ts), with a regression test for
a public URL 302ing to 10.0.0.5. The workerd suite's DoH and /crawl paths run on
workerd's own fetch against a fake internet (miniflare outboundService) instead
of a stubbed global, and drops two input-guard tests the Node suite covers.
* **x402:** BrowserContextLike requires route; PageLike drops route and
gains an optional mainFrame; RouteLike gains fetch and fulfill and is generic
over the response type. Test doubles passed as launch/connect need a context
with route; the real @cloudflare/playwright exports are unaffected.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(x402): map facilitator failures to 502 and stop a pre-paid leak

@x402/core rethrows a FacilitatorResponseError (malformed or timed-out
/verify or /settle answer) out of processHTTPRequest / processSettlement, so it
reached the host as an anonymous 500. The charge middleware now throws
LunoraError X402_FACILITATOR_ERROR (502) with the handler not run; on
settle-after the resource is withheld. Initialisation maps an unreachable
facilitator to the same code and a facilitator that does not settle the network
(RouteConfigurationError) to ENV_INVALID.

A request that already carries PAYMENT-SIGNATURE / X-PAYMENT is now sent as-is.
@x402/fetch answered its 402 by reserving against maxPerRun, signing, then
throwing "Payment already attempted" with the reservation held for the rest of
the run.

maxPerRun's docstring said "wallet lifetime"; it is one rail, which for
ctx.x402 is one function invocation. WalletDeps and GetSecret are gone: wallet.ts
reads getSecret off X402PayDeps.

Tests: facilitator failures at verify, settle and init; ENV_INVALID asserted on
network and recipient errors; the always-passing stray-decimals test dropped;
a workerd case for the pre-paid request. The workerd suites share one facilitator
double (_facilitator.ts) and the Solana challenge moved to the smoke suite.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(codegen): gate ctx.x402 on the secrets capability

ctx.x402 was classified credential-based (x402: null) and emitted on every
target, but the generated rail reads its wallet key through ctx.secrets, which
node and celld rate unsupported: raw-key and CDP custody failed on the first
payment with no build-time signal. It now maps to the secrets feature, so those
targets withhold ctx.x402 with platform_unsupported_feature. Signer custody
still works there through createX402Pay called directly.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* docs(x402,browser): correct the guard, error and platform claims

browser: the README and docs no longer say the guard re-checks every redirect
hop through page.route; they describe the fetch-and-check navigation guard, its
cost (documents are fetched by the Worker), the sub-resource redirects it cannot
see, session ids as bearer secrets, ports not being restricted by allowedHosts,
and DoH answers with no address being refused.

x402: the errors section no longer claims every error is a LunoraError or that
every payment failure is a 402; it lists X402_FACILITATOR_ERROR and what passes
through from @x402/fetch. The platform table follows the codegen secrets gate.
maxPerRun is documented as per invocation, with a durable counter checked in
onPaymentRequired as the way to a cross-run budget.

Also: the from-alpha migration notes cover both packages' breaks, ROADMAP's
experimental-heavy example no longer names browser, and plan 463 marks B3 done
for code, pending maintainer sign-off on bar item 5.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(notify): refuse a send when the DoH re-check cannot complete

shared/ssrf-resolve returned the same "unknown" verdict for an IP-literal host
and for a lookup that failed (timeout, network error, non-200, bad body), and
callers passed both on the string guard. The name's own nameserver can stall the
check on purpose, so that let a rebinding host through. The verdict is now
"skipped" for an IP literal and "failed" for a lookup that could not complete;
one failed address family is enough, since a stalled A lookup next to a public
AAAA answer says nothing about the address the connection will use.

@lunora/notify refuses "failed" like "unresolved" (fail closed) and caches
neither, so the next send after an outage re-checks. The cost is that a DoH
outage stops web-push sends to hosts without allowedPushOrigins; the
allowlist, which skips the re-check, remains the way to avoid it.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(browser): check sub-resource redirects and lock the handed-out guard

Three SSRF gaps from the security review.

DNS fail-open: a DoH lookup that failed or timed out fell back to the string
guard. It now refuses with FORBIDDEN ("DNS ... could not be verified").
Verdicts are cached per hostname for 30s within one guarded context (failed
ones evicted), so a page's hundred assets from one CDN cost one lookup.

Sub-resource redirects: a non-navigation request got a string check and
route.continue(), so <img src> on a public page could 302 to the metadata
endpoint and render into a screenshot. Without allowedHosts, sub-resources now
get every guard (DNS included) and are fetched by the guard with
route.fetch({ maxRedirects: 0 }); each Location is checked and followed with
route.fetch({ url, maxRedirects: 0 }) up to 20 hops, a protocol change is
refused (route.fetch cannot follow it), and the final response is fulfilled.
WebSockets, which never reach a route handler, are checked through
routeWebSocket before they connect. With allowedHosts, Browser Run's session
guardrails enforce the list on every request and hop, so requests are checked
and left in the browser; this also restores the Tunnel config (an internal
host on the allowlist), which Worker-side fetching broke.

Guard lifetime: the browser from launch()/connect() is locked by pinning
members on the live objects (same instance however reached: page.context(),
browser.contexts(), popups via the context's page event). unrouteAll(),
unroute() without a handler, routeFromHAR(), routeWebSocket(), newCDPSession()
and newBrowserCDPSession() throw FORBIDDEN; caller route handlers keep working
but their continue() falls through to the guard and route.fetch() is refused.
Found while doing this and fixed: a caller route registered after the guard ran
first and could continue() past it. A context another connection opens is
withheld from contexts() until its guard lands. This holds against the public
Playwright API, not code reaching its private channels; allowedHosts is the
hard guarantee, as the docs say.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(browser): follow redirect hops like a browser and block workers

Three findings from the security review of aaf603cd6.

Credential leak on redirect: route.fetch({ url }) reuses the original
request's method, headers and body, so a sub-resource hop to another origin
carried Authorization (and any page-set credential header) there, and a POST
answered with 302/303 was re-posted. Each hop is now built by browser rules: a
303 of anything but GET/HEAD and a 301/302 of a POST become a body-less GET; a
cross-origin hop drops Authorization, Proxy-Authorization and Cookie (the
request client re-derives cookies from the jar for the new URL), sends an
opaque Origin and cuts Referer back to its origin.

Authorization state drift: Playwright's request client already stores every
hop's Set-Cookie in the context's jar (context.addCookies) when it fetches.
Fulfilling the final response with its Set-Cookie made Chromium store a second
copy under its own parsing, so a session cookie could exist twice with
diverging attributes. Fulfilled Worker-fetched responses now drop Set-Cookie.

Guard bypass: Playwright's route handlers never see a request a service worker
handles, so a page's worker could fetch a private host and hand the body back
to be rendered. Every context the factory opens, and every one opened from a
guarded launch()/connect() browser, is created with serviceWorkers: "block".
Other candidates (relative and credentialed Location, data:/blob:, srcdoc and
about:blank frames, meta refresh, cache keying, allowPrivateTargets with
allowedHosts) checked out as covered.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* chore(api): keep browser experimental pending a live Browser Run check

Maintainer decision on plan 463 B3: graduate x402 only. browser moves back to
TIER_3 and the experimental lists (ROADMAP, versioning page, README banner)
until the live smoke test passes against a real Browser Run binding: the guard
now rests on route.fetch inside a real session, and the service-worker,
prerender and WebRTC paths are unverified on the real service.

Its exports stay untagged and its snapshot joins container's in
FULLY_TRACKED_SNAPSHOTS, so a tag cannot creep back while it waits. It keeps
its workerd CI leg. The ROADMAP row marks bar item 2 as partial, and plan 463
lists browser as pending live Browser Run verification.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* feat(browser): warn once when a factory runs without allowedHosts

allowedHosts, which Browser Run enforces on the session itself, is now the
documented production configuration. Without it the SSRF guard is a
best-effort check in the Worker, with known limits: speculation-rules
prerenders and WebRTC are not routed, the scope of Domain-less cookies stored
by the request client is unverified, the handed-out lock holds against the
public Playwright API only, and every page asset costs a Worker subrequest.

createBrowser() built without allowedHosts (and without allowPrivateTargets,
which opts out on purpose) warns once per isolate, pointing at allowedHosts,
the same way @lunora/notify warns about a missing allowedPushOrigins. The docs
and README gain a "Production posture" section listing those limits.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(advisor): only allowedHosts contains an arg-derived browser URL

browser_user_url_without_allowlist (WARN) suppressed its findings when the
app's createBrowser pinned resolveDns: true. The DoH re-check is on by default
anyway, and without allowedHosts the whole guard is a best-effort Worker-side
check, so an args-derived URL reaching ctx.browser under it is exactly what the
lint should keep visible. Only allowedHosts, which Browser Run enforces on the
session, suppresses it now.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* test(browser): add a live Browser Run smoke Worker, ready to run

packages/browser/smoke is a Worker that drives the SSRF guard against a real
Browser Run binding, serving its own attacker-like fixtures so nothing
third-party is needed. GET /report answers a JSON pass/fail report:

- default mode: a guarded screenshot (route.fetch/fulfill inside a real
  session), an <img> that 302s to 169.254.169.254 failing with
  BLOCKED_BY_CLIENT, a main-frame redirect to 10.0.0.1 refused, service-worker
  registration blocked, and a cross-origin hop (to this version's preview URL)
  arriving without Authorization;
- allowedHosts mode: an allowed host loads, an off-list host is refused.

scripts/browser-smoke.sh deploys it with wrangler, curls /report and exits
non-zero on any failure. It was not run: it needs a Workers Paid account with
Browser Run. A wrangler --dry-run bundle succeeds. The smoke source is
typechecked and linted with the package (tsconfig include) but is not
published (files: dist) or built (packem bundles src/index.ts only). Teardown:
wrangler delete --config smoke/wrangler.jsonc.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(errors): register the x402 facilitator and browser redirect codes

`X402_FACILITATOR_ERROR` (internal, 502) and `BROWSER_TOO_MANY_REDIRECTS` (502) were minted
without catalog entries, which the catalog-registration test rejects. Also drops a leftover diff3
marker from the rebase in the upgrade guide.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

### Features

* **x402:** graduate to stable adapter; harden browser, keep it experimental (plan 463 B3) ([#1031](https://github.com/anolilab/lunora/issues/1031)) ([0b854d3](https://github.com/anolilab/lunora/commit/0b854d311aa54fe4bd78054aff800cd296b1f140))

## @lunora/x402 [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.82...@lunora/x402@1.0.0-alpha.83) (2026-10-05)


### Dependencies

* **@x402/core:** 2.25.0 → 2.28.0
* **@x402/fetch:** 2.25.0 → 2.28.0

## @lunora/x402 [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.81...@lunora/x402@1.0.0-alpha.82) (2026-10-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.50

## @lunora/x402 [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.80...@lunora/x402@1.0.0-alpha.81) (2026-10-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.49

## @lunora/x402 [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.79...@lunora/x402@1.0.0-alpha.80) (2026-09-30)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.48

## @lunora/x402 [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.78...@lunora/x402@1.0.0-alpha.79) (2026-09-27)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.46

## @lunora/x402 [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.77...@lunora/x402@1.0.0-alpha.78) (2026-09-27)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.45

## @lunora/x402 [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.76...@lunora/x402@1.0.0-alpha.77) (2026-09-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.44

## @lunora/x402 [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.75...@lunora/x402@1.0.0-alpha.76) (2026-09-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.43

## @lunora/x402 [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.74...@lunora/x402@1.0.0-alpha.75) (2026-09-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.42

## @lunora/x402 [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.73...@lunora/x402@1.0.0-alpha.74) (2026-09-24)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.41

## @lunora/x402 [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.72...@lunora/x402@1.0.0-alpha.73) (2026-09-24)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.40

## @lunora/x402 [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.71...@lunora/x402@1.0.0-alpha.72) (2026-09-13)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.39

## @lunora/x402 [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.70...@lunora/x402@1.0.0-alpha.71) (2026-09-13)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.38

## @lunora/x402 [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.69...@lunora/x402@1.0.0-alpha.70) (2026-09-12)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.37

## @lunora/x402 [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.68...@lunora/x402@1.0.0-alpha.69) (2026-09-12)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.36

## @lunora/x402 [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.67...@lunora/x402@1.0.0-alpha.68) (2026-09-12)

## @lunora/x402 [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.66...@lunora/x402@1.0.0-alpha.67) (2026-09-11)

## @lunora/x402 [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.65...@lunora/x402@1.0.0-alpha.66) (2026-09-11)

## @lunora/x402 [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.64...@lunora/x402@1.0.0-alpha.65) (2026-09-10)

## @lunora/x402 [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.63...@lunora/x402@1.0.0-alpha.64) (2026-09-10)

## @lunora/x402 [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.62...@lunora/x402@1.0.0-alpha.63) (2026-09-08)

## @lunora/x402 [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.61...@lunora/x402@1.0.0-alpha.62) (2026-09-08)

## @lunora/x402 [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.60...@lunora/x402@1.0.0-alpha.61) (2026-09-08)

## @lunora/x402 [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.59...@lunora/x402@1.0.0-alpha.60) (2026-09-08)

## @lunora/x402 [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.58...@lunora/x402@1.0.0-alpha.59) (2026-09-08)

## @lunora/x402 [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.57...@lunora/x402@1.0.0-alpha.58) (2026-09-08)

## @lunora/x402 [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.56...@lunora/x402@1.0.0-alpha.57) (2026-09-07)

## @lunora/x402 [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.55...@lunora/x402@1.0.0-alpha.56) (2026-09-07)

### Bug Fixes

* **do,shard-engine,runtime,client:** repair four core-path defects ([#649](https://github.com/anolilab/lunora/issues/649)) ([6fb9990](https://github.com/anolilab/lunora/commit/6fb99906617ed2811020d5d2ddeda16b312f8e03))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.35

## @lunora/x402 [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.54...@lunora/x402@1.0.0-alpha.55) (2026-09-06)

### Bug Fixes

* **agent,ai,ratelimit,x402:** point prettier at the repo ignore file ([#638](https://github.com/anolilab/lunora/issues/638)) ([bf2a8e7](https://github.com/anolilab/lunora/commit/bf2a8e7e50019149ddf3a50f38adbb91f6e0351b))

## @lunora/x402 [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.53...@lunora/x402@1.0.0-alpha.54) (2026-09-06)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.34

## @lunora/x402 [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.52...@lunora/x402@1.0.0-alpha.53) (2026-09-06)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.33

## @lunora/x402 [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.51...@lunora/x402@1.0.0-alpha.52) (2026-09-05)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.32

## @lunora/x402 [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.50...@lunora/x402@1.0.0-alpha.51) (2026-09-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.31

## @lunora/x402 [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.49...@lunora/x402@1.0.0-alpha.50) (2026-09-03)

### Bug Fixes

* audit rounds 14-16 ([#586](https://github.com/anolilab/lunora/issues/586)) ([6a09b74](https://github.com/anolilab/lunora/commit/6a09b746cfc9fb36f451c208b7a1c3eac16e56f4))

## @lunora/x402 [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.48...@lunora/x402@1.0.0-alpha.49) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.30

## @lunora/x402 [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.47...@lunora/x402@1.0.0-alpha.48) (2026-09-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.29

## @lunora/x402 [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.46...@lunora/x402@1.0.0-alpha.47) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.28

## @lunora/x402 [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.45...@lunora/x402@1.0.0-alpha.46) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.27

## @lunora/x402 [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.44...@lunora/x402@1.0.0-alpha.45) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))

## @lunora/x402 [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.43...@lunora/x402@1.0.0-alpha.44) (2026-08-29)

### ⚠ BREAKING CHANGES

* eleven packages now declare peerDependencies. Consumers that
relied on those packages resolving through hoisting must install them; the
alternative was shipping types that fail to resolve off this repo's node_modules.

`@lunora/workflow` is an optional peer of `@lunora/runtime`, so packem inlines
its types rather than importing them — the published `@lunora/runtime` carries no
`@lunora/workflow` dependency, as its source comments already promised.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AWDgSnuBJaeQHfEitB2zeL

* fix: satisfy eslint and the template matrix after the packem gate

Two CI failures from making packem warnings fatal, each a gate that the local
packem sweep does not cover.

`@lunora/advisor` back to a real dependency on `@lunora/errors`. `ae-metrics.ts`
imports `LunoraError` as a VALUE, and import/no-extraneous-dependencies requires
that for anything under `src/` regardless of whether the module reaches the
bundle. packem cannot see it because that module's value exports are
quarantined — `src/index.ts` re-exports only its types — so the throwing code is
tree-shaken out. The two rules disagree by construction; the packem side is now a
commented `unused` exclusion that says which condition would end it.

`@lunora/workflow` becomes a REQUIRED peer of `@lunora/runtime`. As an optional
peer it was auto-installed anyway, and every one of the twelve templates then
resolved `@lunora/workflow` from the npm REGISTRY instead of this checkout — the
scaffold matrix builds its local-tarball map from required peers only, on the
assumption that optional ones are never pulled in. Forcing the type to inline
instead (`resolveExternals.exclude`) does not work: that option governs the JS
bundle, and the declaration build has its own resolver, so the import survived.
A required peer matches the other seven packages here and keeps the type
resolvable for consumers.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AWDgSnuBJaeQHfEitB2zeL

### Build System

* ship .mjs everywhere and make packem warnings fatal ([#526](https://github.com/anolilab/lunora/issues/526)) ([b3eaacc](https://github.com/anolilab/lunora/commit/b3eaacc5a31fe4634a5f4a6c59fda6fbbc8315e1))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.26

## @lunora/x402 [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.42...@lunora/x402@1.0.0-alpha.43) (2026-08-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25

## @lunora/x402 [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.41...@lunora/x402@1.0.0-alpha.42) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24

## @lunora/x402 [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.40...@lunora/x402@1.0.0-alpha.41) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23

## @lunora/x402 [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.39...@lunora/x402@1.0.0-alpha.40) (2026-08-25)

### ⚠ BREAKING CHANGES

* **runtime:** `serveStorageObject`'s structural storage parameter now
requires `head` alongside `download`. `@lunora/storage` provides it (with
its own fallback to a 0-length ranged `get()` on a binding with no HEAD);
a hand-rolled double must add it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EjmVJXmP8D1Amh6t49vS4T

* refactor(shared): extract memoizePromise, stop poisoning the HMAC key cache

Three lazily-built async singletons had each hand-rolled the same keyed
memo: look the key up, store the PROMISE so concurrent callers coalesce
onto one run, drop the entry if it rejects. `shared/promise-memo.ts` is
the one definition; `@lunora/mcp`'s per-tool charge middleware,
`@lunora/x402`'s per-procedure one, and the per-secret HMAC key cache now
use it.

It also fixes two bugs the copies had between them.

`shared/hmac-url.ts` never evicted on rejection at all, so a single failed
`crypto.subtle.importKey` stayed in the map and every later verify against
that secret was served the original failure for the isolate's whole life.

The two that did evict deleted whatever sat under the key at rejection
time, not necessarily their own entry. A slow first attempt failing after
a healthy retry had taken the slot would delete that retry. The shared
helper compares identity before deleting, so an entry can only ever evict
itself.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EjmVJXmP8D1Amh6t49vS4T

* feat(runtime): store the declared REST cache policy at the edge

`.expose({ rest: true, cache })` emitted `Cache-Control` and `Vary` and
stopped there. A response a Worker GENERATES is not stored by the colo
cache on its own, so the declared policy bought browser revalidation and
nothing else — every request still paid a shard dispatch. `caches.default`
was used exactly zero times in the repo.

`rest-edge-cache` adds the missing half: a `match` before dispatch and a
`waitUntil`-deferred `put` after, wrapped in the guards that make storing
a procedure-backed response safe rather than a cross-user leak.

- Only a genuinely anonymous, effective-`public` exchange is stored,
  reusing the credential check the header path already applies. A
  declared-`private` policy is never stored: it is caller-specific by
  definition and this cache is shared by everyone hitting the colo.
- `Vary` is enforced in the KEY. Cloudflare's cache honours `Vary` for
  `Accept-Encoding` only, so a body that varies on `x-lunora-shard-key`
  would otherwise be handed to a caller with a different key. Every
  varying header's value is folded into the stored URL, which turns the
  hazard into a miss.
- The lookup runs after the rate-limit gate, the order a CDN uses: a hit
  still costs a Worker invocation and is still the caller's request, so it
  is metered — it just skips the shard.
- A cache read or write that rejects is treated as a miss, never as a
  failed request.

`@lunora/platform` gains the `HttpCacheLike` contract and rates `httpCache`
in both matrices: `native` on Cloudflare, `unsupported` on Node, where the
surface degrades to emitting `Cache-Control` alone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EjmVJXmP8D1Amh6t49vS4T

* fix(runtime): let createWorker reach the REST edge cache, and test the wiring

`buildRestRoutes` took an `edgeCache` dep that `createWorker` never
forwarded, so the documented opt-out was unreachable for anyone going
through the normal entry point — and nothing could inject a double either,
which is why the gap survived review. `restEdgeCache` now plumbs through,
mirroring `restRateLimit`. It is forwarded when PRESENT rather than when
truthy, since `null` is the meaningful opt-out value.

The unit tests covered `rest-edge-cache`'s store/lookup decisions in
isolation but nothing exercised what the route does with them. Added, at
the `createWorker` level where a shard spy can count dispatches:

- a second identical request is served from the cache with NO second shard
  dispatch (this is the whole feature, and it was unasserted)
- a credentialed caller stores nothing and dispatches every time
- the rate-limit gate is consulted BEFORE the cache, so a warm entry does
  not hand a limited caller a free body
- `restEdgeCache: null` keeps the declared `Cache-Control` on the wire
  while storing nothing
- an endpoint with no declared policy is never stored

Plus `defaultHttpCache` (absent `caches`, present, and a throwing accessor),
and one for `serveStorageObject`'s 206 headers coming from the head rather
than the ranged read — a deliberate choice that no test pinned, so nothing
would have caught it flipping.

Each new assertion was mutation-checked: reverting the plumbing, moving the
lookup ahead of the limiter, and swapping the 206 header source each fail
exactly the test that claims to cover them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EjmVJXmP8D1Amh6t49vS4T

* fix(runtime): keep paid and per-caller responses out of the edge cache

The edge cache sat upstream of the x402 charge gate, which runs inside
`invokeExposed`. A hit returned before dispatch, so it ran neither the
challenge nor the settlement — and `x-payment` was in no credential list,
so a payer read as anonymous and their 200 was stored. Every later caller
in that colo got the paid body free, together with the payer's
`X-PAYMENT-RESPONSE` receipt, for the whole `maxAge`.

`x-payment` is now a credential header, so a paid exchange is `private` on
the header path and unstorable on the cache path by the same derivation. A
response carrying a settlement receipt is refused separately — a second
lock on a money path.

That derivation is now singular. `effectiveRestScope` is the one answer to
"may a shared cache have this", called by both halves; the store no longer
re-derives scope and credentials for itself, where gaining a credential
source on one side alone would have silently stored a per-caller body.

Also closed, all of them reachable without an attacker:

- `__lunora_vary` was documented as reserved but nothing reserved it. It
  reached the procedure as an argument while `set` overwrote it in the key,
  making it the one query key a caller could vary without varying the key.
  It is now excluded from args and deleted before the key is built.
- A shard response's `x-d1-bookmark` / `x-lunora-shard-key` were stored and
  replayed, so a caller holding a newer bookmark could adopt a stale one and
  lose read-your-writes. Both are dropped from the stored copy.
- `applyRestCache` merges the procedure's own `Vary` into the emitted
  header, but the key folds only the policy's names, so a response could
  advertise more than the key fenced. Storing now requires the advertised
  set to be fenced; `Vary: *` never stores.
- The store path evaluated the key and `clone()` as arguments, outside its
  `.catch`. A policy with a malformed `vary` (`"Accept Language"`) made
  `Headers.get` throw and turned every request to that endpoint into a 500 —
  for a policy that emitted a valid `Vary` header before. Both paths now
  degrade to a miss, as the read path already did.
- `X-Lunora-Edge-Cache` is CORS-exposed, so the browser clients the docs
  point at it can actually read it.

Structurally, the two `undefined`-threading functions become one per-route
builder: what a policy decides on its own is decided once at construction,
and a route that can never edge-cache has no cache code path at all. Only
the cache handle stays late-bound, since `caches.default` cannot be read at
construction time in workerd. The seven exports with no consumers are gone
from the package surface rather than frozen in two snapshots.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017M3tmDNVKV9Dq3GSVTcvYL

* fix(storage): make head serializable, declared, and stubbed

Three ways the new body-free read did not survive contact with a caller.

`head()` returned `download()`'s `withSha256` Proxy. That Proxy exists to
keep R2's native body accessors alive, and its own docblock says why it must
not be used for a body-free read: a Proxy over a non-extensible host object
cannot advertise the synthetic checksum fields as own keys, so
`JSON.stringify` drops them. A head result is exactly what a query returns,
so `sha256`/`sha256Base64` vanished on the wire. It now uses the same
`toListObject` projection `list()` does. The test could not catch it — it
asserted by property access, which the get trap serves, against an
extensible object literal — so it now round-trips through JSON against a
`preventExtensions`'d double.

`ctx.storage.head` was documented in the capability table and the file-storage
guide but declared on neither `ReadOnlyStorage` nor `Storage`, so calling it
was a type error. It is declared now, returning `StorageObjectHead` — the
richer public mirror an HTTP layer needs, keeping the validator, the base64
digest and `uploaded` as a `Date`.

Codegen's `storageStub` did not list `head`, so an app with no storage
configured met `TypeError: context.storage.head is not a function` on any
ranged request instead of the "no storage configured" message every other
operation gives.

Separately: a `Range` that cannot produce a 206 anyway — absent, multi-range,
malformed — no longer pays for a metadata read it then discards, which also
closes the window where the object could vanish between the two reads and
turn a 200 into a 404. The full-object answer is decidable from the header
alone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017M3tmDNVKV9Dq3GSVTcvYL

* refactor(shared): bound memoizePromise by size, not by callback

`onInsert` was an extension point with one consumer, on a helper whose whole
justification is that three call sites were the same shape. The thing that
one consumer did with it — `evictOldestEntry(map, capacity)` — is what
`evict-oldest`'s contract already assumes: "every caller inserts exactly one
entry immediately after calling". A `maxEntries` bound makes that structural
instead of a promise each caller keeps, with no closure per call.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017M3tmDNVKV9Dq3GSVTcvYL

### Features

* **runtime:** store the declared REST cache policy at the edge ([#476](https://github.com/anolilab/lunora/issues/476)) ([9ababee](https://github.com/anolilab/lunora/commit/9ababeebc68cd74adfef5d923cfa9e1d70f0f690))

## @lunora/x402 [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/@lunora/x402@1.0.0-alpha.38...@lunora/x402@1.0.0-alpha.39) (2026-08-23)

### ⚠ BREAKING CHANGES

* **x402:** consumers must now install the peer(s) for their
chain family — @x402/evm + viem for EVM networks, @x402/svm +
@solana/kit for Solana (pre-1.0 alpha install-shape change).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(x402): only blame the peer when it is missing

The optional-peer guards caught every dynamic-import failure and
reported "install the peer", so an installed-but-broken toolchain
(runtime incompatibility, bad transitive dep, a throw at evaluation
time) named the wrong cause and lost the original error. Extract one
importOptionalPeer helper that matches module-not-found by error code
or message — walking the cause chain, since loaders wrap it — rethrows
everything else untouched, and attaches the original as cause. All
seven guards, including the pre-existing CDP one, route through it.

resolveEvmAccount now returns the structural ClientEvmSigner instead
of viem's PrivateKeyAccount, keeping viem out of the published
declarations so consumers without the peer can still type-check.
README documents which peers each network family needs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

### Bug Fixes

* **x402:** parse release amounts, slim deps ([#436](https://github.com/anolilab/lunora/issues/436)) ([2daa83c](https://github.com/anolilab/lunora/commit/2daa83c225fcd0c5a60b0d1a636bd753113b6860))

### Build System

* migrate to @cloudflare/vitest-plugin v1 ([#470](https://github.com/anolilab/lunora/issues/470)) ([05c4937](https://github.com/anolilab/lunora/commit/05c49371c30d65907eec8719f27a117f9bcaaefc))

## @lunora/x402 [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.37...%40lunora%2Fx402%401.0.0-alpha.38) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22

## @lunora/x402 [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.36...%40lunora%2Fx402%401.0.0-alpha.37) (2026-08-12)

## @lunora/x402 [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.35...%40lunora%2Fx402%401.0.0-alpha.36) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21

## @lunora/x402 [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.34...%40lunora%2Fx402%401.0.0-alpha.35) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20

## @lunora/x402 [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.33...%40lunora%2Fx402%401.0.0-alpha.34) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18

## @lunora/x402 [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.32...%40lunora%2Fx402%401.0.0-alpha.33) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17

## @lunora/x402 [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.31...%40lunora%2Fx402%401.0.0-alpha.32) (2026-08-07)

## @lunora/x402 [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.30...%40lunora%2Fx402%401.0.0-alpha.31) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16

## @lunora/x402 [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.29...%40lunora%2Fx402%401.0.0-alpha.30) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15

## @lunora/x402 [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.28...%40lunora%2Fx402%401.0.0-alpha.29) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14

## @lunora/x402 [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.27...%40lunora%2Fx402%401.0.0-alpha.28) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13

## @lunora/x402 [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.26...%40lunora%2Fx402%401.0.0-alpha.27) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12

## @lunora/x402 [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.25...%40lunora%2Fx402%401.0.0-alpha.26) (2026-08-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.11

## @lunora/x402 [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.24...%40lunora%2Fx402%401.0.0-alpha.25) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10

## @lunora/x402 [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.23...%40lunora%2Fx402%401.0.0-alpha.24) (2026-07-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.9

## @lunora/x402 [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.22...%40lunora%2Fx402%401.0.0-alpha.23) (2026-07-28)

## @lunora/x402 [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.21...%40lunora%2Fx402%401.0.0-alpha.22) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.20...%40lunora%2Fx402%401.0.0-alpha.21) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.19...%40lunora%2Fx402%401.0.0-alpha.20) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.18...%40lunora%2Fx402%401.0.0-alpha.19) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.17...%40lunora%2Fx402%401.0.0-alpha.18) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.16...%40lunora%2Fx402%401.0.0-alpha.17) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.15...%40lunora%2Fx402%401.0.0-alpha.16) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.14...%40lunora%2Fx402%401.0.0-alpha.15) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.13...%40lunora%2Fx402%401.0.0-alpha.14) (2026-07-27)

## @lunora/x402 [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.12...%40lunora%2Fx402%401.0.0-alpha.13) (2026-07-26)

## @lunora/x402 [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.11...%40lunora%2Fx402%401.0.0-alpha.12) (2026-07-26)

## @lunora/x402 [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.10...%40lunora%2Fx402%401.0.0-alpha.11) (2026-07-26)

## @lunora/x402 [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.9...%40lunora%2Fx402%401.0.0-alpha.10) (2026-07-26)

## @lunora/x402 [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.8...%40lunora%2Fx402%401.0.0-alpha.9) (2026-07-26)

## @lunora/x402 [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.7...%40lunora%2Fx402%401.0.0-alpha.8) (2026-07-26)

## @lunora/x402 [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.6...%40lunora%2Fx402%401.0.0-alpha.7) (2026-07-25)

## @lunora/x402 [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.5...%40lunora%2Fx402%401.0.0-alpha.6) (2026-07-25)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.8

## @lunora/x402 [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.4...%40lunora%2Fx402%401.0.0-alpha.5) (2026-07-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.6

## @lunora/x402 [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.3...%40lunora%2Fx402%401.0.0-alpha.4) (2026-07-19)

## @lunora/x402 [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.2...%40lunora%2Fx402%401.0.0-alpha.3) (2026-07-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.5

## @lunora/x402 [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/%40lunora%2Fx402%401.0.0-alpha.1...%40lunora%2Fx402%401.0.0-alpha.2) (2026-07-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.4

## @lunora/x402 1.0.0-alpha.1 (2026-07-10)
