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
 * enforced its sign-in limit per client and its REST limit not at all. Like the
 * repo's other `shared/` helpers this is deliberately **not** a package —
 * consumers import it by relative path and the bundler inlines it, so no runtime
 * dependency edge is created between `@lunora/auth` and `@lunora/runtime`. Keep
 * it genuinely zero-dependency or inlining breaks, and consumers must drop
 * `outDir`/`rootDir` from their `tsconfig.json` (a set `rootDir` raises TS6059
 * for this out-of-package file under `tsc --noEmit`).
 */
export const onCloudflareEdge = (): boolean => (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";

/**
 * The caller's IP for a request, or `undefined` when nothing trustworthy says.
 *
 * `cf-connecting-ip` is the only client-address header worth reading, and only
 * where {@link onCloudflareEdge} holds. Off the edge this deliberately resolves
 * NOTHING rather than falling back to `x-forwarded-for` or the raw header: both
 * are client-written there, and an attacker-chosen address is worse than a
 * missing one — it silently defeats every rate limit keyed on it while reading
 * as if the limit were enforced. Callers already handle the absent case (the
 * REST limiter falls into its shared `no-trusted-ip` bucket; `ctx.ip` is
 * documented optional).
 *
 * A host behind a proxy it controls should terminate at something that sets
 * `cf-connecting-ip` itself. `@lunora/auth` additionally accepts declared
 * `trustedProxies`, which is what makes an `x-forwarded-for` chain interpretable;
 * there is no equivalent knob here yet because the runtime has nowhere to
 * declare one, and inventing a second trust switch is worse than none.
 */
export const trustedClientIp = (headers: Headers): string | undefined => (onCloudflareEdge() ? (headers.get("cf-connecting-ip") ?? undefined) : undefined);
