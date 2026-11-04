/**
 * The baseline security headers: their options, their defaults, and the one
 * function that turns the first into header values.
 *
 * Two layers send these headers and must agree. `@lunora/runtime`'s
 * `decorateResponse` adds them to every response the Worker produces, and
 * `@lunora/config` writes them into the generated `_headers` file, because
 * Cloudflare serves a static asset hit without running the Worker at all. Both
 * resolve through {@link resolveSecurityHeaders}, so a value set once (in
 * `lunora.config`'s `security.headers`, or the same object passed to
 * `createWorker`) produces the same headers on both paths. Bundler-inlined, so
 * neither package depends on the other.
 */

/** `Cross-Origin-Opener-Policy` values. `false` omits the header. */
type CrossOriginOpenerPolicy = "same-origin" | "same-origin-allow-popups" | "unsafe-none";

/** Per-header overrides for the baseline security headers. `false` omits the header. */
interface SecurityHeadersOptions {
    /**
     * `Cross-Origin-Opener-Policy`. Defaults to `same-origin-allow-popups`: a
     * cross-origin page that opens yours gets no handle on it, while a popup your
     * page opens (an OAuth provider, a payment sheet) can still message back
     * through `window.opener`. `same-origin` severs that too; `false` omits the header.
     */
    crossOriginOpenerPolicy?: CrossOriginOpenerPolicy | false;
    /**
     * `Content-Security-Policy`. Omitted (`undefined`) applies a restrictive
     * `default-src 'none'` policy to **non-HTML** responses, and a conservative
     * hardening policy to **HTML** responses (`base-uri 'none'; object-src
     * 'none'; frame-ancestors …`) — this does NOT set `default-src`/`script-src`,
     * so it never blocks a page's own scripts/styles/images/fetches. Pass a string
     * to apply that exact policy to every response (HTML included); `false` to
     * never send one. A string cannot be combined with {@link frameAncestors}:
     * put the `frame-ancestors` directive in it.
     */
    csp?: string | false;
    /**
     * Origins allowed to embed your HTML pages in a frame, besides your own
     * (e.g. `["https://partner.example"]`). Sets the HTML policy's
     * `frame-ancestors 'self' <origins>` and drops `X-Frame-Options`, which
     * cannot express a list (browsers that understand `frame-ancestors` ignore
     * it anyway). Cannot be combined with `frameOptions: "DENY"` or a `csp` string.
     */
    frameAncestors?: ReadonlyArray<string>;
    /** `X-Frame-Options` (clickjacking). Defaults to `SAMEORIGIN`. `false` omits it. */
    frameOptions?: "DENY" | "SAMEORIGIN" | false;
    /** `Strict-Transport-Security`. The Worker sends it only over HTTPS. `false` omits it. */
    hsts?: boolean | { includeSubDomains?: boolean; maxAge?: number; preload?: boolean };
    /** `Permissions-Policy`. Defaults to a minimal deny list. `false` omits it. */
    permissionsPolicy?: string | false;
    /** `Referrer-Policy`. Defaults to `strict-origin-when-cross-origin`. `false` omits it. */
    referrerPolicy?: string | false;
}

/** The header values {@link SecurityHeadersOptions} resolves to; `undefined` means "not sent". */
interface ResolvedSecurityHeaders {
    coop: string | undefined;
    /** `value` for non-HTML responses, `htmlValue` for HTML ones. */
    csp: { htmlValue: string; value: string } | undefined;
    enabled: boolean;
    frameOptions: string | undefined;
    hsts: string | undefined;
    permissionsPolicy: string | undefined;
    referrerPolicy: string | undefined;
}

const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const DEFAULT_PERMISSIONS_POLICY =
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

const DEFAULT_HSTS_MAX_AGE_SECONDS = 31_536_000;

const DISABLED: ResolvedSecurityHeaders = {
    coop: undefined,
    csp: undefined,
    enabled: false,
    frameOptions: undefined,
    hsts: undefined,
    permissionsPolicy: undefined,
    referrerPolicy: undefined,
};

const resolveHsts = (hsts: SecurityHeadersOptions["hsts"]): string | undefined => {
    if (hsts === false) {
        return undefined;
    }

    const config = hsts === undefined || hsts === true ? {} : hsts;
    const maxAge = config.maxAge ?? DEFAULT_HSTS_MAX_AGE_SECONDS;
    const includeSubDomains = config.includeSubDomains ?? true;

    return `max-age=${String(maxAge)}${includeSubDomains ? "; includeSubDomains" : ""}${config.preload === true ? "; preload" : ""}`;
};

/**
 * The HTML policy's `frame-ancestors`, derived from the framing options so the
 * two controls agree — a static `'self'` would otherwise *weaken* an
 * `X-Frame-Options: DENY`, since browsers prefer CSP `frame-ancestors`. `DENY` →
 * `'none'`, `SAMEORIGIN` → `'self'`, an allow-list → `'self' <origins>`, framing
 * disabled → no directive.
 */
const frameAncestorsDirective = (frameOptions: string | undefined, frameAncestors: ReadonlyArray<string> | undefined): string | undefined => {
    if (frameAncestors !== undefined) {
        return ["frame-ancestors 'self'", ...frameAncestors].join(" ");
    }

    if (frameOptions === "DENY") {
        return "frame-ancestors 'none'";
    }

    return frameOptions === "SAMEORIGIN" ? "frame-ancestors 'self'" : undefined;
};

/** An origin a `frame-ancestors` list may name: `scheme://host[:port]`, the host optionally `*.`-prefixed. No path, quote, space or separator. */
const ORIGIN_SOURCE = /^[a-z][\d+.a-z-]*:\/\/(?:\*\.)?[\d.a-z-]+(?::\d{1,5})?$/iu;

/** A header value must stay on one line: a CR/LF would inject headers (or `_headers` rules); other control characters are refused by `Headers`. */
const isHeaderSafe = (value: string): boolean => [...value].every((character) => character >= " " && character !== "\u007F");

/**
 * Problems with `input` that would otherwise surface late: a value that breaks a
 * header line, or options that contradict each other. Empty when valid. Callers
 * fail on these (codegen and the build before deploy, `createWorker` at construction)
 * rather than at request time.
 */
const validateSecurityHeaders = (input: boolean | SecurityHeadersOptions | undefined): string[] => {
    if (input === undefined || typeof input === "boolean") {
        return [];
    }

    const problems: string[] = [];

    for (const key of ["csp", "permissionsPolicy", "referrerPolicy", "crossOriginOpenerPolicy", "frameOptions"] as const) {
        const value = input[key];

        if (typeof value === "string" && !isHeaderSafe(value)) {
            problems.push(`security.headers.${key} contains a line break or control character`);
        }
    }

    if (input.frameAncestors !== undefined) {
        for (const origin of input.frameAncestors) {
            if (!ORIGIN_SOURCE.test(origin)) {
                problems.push(`security.headers.frameAncestors entry ${JSON.stringify(origin)} is not an origin like "https://partner.example"`);
            }
        }

        if (typeof input.csp === "string") {
            problems.push("security.headers.frameAncestors cannot be combined with a csp string: put the frame-ancestors directive in the csp");
        }

        if (input.frameOptions === "DENY") {
            problems.push('security.headers.frameAncestors cannot be combined with frameOptions: "DENY"');
        }
    }

    return problems;
};

/** Resolve the options into header values. Pure; call {@link validateSecurityHeaders} first. */
const resolveSecurityHeaders = (input: boolean | SecurityHeadersOptions | undefined): ResolvedSecurityHeaders => {
    if (input === false) {
        return DISABLED;
    }

    const options: SecurityHeadersOptions = input === undefined || input === true ? {} : input;
    // An allow-list cannot be said in `X-Frame-Options`, so the header goes and `frame-ancestors` carries the policy.
    const frameOptions = options.frameAncestors !== undefined || options.frameOptions === false ? undefined : (options.frameOptions ?? "SAMEORIGIN");
    const htmlCsp = ["base-uri 'none'", "object-src 'none'", frameAncestorsDirective(frameOptions, options.frameAncestors)]
        .filter((part) => part !== undefined)
        .join("; ");

    let csp: ResolvedSecurityHeaders["csp"];

    if (typeof options.csp === "string") {
        csp = { htmlValue: options.csp, value: options.csp };
    } else if (options.csp !== false) {
        csp = { htmlValue: htmlCsp, value: DEFAULT_CSP };
    }

    return {
        coop: options.crossOriginOpenerPolicy === false ? undefined : (options.crossOriginOpenerPolicy ?? "same-origin-allow-popups"),
        csp,
        enabled: true,
        frameOptions,
        hsts: resolveHsts(options.hsts),
        permissionsPolicy: options.permissionsPolicy === false ? undefined : (options.permissionsPolicy ?? DEFAULT_PERMISSIONS_POLICY),
        referrerPolicy: options.referrerPolicy === false ? undefined : (options.referrerPolicy ?? "strict-origin-when-cross-origin"),
    };
};

export type { CrossOriginOpenerPolicy, ResolvedSecurityHeaders, SecurityHeadersOptions };
export { resolveSecurityHeaders, validateSecurityHeaders };
