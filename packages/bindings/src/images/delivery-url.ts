/**
 * URL-based image transform / delivery builder — a **pure string builder**, no
 * I/O. Mirrors the structure of `@lunora/storage`'s `buildSignedUrl` (minus the
 * crypto): deterministic, so it's safe to call from any handler (query, mutation,
 * action) without tripping the determinism advisor.
 *
 * Two forms are produced:
 *
 * - **Cloudflare URL-based transform** — `/cdn-cgi/image/<options>/<source>`,
 * where `<source>` is an absolute URL or an origin-relative key. This is the
 * on-the-fly transform CDN endpoint.
 * - **Images delivery variant** — `<baseUrl>/<imageId>/<variant>`, the
 * hosted-Images delivery form (a named variant like `public`/`thumbnail`).
 */
import { LunoraError } from "@lunora/errors";

import type { TransformOptions } from "./types";

const ABSOLUTE_URL_RE = /^[a-z][a-z\d+\-.]*:\/\//i;

/**
 * Characters a transform value may not contain: `,`/`=` are the option and
 * key-value separators of the `/cdn-cgi/image/<opts>/` form, and `#`/`?`/`/`
 * are URL-structural (fragment / query / path-segment delimiters) that would
 * silently corrupt the delivery URL if spliced in raw.
 */
const FORBIDDEN_VALUE_CHARS = [",", "=", "#", "?", "/"];

const stripTrailingSlash = (value: string): string => (value.endsWith("/") ? value.slice(0, -1) : value);

const stripLeadingSlash = (value: string): string => (value.startsWith("/") ? value.slice(1) : value);

/**
 * Serialize transform options into the comma-joined `key=value` option string
 * the `/cdn-cgi/image/...` endpoint expects (e.g. `width=256,height=256,fit=cover`).
 * Only string/number scalars are emitted; non-scalar keys are dropped because the
 * `/cdn-cgi/image/` URL form can't express them — today that is `gravity: {x,y}`
 * coordinates. Overlays are Workers-only and have no transform key at all: pass
 * them as `ctx.images.transform`'s `overlays` argument.
 */
const serializeTransform = (transform: TransformOptions): string =>
    Object.entries(transform)
        .filter(([, value]) => value !== undefined && (typeof value === "string" || typeof value === "number"))
        .map(([key, value]) => {
            const serialized = String(value);

            // The `/cdn-cgi/image/<opts>/<source>` form splices option values
            // verbatim into the URL path. `,` and `=` are the option / key-value
            // separators; `#`, `?`, and `/` are URL-structural — a raw `#` starts
            // the fragment (swallowing the source path), `?` starts the query,
            // and `/` splits the options segment. Any of them silently corrupts
            // the URL (wrong image / 404), so fail loud instead of emitting a
            // broken transform. Values carrying these chars must be percent-
            // encoded by the caller — for colors use `%23RRGGBB`, never the raw
            // `#RRGGBB` or `rgb(r,g,b)`.
            const offendingChar = FORBIDDEN_VALUE_CHARS.find((char) => serialized.includes(char));

            if (offendingChar !== undefined) {
                throw new LunoraError(
                    "INTERNAL",
                    `@lunora/bindings/images: transform option \`${key}\` value \`${serialized}\` contains a \`${offendingChar}\`, which the /cdn-cgi/image/ option path cannot represent` +
                        " (`,`/`=` are the option/key-value separators; `#`/`?`/`/` are URL-structural). Percent-encode the value — for colors use `%23RRGGBB`, not `#RRGGBB` or `rgb(r,g,b)`.",
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
     * (`<baseUrl>/<imageId>/<variant>`) and `transform`/`key` are ignored.
     */
    imageId?: string;

    /**
     * Source image — an absolute URL or an origin-relative key. Used by the
     * `/cdn-cgi/image/...` transform form. Ignored when `imageId` is set.
     */
    key?: string;
    /** Transform options for the `/cdn-cgi/image/<options>/<source>` form. */
    transform?: TransformOptions;
    /** Named delivery variant (e.g. `public`, `thumbnail`). Used with `imageId`; default `public`. */
    variant?: string;
}

/**
 * Build a Cloudflare Images delivery / transform URL.
 *
 * - With `imageId`: `<baseUrl>/<imageId>/<variant>` (hosted delivery variant).
 * - With `key`: `<baseUrl>/cdn-cgi/image/<options>/<source>` (URL-based transform).
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
        throw new LunoraError("INTERNAL", "@lunora/bindings/images: buildImageDeliveryUrl requires either `imageId` or `key`");
    }

    const optionString = options.transform === undefined ? "" : serializeTransform(options.transform);

    // An absolute source URL is left verbatim (it's already a valid CDN source);
    // a relative key is origin-rooted and percent-encoded per segment.
    const source = ABSOLUTE_URL_RE.test(options.key) ? options.key : encodeKey(stripLeadingSlash(options.key));

    const prefix = optionString === "" ? "/cdn-cgi/image" : `/cdn-cgi/image/${optionString}`;

    return `${base}${prefix}/${source}`;
};
