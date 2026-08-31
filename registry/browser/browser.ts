/**
 * Browser rendering — added by `lunora registry add browser`.
 *
 * Headless browser screenshots, PDF capture, and HTML scraping via
 * ctx.browser in actions. Powered by Cloudflare Browser Rendering
 * (@cloudflare/playwright).
 *
 * Requires the BROWSER binding in wrangler.jsonc (added by this item)
 * and a Browser Rendering provisioned in your Cloudflare dashboard.
 *
 * Usage:
 *   const png = await ctx.browser.screenshot("https://example.com");
 *   const pdf = await ctx.browser.pdf("https://example.com/report");
 *   const text = await ctx.browser.scrape("https://example.com", (page) => page.innerText("body"));
 *
 * **Rendering a caller-supplied URL is a server-side request forgery (SSRF)
 * sink, and a metered one.** Lunora `action`s are public RPC, so an unguarded
 * `screenshot({ url })` lets any anonymous caller make YOUR Browser Rendering
 * instance fetch any URL and hand back the rendered bytes — including your own
 * private routes and internal hostnames reachable from Cloudflare's fleet — and
 * bill you for every render. So the handlers here fail closed on three axes:
 *
 *   1. **Auth** — {@link requireUser} rejects unauthenticated callers.
 *   2. **Target** — {@link assertAllowedTarget} accepts only `https:` URLs whose
 *      host is in {@link ALLOWED_RENDER_HOSTS}, which ships **empty**: nothing
 *      renders until you list the hosts you actually render.
 *   3. **Rate** — a per-caller token bucket, so an authenticated account can't
 *      run your Browser Rendering bill up on its own.
 *
 * Pin the same allowlist on the browser itself in your Worker entry, so the
 * guarantee does not depend on this file staying edited:
 *
 * ```ts
 * import { launch } from "@cloudflare/playwright";
 * import { createBrowser } from "@lunora/browser";
 *
 * createShardDO({
 *     browser: (env) => createBrowser({ allowedHosts: ["example.com"], binding: env.BROWSER, launch }),
 * });
 * ```
 *
 * `createBrowser`'s `allowedHosts` is the hard guarantee (it is enforced on
 * every navigation *and* every subresource request, and it is what satisfies the
 * `browser_user_url_without_allowlist` advisor lint); the check in this file is
 * the fail-closed default for the window before you have configured it.
 */
import { RateLimiter, createMemoryStore, rateLimit } from "@lunora/ratelimit";

import { action, v } from "#lunora/_generated/server.js";

/**
 * Hosts this deployment may render, matched case-insensitively against the
 * URL's hostname (exact match — no subdomain wildcards, deliberately). Ships
 * **empty**, so every render is refused until you edit it: a browser action that
 * renders anything the caller names is an open proxy, and "works out of the box"
 * is the wrong default for that. Add only hosts you control or intend to fetch.
 */
const ALLOWED_RENDER_HOSTS: ReadonlySet<string> = new Set<string>([
    // "example.com",
]);

/**
 * Per-caller rate limit on the render endpoints — Browser Rendering is metered,
 * so an unbounded endpoint is a billing DoS even behind auth. The default store
 * is in-memory (per-isolate, resets on eviction); run `lunora add ratelimit` for
 * the durable, `ctx.db`-backed store in production, and tune the rate to your
 * render volume.
 */
const limiter = new RateLimiter({
    config: {
        render: { kind: "token bucket", period: 60_000, rate: 10 },
    },
    store: createMemoryStore(),
});

/**
 * Rate-limit key used at every `.use(...)` site below: the authenticated caller,
 * falling back to the server-trusted `ctx.ip` (Cloudflare's `CF-Connecting-IP`,
 * forwarded server-side, never read from a client header) so anonymous traffic
 * can't share — and exhaust — one global `"anon"` bucket.
 */

/**
 * The caller's id, or a clear failure. Fails closed: an unauthenticated caller
 * gets no render at all, rather than an anonymous share of your metered quota.
 */
const requireUser = (userId: string | null): string => {
    if (userId === null || userId === undefined) {
        throw new Error(
            "@lunora/browser registry item: this endpoint requires an authenticated user. Pass `resolveIdentity` to `createWorker` (see the auth registry item), or add a deliberate public path with its own allowlist.",
        );
    }

    return userId;
};

/**
 * Validate a caller-supplied render target: `https:` only, host in
 * {@link ALLOWED_RENDER_HOSTS}. `https:`-only rules out `file:`, `data:`, and
 * plaintext `http:` to internal services; the host allowlist is what stops the
 * browser being pointed at your own private routes or a link-local metadata
 * address. Returns the normalised URL to render.
 */
const assertAllowedTarget = (url: string): string => {
    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`@lunora/browser registry item: \`${url}\` is not a valid URL.`);
    }

    if (parsed.protocol !== "https:") {
        throw new Error(`@lunora/browser registry item: only https: URLs may be rendered (got \`${parsed.protocol}\`).`);
    }

    if (!ALLOWED_RENDER_HOSTS.has(parsed.hostname.toLowerCase())) {
        throw new Error(
            `@lunora/browser registry item: host \`${parsed.hostname}\` is not in ALLOWED_RENDER_HOSTS — add it there, and to \`createBrowser({ allowedHosts })\` in your Worker entry.`,
        );
    }

    return parsed.toString();
};

/**
 * Capture a screenshot of an allowlisted URL. The browser is launched in a remote
 * Cloudflare Browser Rendering instance — bytes never touch your Worker.
 */
export const screenshot = action
    .input({
        height: v.optional(v.number()),
        url: v.string().meta({ schema: { maxLength: 2048 } }),
        width: v.optional(v.number()),
    })
    .use(rateLimit(limiter, "render", { key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anon" }))
    .action(async ({ args: { height, url, width }, ctx }) => {
        requireUser(ctx.auth.userId);

        const png = await ctx.browser.screenshot(assertAllowedTarget(url), {
            viewport: width !== undefined && height !== undefined ? { width, height } : undefined,
        });

        return { png: [...png] };
    });

/** Capture a PDF of an allowlisted URL. */
export const pdf = action
    .input({ url: v.string().meta({ schema: { maxLength: 2048 } }) })
    .use(rateLimit(limiter, "render", { key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anon" }))
    .action(async ({ args: { url }, ctx }) => {
        requireUser(ctx.auth.userId);

        const pdfBytes = await ctx.browser.pdf(assertAllowedTarget(url), { format: "A4" });

        return { pdf: [...pdfBytes] };
    });
