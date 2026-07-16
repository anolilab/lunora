import { LunoraError } from "@lunora/errors";

import type {
    Browser,
    BrowserLaunchLike,
    BrowserLike,
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

/** Canonical dotted-quad octet matcher (1–3 digits), hoisted so it isn't recompiled per host part. */
const IPV4_OCTET = /^\d{1,3}$/;

/** IPv4-mapped IPv6 in the hex form the WHATWG `URL` parser emits (`::ffff:7f00:1`). */
const IPV6_MAPPED_HEX = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/;

/** IPv4-mapped IPv6 in dotted form (`::ffff:127.0.0.1`), for parsers that keep it. */
const IPV6_MAPPED_DOTTED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

/**
 * IPv4-compatible IPv6 (`::a.b.c.d` dotted form; deprecated but still parsed).
 * The WHATWG URL parser normalizes these to a non-`ffff` two-word hex form such
 * as `::7f00:1` for `::127.0.0.1`. We match both shapes.
 */
const IPV6_COMPATIBLE_DOTTED = /^::(\d{1,3}(?:\.\d{1,3}){3})$/;

/**
 * IPv4-compatible in the compact two-word hex form the WHATWG parser emits
 * (`::W:X` where the full 128-bit prefix is `0000…0000:W:X`). Distinguishable
 * from `::ffff:W:X` (mapped) because the `ffff` group is absent.
 * We only need to match the `::` prefix (everything else is either `::1`,
 * `::ffff:…`, or a longer form that wouldn't match the `::` shorthand), so
 * we recognise `::` followed by exactly two colon-separated hex groups.
 */
const IPV6_COMPATIBLE_HEX = /^::([\da-f]{1,4}):([\da-f]{1,4})$/;

/**
 * NAT64 well-known prefix `64:ff9b::/96`. The WHATWG URL parser expands the
 * embedded IPv4 into a full eight-group address, so we match the normalised
 * `64:ff9b::W:X` compact form (two trailing hex words encoding the IPv4).
 */
const IPV6_NAT64_HEX = /^64:ff9b::[\da-f]{1,4}:[\da-f]{1,4}$/;

/** Leading / trailing `URL.hostname` IPv6 brackets (`[::1]`). */
const IPV6_BRACKETS = /^\[|\]$/g;

/** A single trailing FQDN dot on a `URL.hostname` (`localhost.` → `localhost`). */
const TRAILING_DOT = /\.$/;

/**
 * Parse a canonical dotted-quad IPv4 string into its four octets, or `undefined`
 * if it isn't one. The WHATWG `URL` parser already normalizes the octal/hex/integer
 * IPv4 forms (`0177.0.0.1`, `0x7f.1`, `2130706433`) to dotted-decimal, so by the
 * time a hostname reaches here an IPv4 literal is always canonical — closing those
 * SSRF-bypass encodings for free.
 */
const parseIpv4 = (host: string): [number, number, number, number] | undefined => {
    const parts = host.split(".");

    if (parts.length !== 4) {
        return undefined;
    }

    const octets = parts.map((part) => (IPV4_OCTET.test(part) ? Number(part) : -1));

    if (octets.some((octet) => octet < 0 || octet > 255)) {
        return undefined;
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- octets.length === 4 guaranteed by the parts.length === 4 check above
    const result: [number, number, number, number] = [octets[0]!, octets[1]!, octets[2]!, octets[3]!];

    return result;
};

/** True if an IPv4 octet tuple is loopback / private / link-local / CGNAT / reserved — the ranges an SSRF guard blocks. */
const isPrivateIpv4 = ([a, b]: [number, number, number, number]): boolean =>
    a === 0 || // 0.0.0.0/8 "this host"
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    a >= 224; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast

/**
 * Decode the embedded 32-bit IPv4 from two hex groups (high word, low word)
 * and test it against the private-range table. Returns `true` when the decoded
 * address is private, or when the groups cannot be parsed (fail-closed).
 */
const isPrivateEmbeddedIpv4 = (highGroup: string | undefined, lowGroup: string | undefined): boolean => {
    const high = Number.parseInt(highGroup ?? "", 16);
    const low = Number.parseInt(lowGroup ?? "", 16);

    // If either group doesn't parse cleanly, treat as private (fail-closed).
    if (!Number.isFinite(high) || !Number.isFinite(low)) {
        return true;
    }

    return isPrivateIpv4([Math.floor(high / 256), high % 256, Math.floor(low / 256), low % 256]);
};

/** True if an IPv6 literal (brackets already stripped) is loopback / unspecified / ULA / link-local, or maps to a private IPv4. */
const isPrivateIpv6 = (host: string): boolean => {
    const ip = host.toLowerCase();

    // IPv4-mapped (`::ffff:127.0.0.1`). The WHATWG `URL` parser normalizes the
    // embedded IPv4 to two hex words (`::ffff:7f00:1`); accept the dotted form too
    // for parsers that keep it. Either way, decode the low 32 bits and reuse the
    // IPv4 ranges so a mapped loopback/private address can't slip past.
    const mappedHex = IPV6_MAPPED_HEX.exec(ip);

    if (mappedHex) {
        return isPrivateEmbeddedIpv4(mappedHex[1], mappedHex[2]);
    }

    const mappedDotted = IPV6_MAPPED_DOTTED.exec(ip);

    if (mappedDotted) {
        const v4 = parseIpv4(mappedDotted[1] ?? "");

        return v4 === undefined || isPrivateIpv4(v4);
    }

    // IPv4-compatible (`::a.b.c.d` dotted; deprecated).
    const compatDotted = IPV6_COMPATIBLE_DOTTED.exec(ip);

    if (compatDotted) {
        const v4 = parseIpv4(compatDotted[1] ?? "");

        return v4 === undefined || isPrivateIpv4(v4);
    }

    // IPv4-compatible in the WHATWG-normalised hex form (`::W:X`, no `ffff`).
    const compatHex = IPV6_COMPATIBLE_HEX.exec(ip);

    if (compatHex) {
        return isPrivateEmbeddedIpv4(compatHex[1], compatHex[2]);
    }

    // NAT64 well-known prefix `64:ff9b::/96`. Block unconditionally: any
    // address in this range translates an embedded IPv4 at the egress NAT64
    // gateway, and an embedded private IPv4 (e.g. 169.254.169.254) reaches an
    // internal host. Failing closed on the whole prefix is the safest posture.
    if (IPV6_NAT64_HEX.test(ip)) {
        return true;
    }

    return (
        ip === "::" || // unspecified
        ip === "::1" || // loopback
        ip.startsWith("fc") || // fc00::/7 unique-local
        ip.startsWith("fd") || // fc00::/7 unique-local
        ip.startsWith("fe8") || // fe80::/10 link-local
        ip.startsWith("fe9") ||
        ip.startsWith("fea") ||
        ip.startsWith("feb")
    );
};

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

/** Normalize a host string for allowlist comparison: strip IPv6 brackets + a trailing FQDN dot, lowercase. */
const normalizeHost = (host: string): string => host.replaceAll(IPV6_BRACKETS, "").replace(TRAILING_DOT, "").toLowerCase();

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

/** Special-use hostname literals that resolve to the local host / internal namespaces. */
const isPrivateHostname = (host: string): boolean =>
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa");

/**
 * Classify a parsed URL's host as a private / internal SSRF target. IPv6 hosts
 * arrive bracketed from `URL.hostname` (`[::1]`); strip them before matching.
 *
 * SECURITY: the WHATWG URL parser preserves a trailing dot on a NAMED host
 * (`http://localhost./` → `localhost.`, `metadata.google.internal.`) while
 * canonicalizing it away for IPv4 literals. A fully-qualified trailing-dot form
 * resolves to the same host, so strip a single trailing dot before matching or
 * the FQDN form bypasses the special-hostname denylist (`localhost.` !==
 * `localhost`, `redis.internal.` doesn't `.endsWith(".internal")`).
 */
const isPrivateTarget = (parsed: URL): boolean => {
    const host = parsed.hostname.replaceAll(IPV6_BRACKETS, "").replace(TRAILING_DOT, "");

    if (host.includes(":")) {
        return isPrivateIpv6(host);
    }

    const v4 = parseIpv4(host);

    return v4 === undefined ? isPrivateHostname(host.toLowerCase()) : isPrivateIpv4(v4);
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
 * / link-local host is refused (see {@link isPrivateTarget}). Browser Rendering egresses
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

    if (!allowPrivateTargets && isPrivateTarget(parsed)) {
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

    /**
     * Launch a browser, run `use`, and **always** close the browser in a
     * `finally` — a leaked Browser Rendering session is billed and rate-limited,
     * so this is the one real footgun. The close error is swallowed (we never
     * mask the caller's original error with a close failure).
     */
    const withBrowser = async <T>(use: (browser: BrowserLike) => Promise<T>): Promise<T> => {
        const browser = await getLaunch()(options.binding);

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
         * DoS footgun). It mirrors validateUrl's allowlist + `isPrivateTarget` arms
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

            return isPrivateTarget(parsed);
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

    const launch = async <T>(function_: (browser: BrowserLike) => Promise<T>): Promise<T> => withBrowser(function_);

    return {
        content,
        launch,
        pdf,
        scrape,
        screenshot,
    };
};
