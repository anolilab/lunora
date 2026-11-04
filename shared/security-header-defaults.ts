/**
 * The baseline security header values Lunora sends by default.
 *
 * Two layers send them and must agree: `@lunora/runtime`'s `decorateResponse`
 * adds them to every response the Worker produces, and `@lunora/config` writes
 * them into the generated `_headers` file, because Cloudflare serves a static
 * asset hit without running the Worker at all. A copy in each would drift, so
 * both inline this file (bundler-inlined, no dependency edge between them).
 */

const DEFAULT_FRAME_OPTIONS = "SAMEORIGIN";

const DEFAULT_REFERRER_POLICY = "strict-origin-when-cross-origin";

const DEFAULT_PERMISSIONS_POLICY =
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

const DEFAULT_CROSS_ORIGIN_OPENER_POLICY = "same-origin";

const DEFAULT_HSTS_MAX_AGE_SECONDS = 31_536_000;

/** `Strict-Transport-Security` with every option at its default. */
const DEFAULT_HSTS = `max-age=${String(DEFAULT_HSTS_MAX_AGE_SECONDS)}; includeSubDomains`;

/**
 * Conservative default CSP for HTML responses, derived from the resolved
 * `frameOptions` so the two framing controls agree — a static `frame-ancestors
 * 'self'` would otherwise *weaken* an `X-Frame-Options: DENY` policy, since
 * modern browsers prefer CSP `frame-ancestors` over the legacy header.
 * Deliberately omits `default-src`/`script-src`/`style-src`/`connect-src`/
 * `form-action` so it never breaks a page's own resources or cross-origin form
 * posts (e.g. OAuth redirects); it only locks the `base` element's href, forbids
 * legacy plugins, and mirrors the framing policy: `DENY` → `'none'`,
 * `SAMEORIGIN` → `'self'`, disabled → no `frame-ancestors`.
 */
const htmlCspFor = (frameOptions: string | undefined): string => {
    const parts = ["base-uri 'none'", "object-src 'none'"];

    if (frameOptions === "DENY") {
        parts.push("frame-ancestors 'none'");
    } else if (frameOptions === "SAMEORIGIN") {
        parts.push("frame-ancestors 'self'");
    }

    return parts.join("; ");
};

export {
    DEFAULT_CROSS_ORIGIN_OPENER_POLICY,
    DEFAULT_FRAME_OPTIONS,
    DEFAULT_HSTS,
    DEFAULT_HSTS_MAX_AGE_SECONDS,
    DEFAULT_PERMISSIONS_POLICY,
    DEFAULT_REFERRER_POLICY,
    htmlCspFor,
};
