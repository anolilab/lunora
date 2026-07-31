import { LunoraError } from "@lunora/errors";

import { isPrivateHost, isPrivateIpv4, isPrivateIpv6, normalizeHost, parseIpv4 } from "../../../shared/ssrf-host";
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

/** Cloudflare DoH JSON endpoint used for the opt-in `resolveDns` rebinding re-check. */
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/**
 * Hard ceiling on a single DoH lookup. Without it the `fetch` could stall
 * indefinitely and pin the worker before the browser even launches — a hung
 * resolver would defeat the whole point of paying for the pre-launch re-check.
 * The caller reuses the (smaller of the) navigation timeout budget, capped here.
 */
const DOH_TIMEOUT_MS = 5000;

/** DoH `Answer.type` codes we inspect: 1 = A (IPv4), 28 = AAAA (IPv6). */
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

/**
 * Classify a single DoH-resolved IP (its record `type` + `data`) as private.
 * Reuses the same IPv4/IPv6 range tables as the string guard; an A `data` is a
 * dotted quad, an AAAA `data` is an IPv6 literal. An unparseable A record is
 * treated as private (fail-closed), matching {@link parseIpv4} elsewhere.
 */
const isPrivateResolvedIp = (data: string, type: number): boolean => {
    if (type === DNS_TYPE_A) {
        const v4 = parseIpv4(data);

        return v4 === undefined || isPrivateIpv4(v4);
    }

    return isPrivateIpv6(data.toLowerCase());
};

/**
 * Query Cloudflare DoH (JSON `application/dns-json`) for one record `type` of
 * `hostname`. Returns the `Answer` array (possibly empty) on success, or
 * `undefined` if the lookup itself failed (network error / non-200 / unparseable
 * body) so the caller can fall back to the string guard rather than fail-open.
 */
const dohLookup = async (hostname: string, type: number, timeoutMs: number = DOH_TIMEOUT_MS): Promise<{ data: string; type: number }[] | undefined> => {
    try {
        const response = await fetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${String(type)}`, {
            headers: { accept: "application/dns-json" },
            // Bound the lookup so a stalled resolver can't hang the worker; an
            // abort surfaces as a rejection caught below → `undefined` → the
            // caller falls back to the (already-passed) string guard.
            signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
            return undefined;
        }

        const body: { Answer?: { data: string; type: number }[] } = await response.json();

        return body.Answer ?? [];
    } catch {
        return undefined;
    }
};

/**
 * Opt-in DNS-rebinding re-check for a validated navigation target. Resolves the
 * host's A + AAAA records over DoH and throws if any resolved address is
 * private/internal. Best-effort: IP-literal hosts (already classified by the
 * string guard) are skipped, and if BOTH DoH queries fail we return silently and
 * lean on the string guard — we only ever refuse on an address that actually
 * resolved to a private range, never fail-open on one that did.
 */
const assertResolvedHostIsPublic = async (target: string, timeoutMs: number = DOH_TIMEOUT_MS): Promise<void> => {
    const host = normalizeHost(new URL(target).hostname);

    // IP literals can't rebind through DNS and were already classified by the
    // string guard; only a named host needs the resolved-address re-check.
    if (host.includes(":") || parseIpv4(host) !== undefined) {
        return;
    }

    const [aRecords, aaaaRecords] = await Promise.all([dohLookup(host, DNS_TYPE_A, timeoutMs), dohLookup(host, DNS_TYPE_AAAA, timeoutMs)]);

    // Both lookups failed — fall back to the string guard (which already passed)
    // rather than fail-open. If either resolved, inspect what came back.
    if (aRecords === undefined && aaaaRecords === undefined) {
        return;
    }

    for (const answer of [...(aRecords ?? []), ...(aaaaRecords ?? [])]) {
        if ((answer.type === DNS_TYPE_A || answer.type === DNS_TYPE_AAAA) && isPrivateResolvedIp(answer.data, answer.type)) {
            throw new LunoraError(
                "FORBIDDEN",
                `@lunora/browser: url host "${host}" resolves to a private/internal address (${answer.data}); refusing to navigate (DNS-rebinding guard)`,
            );
        }
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
 * as-written — it does **not** resolve DNS. So **without `allowedHosts` (or the opt-in
 * `resolveDns` re-check applied by the caller before `page.goto`), a PUBLIC hostname that
 * resolves — via attacker-controlled DNS — to a private/metadata IP is NOT blocked**
 * (classic DNS rebinding, out of scope here). Any app that passes client-controlled URLs
 * to the browser should set `allowedHosts` (hard guarantee) or enable `resolveDns`
 * (best-effort re-check); otherwise keep caller-supplied URLs trusted.
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
    const withBrowser = async <T>(use: (browser: BrowserLike) => Promise<T>, keepAlive?: number): Promise<T> => {
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
            try {
                await browser.close();
            } catch {
                // Swallow: the session is being torn down anyway, and a close
                // failure must not mask the caller's result/error.
            }
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
        const resolveDns = options.resolveDns ?? false;
        // Reuse the navigation timeout budget for the DoH re-check, but never let a
        // single lookup exceed the DoH ceiling — a stalled resolver mustn't burn
        // the full (up to 120s) navigation budget before the browser even launches.
        const dohTimeout = Math.min(timeout, DOH_TIMEOUT_MS);

        // Opt-in DNS-rebinding re-check: resolve the host and reject if it maps to
        // a private address, before we pay for a browser launch + `page.goto`.
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
         * only. Returns `true` when the request should be aborted (fail-closed on an
         * unparseable/private/off-allowlist http(s) host), `false` to continue.
         */
        const isBlockedSubresource = (rawUrl: string): boolean => {
            let parsed: URL;

            try {
                parsed = new URL(rawUrl);
            } catch {
                return false;
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

            return isPrivateHost(parsed.hostname);
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
            try {
                await browser.close();
            } catch {
                // Swallow: the session is being torn down anyway, and a close
                // failure must not mask the caller's result/error.
            }
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
