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

import { isEnvDisabled } from "./env-flag";
import { isPlainObject } from "./is-plain-object";

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
     * never send one. Neither can be combined with {@link frameAncestors}: put the
     * `frame-ancestors` directive in the string.
     */
    csp?: string | false;
    /**
     * Origins allowed to embed your HTML pages in a frame, besides your own
     * (e.g. `["https://partner.example"]`). Sets the HTML policy's
     * `frame-ancestors 'self' <origins>` and drops `X-Frame-Options`, which
     * cannot express a list (browsers that understand `frame-ancestors` ignore
     * it anyway). Cannot be combined with `frameOptions: "DENY"`, a `csp` string,
     * or `csp: false` (which would leave no header restricting framing).
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

/**
 * A header value must stay on one line: a CR/LF would inject headers (or `_headers` rules). TAB is legal inside a
 * value (RFC 9110 §5.5); every other control character, and anything past Latin-1, makes `Headers.set` throw.
 */
const isHeaderSafe = (value: string): boolean =>
    [...value].every((character) => character === "\t" || (character >= " " && character !== "\u007F" && character <= "\u00FF"));

const COOP_VALUES: ReadonlyArray<CrossOriginOpenerPolicy> = ["same-origin", "same-origin-allow-popups", "unsafe-none"];
const FRAME_OPTIONS_VALUES: ReadonlyArray<string> = ["DENY", "SAMEORIGIN"];
const HSTS_KEYS: ReadonlyArray<string> = ["includeSubDomains", "maxAge", "preload"];
const STRING_KEYS = ["csp", "permissionsPolicy", "referrerPolicy"] as const;
const OPTION_KEYS: ReadonlyArray<string> = [...STRING_KEYS, "crossOriginOpenerPolicy", "frameAncestors", "frameOptions", "hsts"];

const quoted = (values: ReadonlyArray<string>): string => values.map((value) => JSON.stringify(value)).join(", ");

const parseHsts = (value: unknown, problems: string[]): SecurityHeadersOptions["hsts"] => {
    if (typeof value === "boolean") {
        return value;
    }

    if (!isPlainObject(value)) {
        problems.push("security.headers.hsts must be a boolean or an object { maxAge?, includeSubDomains?, preload? }");

        return undefined;
    }

    for (const key of Object.keys(value).filter((name) => !HSTS_KEYS.includes(name))) {
        problems.push(`security.headers.hsts.${key} is not an option (expected ${quoted(HSTS_KEYS)})`);
    }

    const { includeSubDomains, maxAge, preload } = value;

    if (maxAge !== undefined && !(typeof maxAge === "number" && Number.isSafeInteger(maxAge) && maxAge >= 0)) {
        problems.push(`security.headers.hsts.maxAge must be a whole number of seconds (got ${JSON.stringify(maxAge)})`);
    }

    for (const [key, flag] of [
        ["includeSubDomains", includeSubDomains],
        ["preload", preload],
    ] as const) {
        if (flag !== undefined && typeof flag !== "boolean") {
            problems.push(`security.headers.hsts.${key} must be a boolean`);
        }
    }

    return {
        ...(includeSubDomains === undefined ? {} : { includeSubDomains: includeSubDomains as boolean }),
        ...(maxAge === undefined ? {} : { maxAge: maxAge as number }),
        ...(preload === undefined ? {} : { preload: preload as boolean }),
    };
};

/** `value` when it is `false` or one of `allowed`; otherwise a problem. */
const parseChoice = <T extends string>(key: string, value: unknown, allowed: ReadonlyArray<T>, problems: string[]): T | false | undefined => {
    if (value === undefined || value === false || allowed.includes(value as T)) {
        return value as T | false | undefined;
    }

    problems.push(`security.headers.${key} must be one of ${quoted(allowed)} or false (got ${JSON.stringify(value)})`);

    return undefined;
};

const parseFrameAncestors = (value: unknown, problems: string[]): string[] | undefined => {
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value)) {
        problems.push('security.headers.frameAncestors must be an array of origins like ["https://partner.example"]');

        return undefined;
    }

    for (const origin of value as unknown[]) {
        // `isHeaderSafe` too: the `iu` flags case-fold U+212A (KELVIN SIGN) and U+017F (LONG S) into `[a-z]`, and
        // neither fits in a header value.
        if (typeof origin !== "string" || !ORIGIN_SOURCE.test(origin) || !isHeaderSafe(origin)) {
            problems.push(`security.headers.frameAncestors entry ${JSON.stringify(origin)} is not an origin like "https://partner.example"`);
        }
    }

    return [...(value as string[])];
};

type ParsedSecurityHeaders = { ok: false; problems: string[] } | { ok: true; value: boolean | SecurityHeadersOptions | undefined };

/**
 * `security.headers` from an untyped source (`lunora.config`, a JS caller of `createWorker`) as the options the
 * resolver can trust, or every problem with it: an unknown key (a typo would otherwise do nothing, silently), a
 * value of the wrong type or outside a header's vocabulary, a value that breaks a header line, or options that
 * contradict each other. Codegen, the build and `createWorker` all parse through here, so they refuse the same
 * values. The value is a fresh object holding only known keys, safe to copy into generated code.
 */
const parseSecurityHeaders = (input: unknown): ParsedSecurityHeaders => {
    if (input === undefined || typeof input === "boolean") {
        return { ok: true, value: input };
    }

    if (!isPlainObject(input)) {
        return { ok: false, problems: [`security.headers must be a boolean or an object (got ${Array.isArray(input) ? "an array" : JSON.stringify(input)})`] };
    }

    const problems = Object.keys(input)
        .filter((key) => !OPTION_KEYS.includes(key))
        .map((key) => `security.headers.${key} is not an option (expected ${quoted(OPTION_KEYS)})`);
    const options: SecurityHeadersOptions = {};

    for (const key of STRING_KEYS) {
        const value = input[key];

        if (value === undefined || value === false) {
            options[key] = value;
        } else if (typeof value !== "string") {
            problems.push(`security.headers.${key} must be a string or false`);
        } else if (isHeaderSafe(value)) {
            options[key] = value;
        } else {
            problems.push(`security.headers.${key} contains a line break or control character`);
        }
    }

    options.crossOriginOpenerPolicy = parseChoice("crossOriginOpenerPolicy", input["crossOriginOpenerPolicy"], COOP_VALUES, problems);
    options.frameOptions = parseChoice("frameOptions", input["frameOptions"], FRAME_OPTIONS_VALUES as ReadonlyArray<"DENY" | "SAMEORIGIN">, problems);
    options.frameAncestors = parseFrameAncestors(input["frameAncestors"], problems);
    options.hsts = input["hsts"] === undefined ? undefined : parseHsts(input["hsts"], problems);

    if (options.frameAncestors !== undefined && typeof options.csp === "string") {
        problems.push("security.headers.frameAncestors cannot be combined with a csp string: put the frame-ancestors directive in the csp");
    }

    if (options.frameAncestors !== undefined && options.frameOptions === "DENY") {
        problems.push('security.headers.frameAncestors cannot be combined with frameOptions: "DENY"');
    }

    // `frameAncestors` drops `X-Frame-Options`, so without a CSP to carry `frame-ancestors` nothing would restrict framing.
    if (options.frameAncestors !== undefined && options.csp === false) {
        problems.push("security.headers.frameAncestors needs the Content-Security-Policy that carries it; it cannot be combined with csp: false");
    }

    if (problems.length > 0) {
        return { ok: false, problems };
    }

    // Absent keys stay absent, so the value reads (and is emitted) as written.
    return { ok: true, value: Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as SecurityHeadersOptions };
};

/**
 * The `security.headers` in effect: the configured value, else `false` when `LUNORA_SECURITY_HEADERS` is an off
 * value, else `undefined` (the defaults). The Worker and the build's `_headers` writer both resolve it this way,
 * so an unset variable means the same thing on both paths.
 */
const effectiveSecurityHeaders = <T>(configured: T | undefined, environmentFlag: unknown): T | false | undefined =>
    configured ?? (isEnvDisabled(environmentFlag) ? false : undefined);

/** Resolve the options into header values. Pure; parse untrusted input with {@link parseSecurityHeaders} first. */
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

export type { CrossOriginOpenerPolicy, ParsedSecurityHeaders, ResolvedSecurityHeaders, SecurityHeadersOptions };
export { effectiveSecurityHeaders, parseSecurityHeaders, resolveSecurityHeaders };
