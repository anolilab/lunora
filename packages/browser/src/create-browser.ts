import type { Browser, BrowserLaunchLike, BrowserLike, LunoraBrowserOptions, NavigateOptions, PageLike, PdfOptions, ScreenshotOptions } from "./types";

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
const IPV6_NAT64_HEX = /^64:ff9b::([\da-f]{1,4}):([\da-f]{1,4})$/;

/** Leading / trailing `URL.hostname` IPv6 brackets (`[::1]`). */
const IPV6_BRACKETS = /^\[|\]$/g;

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

    return octets as [number, number, number, number];
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

/** Special-use hostname literals that resolve to the local host / internal namespaces. */
const isPrivateHostname = (host: string): boolean =>
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa");

/**
 * Classify a parsed URL's host as a private / internal SSRF target. IPv6 hosts
 * arrive bracketed from `URL.hostname` (`[::1]`); strip them before matching.
 */
const isPrivateTarget = (parsed: URL): boolean => {
    const host = parsed.hostname.replaceAll(IPV6_BRACKETS, "");

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
 * - SSRF target — unless `allowPrivateTargets` is set, a private / internal / loopback
 * / link-local host is refused (see {@link isPrivateTarget}). Browser Rendering egresses
 * from Cloudflare's network, but a private-network binding / Cloudflare Tunnel can still
 * make such hosts reachable, so default-deny is the safe posture; trusted internal use
 * opts in explicitly.
 *
 * Returns the normalized absolute URL string. Does **not** resolve DNS, so a public
 * hostname that later resolves to a private address (DNS rebinding) is out of scope —
 * keep caller-supplied URLs trusted regardless of this guard.
 */
const validateUrl = (url: string, allowPrivateTargets: boolean): string => {
    if (typeof url !== "string" || url.length === 0) {
        throw new Error("@lunora/browser: url must be a non-empty string");
    }

    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`@lunora/browser: url must be an absolute http(s) URL (got "${url}")`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`@lunora/browser: url protocol must be http(s) (got "${parsed.protocol}")`);
    }

    if (parsed.username !== "" || parsed.password !== "") {
        throw new Error("@lunora/browser: url must not embed credentials (strip the `user:pass@` userinfo)"); // gitleaks:allow -- illustrative error text, not a credential
    }

    if (!allowPrivateTargets && isPrivateTarget(parsed)) {
        throw new Error(
            `@lunora/browser: url host "${parsed.hostname}" is a private/internal address; pass createBrowser({ …, allowPrivateTargets: true }) to allow it`,
        );
    }

    return parsed.toString();
};

/** Clamp a requested viewport to the hard caps; both dimensions floored to >= 1. */
const clampViewport = (viewport: { height: number; width: number }): { height: number; width: number } => {
    return {
        height: Math.min(Math.max(1, Math.floor(viewport.height)), MAX_VIEWPORT_HEIGHT),
        width: Math.min(Math.max(1, Math.floor(viewport.width)), MAX_VIEWPORT_WIDTH),
    };
};

/** Resolve and clamp a navigation timeout from the per-call + factory defaults. */
const resolveTimeout = (callTimeout: number | undefined, factoryTimeout: number | undefined): number => {
    const requested = callTimeout ?? factoryTimeout ?? DEFAULT_TIMEOUT_MS;

    return Math.min(Math.max(1, Math.floor(requested)), MAX_TIMEOUT_MS);
};

// eslint-disable-next-line import/prefer-default-export -- named export: the package barrel re-exports by name, per the repo's no-default-mixing convention
export const createBrowser = (options: LunoraBrowserOptions): Browser => {
    // Defensive runtime guard: `binding` is required by the type, but JS callers
    // (and `createBrowser({})` misuse) can omit it.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the type
    if (!options.binding) {
        throw new Error("@lunora/browser: `binding` is required (env.BROWSER)");
    }

    const getLaunch = (): BrowserLaunchLike => {
        if (!options.launch) {
            throw new Error(
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
        const target = validateUrl(url, options.allowPrivateTargets ?? false);
        const timeout = resolveTimeout(navigate.timeoutMs, options.timeoutMs);

        return withBrowser(async (browser) => {
            const context = await browser.newContext();
            const page = await context.newPage();

            if (viewport && page.setViewportSize) {
                await page.setViewportSize(clampViewport(viewport));
            }

            await page.goto(target, { timeout, waitUntil: navigate.waitUntil ?? "load" });

            return use(page);
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
