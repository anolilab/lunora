/**
 * Is this process running on Cloudflare's edge?
 *
 * The one question that decides whether `cf-connecting-ip` may be believed.
 * Cloudflare stamps that header on every inbound request, overwriting whatever
 * the client sent — so ON the edge it is the only client-address header a caller
 * cannot write. Anywhere else (a `@lunora/platform-node` process taking direct
 * traffic, a container, a bare host) nothing overwrites it and it is a header
 * like any other: trusting it there lets an attacker rotate
 * `Cf-Connecting-IP: 1.2.3.<n>` for a fresh rate-limit bucket per request, which
 * removes the limit from exactly the traffic it exists to stop, and lets them
 * forge whatever `ctx.ip` reports.
 *
 * workerd sets `navigator.userAgent` to `"Cloudflare-Workers"`; Node and every
 * other host this framework targets do not. Read at call time rather than at
 * module scope so a test can stand the global up, and off `globalThis` with an
 * optional chain because it is absent on older runtimes — where the honest
 * answer is "not Cloudflare", which is also the safe one.
 *
 * There must be exactly ONE definition rather than byte-similar inline copies
 * that can drift: `@lunora/auth` gated its IP-header policy on this while
 * `@lunora/runtime` trusted the header unconditionally, so one deployment
 * enforced its sign-in limit per client and its REST limit not at all. What each
 * package then DOES with the answer is its own policy and stays in that package
 * — `@lunora/runtime`'s `trustedClientIp` and `@lunora/auth`'s `trustedProxies`
 * handling already differ, and a shared helper that picked one would hand the
 * other a policy it never chose.
 *
 * ## Why here and not `@lunora/platform`
 *
 * That package is the real alternative, and a good one: it is the zero-dependency
 * leaf every other `@lunora/*` package may import without cycles, it already
 * re-exports a `shared/` file (`ExecutionContextLike`), and it owns
 * `PlatformCapabilities` — the other "which host is this" question. The
 * dependency edge is not the objection; `@lunora/auth` → `@lunora/platform` would
 * be fine. Two things are:
 *
 * 1. Platform's index is **published, permanently-supported API**. This is a
 * one-line sniff at an undocumented workerd detail (`navigator.userAgent`), and
 * its value is being cheap to change the day workerd identifies itself
 * differently. Exporting it buys a compatibility obligation for a string compare.
 * 2. Platform is deliberately declarative — "types and capability metadata only,
 * near-zero runtime code". A static per-target matrix that codegen reads is a
 * different thing from live host detection at request time, and merging the two
 * invites a future reader to ask the matrix what host they are on.
 *
 * `shared/constant-time-equal.ts` and `shared/hmac-url.ts` are the precedent for
 * a security primitive living here. The cost of the choice, stated so it is not
 * a surprise: the vis build cache does not invalidate on `shared/` edits, so a
 * change here needs an explicit rebuild before consumers' `dist/` carries it.
 *
 * Keep it genuinely zero-dependency or inlining breaks, and consumers must drop
 * `outDir`/`rootDir` from their `tsconfig.json` (a set `rootDir` raises TS6059
 * for this out-of-package file under `tsc --noEmit`).
 */
export const onCloudflareEdge = (): boolean => (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";
