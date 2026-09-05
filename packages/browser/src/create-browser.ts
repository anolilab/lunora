import { LunoraError } from "@lunora/errors";

import { isPrivateHost, normalizeHost } from "../../../shared/ssrf-host";
import { resolveHostSsrf } from "../../../shared/ssrf-resolve";
import type {
    Browser,
    BrowserLaunchLike,
    BrowserLike,
    BrowserSession,
    LunoraBrowserOptions,
    NavigateOptions,
    PageLike,
    PdfOptions,
    RouteLike,
    ScreenshotOptions,
} from "./types";

/** Default navigation timeout when neither the call nor the factory sets one. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Hard ceiling on any navigation timeout — a hung page can't pin the worker forever. */
const MAX_TIMEOUT_MS = 120_000;

/** Hard caps on a requested viewport so a caller can't ask for a multi-million-pixel render. */
const MAX_VIEWPORT_WIDTH = 3840;
const MAX_VIEWPORT_HEIGHT = 4320;

/**
 * The window Browser Rendering accepts for `keep_alive`, expressed in the
 * SECONDS this package's `launch({ keepAlive })` takes (the provider's own unit
 * is milliseconds: `keep_alive?: number // from 10_000ms to 600_000ms`).
 *
 * Outside it the launch is rejected by the provider, so a `keepAlive: 1` or
 * `keepAlive: 3600` reaches Cloudflare only to come back as an opaque launch
 * failure — after the caller has already been told, by this package's own
 * types, that any finite positive number of seconds holds the session open.
 * Checking it here names the bound that was actually violated.
 */
const MIN_KEEP_ALIVE_SECONDS = 10;
const MAX_KEEP_ALIVE_SECONDS = 600;

/**
 * Hard ceiling on a single DoH lookup. Without it the `fetch` could stall
 * indefinitely and pin the worker before the browser even launches — a hung
 * resolver would defeat the whole point of paying for the pre-launch re-check.
 * The caller reuses the (smaller of the) navigation timeout budget, capped here.
 * Named `CEILING` rather than `TIMEOUT` because it is a `Math.min` bound on the
 * caller's own budget, not the value passed through — and so it can't be read as
 * the shared resolver's own (smaller) default.
 */
const DOH_CEILING_MS = 5000;

/**
 * DNS-rebinding re-check for a validated navigation target: throws when the
 * host resolves to a private/internal address. The resolution + classification
 * live in the shared `resolveHostSsrf` helper (see its docblock for the
 * best-effort semantics — IP literals skipped, a failed lookup falls back to the
 * string guard, never fail-open on an address that DID resolve private); this
 * only turns a `"private"` verdict into the package's own user-facing refusal.
 */
const assertResolvedHostIsPublic = async (target: string, timeoutMs: number = DOH_CEILING_MS): Promise<void> => {
    const host = normalizeHost(new URL(target).hostname);
    const resolution = await resolveHostSsrf(host, timeoutMs);

    if (resolution.kind === "private") {
        throw new LunoraError(
            "FORBIDDEN",
            `@lunora/browser: url host "${host}" resolves to a private/internal address (${resolution.address}); refusing to navigate (DNS-rebinding guard)`,
        );
    }
};

/**
 * Validate a caller-supplied navigation URL. The boundary, in order:
 *
 * - Scheme — only absolute `http(s)`. A non-string, empty, relative, or non-`http(s)`
 * value (`javascript:`, `file:`, `ftp:`, `data:`) never reaches the headless browser,
 * so a hostile caller can't drive it at a local file or a non-network scheme.
 * - Credentials — a `user:pass@host` userinfo component is rejected: page navigation
 * never needs it, and it's a credential-leak / host-spoof smell.
 * - Host allowlist — when `allowedHosts` is set (non-empty), the hostname must match
 * one of its entries exactly (case-insensitive, trailing-dot-normalized, IPv6 brackets
 * stripped); anything else is refused. This is the one guard that fully closes DNS
 * rebinding for a URL boundary that accepts client-controlled hosts.
 * - SSRF target — unless `allowPrivateTargets` is set, a private / internal / loopback
 * / link-local host is refused (see the shared `isPrivateHost` classifier). Browser Rendering egresses
 * from Cloudflare's network, but a private-network binding / Cloudflare Tunnel can still
 * make such hosts reachable, so default-deny is the safe posture; trusted internal use
 * opts in explicitly.
 *
 * Returns the normalized absolute URL string. This string check classifies the host
 * as-written — it does **not** resolve DNS. So on its own, a PUBLIC hostname that
 * resolves — via attacker-controlled DNS — to a private/metadata IP is NOT blocked
 * here (classic DNS rebinding). That gap is closed by the `resolveDns` re-check the
 * caller applies before `page.goto` (on by default when no `allowedHosts` is set);
 * `allowedHosts` is itself the hard guarantee when the reachable hosts are known.
 *
 * This validates the INITIAL navigation target. A 3xx redirect can point the
 * headless browser at a different (possibly private) host, so `withPage`
 * additionally re-runs these same checks on every main-frame navigation request
 * via `page.route` interception (when the injected page supports it) — closing
 * the redirect-to-private-target SSRF gap that a one-shot initial-URL check left
 * open.
 */
const validateUrl = (url: string, allowPrivateTargets: boolean, allowedHosts?: ReadonlyArray<string>): string => {
    // Caller-supplied URL faults are BAD_REQUEST, not INTERNAL: they carry
    // actionable, client-safe text and must present as 4xx with the message
    // intact — never as a redacted 500 (see @lunora/errors' toErrorBody).
    if (typeof url !== "string" || url.length === 0) {
        throw new LunoraError("BAD_REQUEST", "@lunora/browser: url must be a non-empty string");
    }

    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        throw new LunoraError("BAD_REQUEST", `@lunora/browser: url must be an absolute http(s) URL (got "${url}")`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new LunoraError("BAD_REQUEST", `@lunora/browser: url protocol must be http(s) (got "${parsed.protocol}")`);
    }

    if (parsed.username !== "" || parsed.password !== "") {
        throw new LunoraError("BAD_REQUEST", "@lunora/browser: url must not embed credentials (strip the `user:pass@` userinfo)"); // gitleaks:allow -- illustrative error text, not a credential
    }

    if (allowedHosts && allowedHosts.length > 0) {
        const host = normalizeHost(parsed.hostname);

        if (!allowedHosts.some((entry) => normalizeHost(entry) === host)) {
            throw new LunoraError("FORBIDDEN", `@lunora/browser: url host "${parsed.hostname}" is not in the configured allowedHosts allowlist`);
        }
    }

    if (!allowPrivateTargets && isPrivateHost(parsed.hostname)) {
        // FORBIDDEN (403), matching the sibling SSRF refusals (allowlist mismatch
        // above, DNS-rebinding re-check) — the same class of refusal must present
        // identically on the wire, message intact, not as a redacted 500.
        throw new LunoraError(
            "FORBIDDEN",
            `@lunora/browser: url host "${parsed.hostname}" is a private/internal address; pass createBrowser({ …, allowPrivateTargets: true }) to allow it`,
        );
    }

    return parsed.toString();
};

/** Clamp one viewport dimension into `[1, max]`; a non-finite request (NaN/Infinity) falls back to `max`. */
const clampDimension = (value: number, max: number): number => {
    if (!Number.isFinite(value)) {
        return max;
    }

    return Math.min(Math.max(1, Math.floor(value)), max);
};

/** Clamp a requested viewport to the hard caps; both dimensions floored to >= 1 (non-finite → the cap). */
const clampViewport = (viewport: { height: number; width: number }): { height: number; width: number } => {
    return {
        height: clampDimension(viewport.height, MAX_VIEWPORT_HEIGHT),
        width: clampDimension(viewport.width, MAX_VIEWPORT_WIDTH),
    };
};

/**
 * Resolve and clamp a navigation timeout from the per-call + factory defaults.
 * A non-finite request (NaN/Infinity, which `??` cannot catch) falls back to the
 * default so a bad caller value can't disable the timeout.
 */
const resolveTimeout = (callTimeout: number | undefined, factoryTimeout: number | undefined): number => {
    const requested = callTimeout ?? factoryTimeout ?? DEFAULT_TIMEOUT_MS;
    const safe = Number.isFinite(requested) ? requested : DEFAULT_TIMEOUT_MS;

    return Math.min(Math.max(1, Math.floor(safe)), MAX_TIMEOUT_MS);
};

/**
 * Race `operation` against a hard `timeoutMs` deadline. `page.goto`'s own
 * `timeout` bounds only the navigation phase — `page.evaluate` (scrape),
 * `page.pdf`, `page.content`, and `page.screenshot` take no timeout, so a
 * hostile page that traps the operation post-navigation would otherwise pin the
 * worker until the platform limit kills it (holding the billed Browser Rendering
 * session open). Racing the whole goto+operation sequence against the resolved
 * budget honours the documented "navigation + operation" invariant; the browser
 * is torn down by `withBrowser`'s `finally` when the deadline rejects. The
 * timer is always cleared so a completed operation never keeps the runtime alive.
 */
const withDeadline = async <T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            operation(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(
                        new LunoraError("BROWSER_TIMEOUT", `@lunora/browser: navigation + operation exceeded the ${String(timeoutMs)}ms timeout budget`, {
                            status: 504,
                        }),
                    );
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
};

/**
 * Close a browser, swallowing any close failure: the session is being torn down
 * anyway, and a close failure must not mask the caller's result/error.
 */
const closeQuietly = async (browser: BrowserLike): Promise<void> => {
    try {
        await browser.close();
    } catch {
        // Swallowed — see above.
    }
};

/**
 * `createBrowser` is part of the experimental `@lunora/browser` API and may change without a major version bump.
 * @experimental
 */
// eslint-disable-next-line import/prefer-default-export -- named export: the package barrel re-exports by name, per the repo's no-default-mixing convention
export const createBrowser = (options: LunoraBrowserOptions): Browser => {
    // Defensive runtime guard: `binding` is required by the type, but JS callers
    // (and `createBrowser({})` misuse) can omit it.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the type
    if (!options.binding) {
        throw new TypeError("@lunora/browser: `binding` is required (env.BROWSER)");
    }

    const getLaunch = (): BrowserLaunchLike => {
        if (!options.launch) {
            throw new LunoraError(
                "INTERNAL",
                '@lunora/browser: `launch` is not available — install the `@cloudflare/playwright` peer dependency. The generated worker wires it for you; outside codegen pass it via createBrowser({ binding, launch }) (import { launch } from "@cloudflare/playwright").',
            );
        }

        return options.launch;
    };

    /** Same injection contract as {@link getLaunch}, for the session surface. */
    const requirePeer = <F>(function_: F | undefined, name: string): F => {
        if (!function_) {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/browser: \`${name}\` is not available — install the \`@cloudflare/playwright\` peer dependency. The generated worker wires it for you; outside codegen pass it via createBrowser({ binding, ${name} }).`,
            );
        }

        return function_;
    };

    /**
     * Launch a browser, run `use`, and **always** close the browser in a
     * `finally` — a leaked Browser Rendering session is billed and rate-limited,
     * so this is the one real footgun. The close error is swallowed (we never
     * mask the caller's original error with a close failure).
     */
    const withBrowser = async <T>(use: (browser: BrowserLike) => Promise<T>, requestedKeepAlive?: number): Promise<T> => {
        // Only a FINITE, POSITIVE duration asks for a held-open session. `0` is
        // the natural spelling of "do not keep alive", and what a `Number(...)`
        // over an unset env var yields; `NaN` is what a failed parse of one
        // yields. Treating either as a
        // keep-alive request both sent a nonsense `keep_alive` AND skipped the
        // always-close `finally`, leaking exactly the billed session that
        // `finally` exists to prevent. The sibling numeric inputs are
        // non-finite-safe the same way — see `resolveTimeout`, `clampDimension`.
        const keepAlive = requestedKeepAlive !== undefined && Number.isFinite(requestedKeepAlive) && requestedKeepAlive > 0 ? requestedKeepAlive : undefined;

        // A positive duration outside the provider's window is a DIFFERENT
        // failure from the ambiguous values above: the caller did ask for a
        // held-open session, and Browser Rendering will refuse the launch. Say
        // which bound was missed rather than forwarding it and surfacing a
        // provider error, and rather than silently degrading to the always-close
        // path (which would hand back a session id that is already dead).
        if (keepAlive !== undefined && (keepAlive < MIN_KEEP_ALIVE_SECONDS || keepAlive > MAX_KEEP_ALIVE_SECONDS)) {
            throw new LunoraError(
                "BAD_REQUEST",
                `@lunora/browser: keepAlive must be between ${String(MIN_KEEP_ALIVE_SECONDS)} and ${String(
                    MAX_KEEP_ALIVE_SECONDS,
                )} seconds (Browser Rendering accepts keep_alive from 10s to 10min; got ${String(requestedKeepAlive)})`,
            );
        }

        // `keep_alive` (seconds) holds the Browser Rendering session open after
        // this worker detaches so a later `connect(sessionId)` can re-attach.
        // Closing it here would defeat that, so the close is skipped — the
        // session then expires on Cloudflare's clock rather than ours.
        const browser = await getLaunch()(options.binding, keepAlive === undefined ? undefined : { keep_alive: keepAlive * 1000 });

        if (keepAlive !== undefined) {
            return await use(browser);
        }

        try {
            return await use(browser);
        } finally {
            await closeQuietly(browser);
        }
    };

    /**
     * Open a context + page, navigate to `url`, run `use`. The page/context are
     * torn down when the browser is closed by {@link withBrowser}'s `finally`,
     * so a single always-close at the browser level covers the whole chain.
     */
    const withPage = async <T>(
        url: string,
        navigate: NavigateOptions,
        use: (page: PageLike) => Promise<T>,
        viewport?: { height: number; width: number },
    ): Promise<T> => {
        const allowPrivateTargets = options.allowPrivateTargets ?? false;
        const target = validateUrl(url, allowPrivateTargets, options.allowedHosts);
        const timeout = resolveTimeout(navigate.timeoutMs, options.timeoutMs);
        // A configured `allowedHosts` is the STRONGER guard — an exact-origin
        // allowlist closes rebinding outright — and it may deliberately name an
        // internal host reachable over a Tunnel/private-network binding. Running
        // the resolved-address check on top would refuse that documented config,
        // so the allowlist suppresses it, exactly as `allowedPushOrigins` does in
        // `@lunora/notify`. An explicit `resolveDns: true` still forces it on.
        const resolveDns = options.resolveDns ?? (options.allowedHosts?.length ?? 0) === 0;
        // Reuse the navigation timeout budget for the DoH re-check, but never let a
        // single lookup exceed the DoH ceiling — a stalled resolver mustn't burn
        // the full (up to 120s) navigation budget before the browser even launches.
        const dohTimeout = Math.min(timeout, DOH_CEILING_MS);

        // DNS-rebinding re-check: resolve the host and reject if it maps to a
        // private address, before we pay for a browser launch + `page.goto`.
        if (!allowPrivateTargets && resolveDns) {
            await assertResolvedHostIsPublic(target, dohTimeout);
        }

        /**
         * Re-run the initial-URL guards against a request URL the browser is about
         * to navigate to (a redirect target). Throws on a private/off-allowlist
         * host so the caller can fail the request closed.
         */
        const assertNavigationAllowed = async (requestUrl: string): Promise<void> => {
            validateUrl(requestUrl, allowPrivateTargets, options.allowedHosts);

            if (!allowPrivateTargets && resolveDns) {
                await assertResolvedHostIsPublic(requestUrl, dohTimeout);
            }
        };

        /**
         * Sub-resource SSRF guard. A rendered page autonomously issues img/fetch/
         * link/xhr requests; each fires the route handler as a non-navigation
         * request and must not be let through unchecked to a private/internal host.
         *
         * This is a deliberately narrower, string-only check than {@link validateUrl}:
         * it must NOT throw on non-http(s) schemes (`data:`/`blob:`/`about:` inline
         * assets are legitimate and network-unreachable, so they pass), and it must
         * NOT do a per-request DNS lookup (a DoH query per sub-resource would be a
         * DoS footgun). It mirrors validateUrl's allowlist + `isPrivateHost` arms
         * only — including the `allowPrivateTargets` gate on the latter, without
         * which the route handler refuses the very sub-resources of the internal
         * page it was registered to render. Returns `true` when the request should
         * be aborted (fail-closed on an unparseable/private/off-allowlist http(s)
         * host), `false` to continue.
         */
        const isBlockedSubresource = (rawUrl: string): boolean => {
            let parsed: URL;

            try {
                parsed = new URL(rawUrl);
            } catch {
                // Fail closed, as the navigation sibling does. Playwright hands
                // back an absolute URL so this is unreachable in practice, but
                // the two guards must not diverge on the answer to "I could not
                // tell what this is".
                return true;
            }

            // Non-http(s) schemes (data:/blob:/about:) can't reach a network host.
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                return false;
            }

            if (options.allowedHosts && options.allowedHosts.length > 0) {
                const host = normalizeHost(parsed.hostname);

                if (!options.allowedHosts.some((entry) => normalizeHost(entry) === host)) {
                    return true;
                }
            }

            // Gated on `allowPrivateTargets`, exactly as validateUrl's arm is.
            // Ungated, the documented Tunnel config —
            // `{ allowPrivateTargets: true, allowedHosts: ["dashboard.internal"] }`
            // — navigated to the internal page successfully and then aborted
            // every stylesheet, script and image the page loaded from that same
            // allowlisted host, silently returning an unstyled render. The
            // allowlist arm above is NOT relaxed by the flag, so an off-list
            // private host (the metadata endpoint) is still refused.
            return !allowPrivateTargets && isPrivateHost(parsed.hostname);
        };

        return withBrowser(async (browser) => {
            const context = await browser.newContext();
            const page = await context.newPage();

            // Guard the redirect chain: `page.goto` follows 3xx redirects, so a
            // public initial URL can bounce the browser to a private/metadata host.
            // Validate EVERY main-frame navigation request (the redirect targets)
            // with the same checks the initial URL passed, aborting fail-closed on
            // a private/off-allowlist host. Sub-resources (img/fetch/link/xhr) are
            // additionally checked against the private-target/allowlist guard so a
            // hostile page can't probe internal hosts — but public sub-resources and
            // non-http(s) schemes (data:/blob:) still pass so inline/CDN assets keep
            // rendering. If the injected page lacks `route` (an older/fake page), the
            // initial-URL guard still stands.
            //
            // Register whenever we default-deny private targets OR pin to an
            // allowlist: `allowPrivateTargets: true` WITH `allowedHosts` (the
            // documented pin-to-internal-host-via-Tunnel config) must still re-check
            // every redirect hop against the allowlist, not only the initial URL.
            if (page.route && (!allowPrivateTargets || (options.allowedHosts?.length ?? 0) > 0)) {
                await page.route("**/*", async (route: RouteLike) => {
                    const request = route.request();
                    const isNavigation = request.isNavigationRequest?.() ?? true;

                    if (!isNavigation) {
                        if (isBlockedSubresource(request.url())) {
                            await route.abort("blockedbyclient");

                            return;
                        }

                        await route.continue();

                        return;
                    }

                    try {
                        await assertNavigationAllowed(request.url());
                    } catch {
                        await route.abort("blockedbyclient");

                        return;
                    }

                    await route.continue();
                });
            }

            if (viewport && page.setViewportSize) {
                await page.setViewportSize(clampViewport(viewport));
            }

            // Bound the WHOLE navigation + operation against the resolved timeout
            // budget, not just `page.goto` — see {@link withDeadline}. `page.goto`
            // keeps its own `timeout` for a clean navigation-phase abort.
            return withDeadline(async () => {
                await page.goto(target, { timeout, waitUntil: navigate.waitUntil ?? "load" });

                return use(page);
            }, timeout);
        });
    };

    const screenshot = async (url: string, screenshotOptions: ScreenshotOptions = {}): Promise<Uint8Array> =>
        withPage(
            url,
            screenshotOptions,
            async (page) =>
                page.screenshot({
                    fullPage: screenshotOptions.fullPage ?? false,
                    type: screenshotOptions.type ?? "png",
                }),
            screenshotOptions.viewport,
        );

    const pdf = async (url: string, pdfOptions: PdfOptions = {}): Promise<Uint8Array> =>
        withPage(
            url,
            pdfOptions,
            async (page) =>
                page.pdf({
                    format: pdfOptions.format,
                    printBackground: pdfOptions.printBackground ?? false,
                }),
            pdfOptions.viewport,
        );

    const content = async (url: string, navigateOptions: NavigateOptions = {}): Promise<string> =>
        withPage(url, navigateOptions, async (page) => page.content());

    const scrape = async <T>(url: string, function_: (...args: never[]) => T, navigateOptions: NavigateOptions = {}): Promise<T> =>
        withPage(url, navigateOptions, async (page) => page.evaluate(function_));

    const launch = async <T>(function_: (browser: BrowserLike) => Promise<T>, launchOptions: { keepAlive?: number } = {}): Promise<T> =>
        withBrowser(function_, launchOptions.keepAlive);

    /**
     * Re-attach to an existing session. The browser is NOT closed on the way
     * out unless the caller asks — keeping the page alive across separate
     * action invocations is the entire point.
     */
    const connect = async <T>(sessionId: string, function_: (browser: BrowserLike) => Promise<T>, connectOptions: { close?: boolean } = {}): Promise<T> => {
        const browser = await requirePeer(options.connect, "connect")(options.binding, sessionId);

        if (connectOptions.close !== true) {
            return await function_(browser);
        }

        try {
            return await function_(browser);
        } finally {
            await closeQuietly(browser);
        }
    };

    const sessions = async (): Promise<ReadonlyArray<BrowserSession>> => await requirePeer(options.sessions, "sessions")(options.binding);

    return {
        connect,
        content,
        launch,
        pdf,
        scrape,
        screenshot,
        sessions,
    };
};
