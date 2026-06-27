/**
 * URL-based image transform / delivery builder — a **pure string builder**, no
 * I/O. Mirrors the structure of `@lunora/storage`'s `buildSignedUrl` (minus the
 * crypto): deterministic, so it's safe to call from any handler (query, mutation,
 * action) without tripping the determinism advisor.
 *
 * Two forms are produced:
 *
 * - **Cloudflare URL-based transform** — `/cdn-cgi/image/&lt;options>/&lt;source>`,
 * where `&lt;source>` is an absolute URL or an origin-relative key. This is the
 * on-the-fly transform CDN endpoint.
 * - **Images delivery variant** — `&lt;baseUrl>/&lt;imageId>/&lt;variant>`, the
 * hosted-Images delivery form (a named variant like `public`/`thumbnail`).
 */
import type { TransformOptions } from "./types";

const ABSOLUTE_URL_RE = /^[a-z][a-z\d+\-.]*:\/\//i;

const stripTrailingSlash = (value: string): string => (value.endsWith("/") ? value.slice(0, -1) : value);

const stripLeadingSlash = (value: string): string => (value.startsWith("/") ? value.slice(1) : value);

/**
 * Serialize transform options into the comma-joined `key=value` option string
 * the `/cdn-cgi/image/...` endpoint expects (e.g. `width=256,height=256,fit=cover`).
 * Only string/number scalars are emitted; non-scalar keys are dropped because the
 * `/cdn-cgi/image/` URL form can't express them — `gravity: {x,y}` coordinates and
 * `draw` overlays (overlays are Workers-only: use `ctx.images.transform`'s
 * `overlays` argument, or the signed-delivery flow which re-applies them via the
 * binding).
 */
const serializeTransform = (transform: TransformOptions): string =>
    Object.entries(transform)
        .filter(([, value]) => value !== undefined && (typeof value === "string" || typeof value === "number"))
        .map(([key, value]) => {
            const serialized = String(value);

            // The `/cdn-cgi/image/<opts>/` form delimits options with `,` and
            // separates key from value with `=`. A value carrying either char
            // would break out of its option and silently corrupt the URL (the
            // CDN can't represent a raw `,`/`=` inside a value), so fail loud
            // instead of emitting a wrong transform. Colors must use the hex
            // form (e.g. `%23RRGGBB`), not `rgb(r,g,b)`.
            if (serialized.includes(",") || serialized.includes("=")) {
                throw new Error(
                    `@lunora/bindings/images: transform option \`${key}\` value \`${serialized}\` contains a \`,\` or \`=\`, which the /cdn-cgi/image/ option list cannot represent` +
                        " (these are the option/key-value separators). For colors, use the hex form (e.g. `#RRGGBB`/`%23RRGGBB`) instead of `rgb(r,g,b)`.",
                );
            }

            return `${key}=${serialized}`;
        })
        .join(",");

/** Percent-encode a source path segment-by-segment, leaving `/` separators intact. */
const encodeKey = (key: string): string =>
    key
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");

export interface ImageDeliveryUrlOptions {
    /** Delivery / transform origin, e.g. `https://cdn.acme.test`. */
    baseUrl: string;

    /**
     * Hosted-Images image id. When set, the **delivery-variant** form is built
     * (`&lt;baseUrl>/&lt;imageId>/&lt;variant>`) and `transform`/`key` are ignored.
     */
    imageId?: string;

    /**
     * Source image — an absolute URL or an origin-relative key. Used by the
     * `/cdn-cgi/image/...` transform form. Ignored when `imageId` is set.
     */
    key?: string;
    /** Transform options for the `/cdn-cgi/image/&lt;options>/&lt;source>` form. */
    transform?: TransformOptions;
    /** Named delivery variant (e.g. `public`, `thumbnail`). Used with `imageId`; default `public`. */
    variant?: string;
}

/**
 * Build a Cloudflare Images delivery / transform URL.
 *
 * - With `imageId`: `&lt;baseUrl>/&lt;imageId>/&lt;variant>` (hosted delivery variant).
 * - With `key`: `&lt;baseUrl>/cdn-cgi/image/&lt;options>/&lt;source>` (URL-based transform).
 *
 * Pure and deterministic — usable from any handler.
 */
export const buildImageDeliveryUrl = (options: ImageDeliveryUrlOptions): string => {
    const base = stripTrailingSlash(options.baseUrl);

    if (options.imageId !== undefined) {
        const variant = options.variant ?? "public";

        return `${base}/${encodeURIComponent(options.imageId)}/${encodeURIComponent(variant)}`;
    }

    if (options.key === undefined) {
        throw new Error("@lunora/bindings/images: buildImageDeliveryUrl requires either `imageId` or `key`");
    }

    const optionString = options.transform === undefined ? "" : serializeTransform(options.transform);

    // An absolute source URL is left verbatim (it's already a valid CDN source);
    // a relative key is origin-rooted and percent-encoded per segment.
    const isAbsolute = ABSOLUTE_URL_RE.test(options.key);
    const source = isAbsolute ? options.key : `/${encodeKey(stripLeadingSlash(options.key))}`;

    const prefix = optionString === "" ? "/cdn-cgi/image" : `/cdn-cgi/image/${optionString}`;

    return `${base}${prefix}${source.startsWith("/") ? source : `/${source}`}`;
};
