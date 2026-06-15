/**
 * Structural projections of the Cloudflare **Images** binding (`env.IMAGES`).
 *
 * Declared structurally — the same pattern `@cirrus/storage` uses for
 * `R2BucketLike` — so a unit test can pass a plain object double and the real
 * `ImagesBinding` from `@cloudflare/workers-types` satisfies the same shape. We
 * project only the slice of the chain we actually call
 * (`input(stream).transform(opts).output(opts)` + `info(stream)`), not the full
 * hosted-images CRUD surface.
 */

/**
 * Transform parameters threaded into `binding.input(stream).transform(...)`.
 * A structural subset of the real `ImageTransform`; the keys here are the
 * resize/format/optimize knobs apps reach for. Unknown extra keys on the real
 * binding are still accepted because the binding owns the authoritative type.
 */
export interface TransformOptions {
    /** Background color (CSS color) painted under transparent images. */
    background?: string;
    /** Gaussian blur radius (1–250). */
    blur?: number;
    /** Brightness multiplier (1 = unchanged). */
    brightness?: number;
    /** Contrast multiplier (1 = unchanged). */
    contrast?: number;
    /** Resize mode. Affects how `width`/`height` are interpreted. */
    fit?: "contain" | "cover" | "crop" | "pad" | "scale-down" | "squeeze";
    /** Mirror the image horizontally, vertically, or both. */
    flip?: "h" | "hv" | "v";
    /** Gamma multiplier (1 = unchanged). */
    gamma?: number;
    /** Crop anchor when `fit: "cover"`/`"crop"`. */
    gravity?: "auto" | "bottom" | "center" | "entropy" | "face" | "left" | "right" | "top" | { mode: "box-center" | "remainder"; x?: number; y?: number };
    /** Target height in pixels (integer). Clamped to the configured ceiling. */
    height?: number;
    /** Rotate by a fixed multiple of 90 degrees. `width`/`height` refer to axes after rotation. */
    rotate?: 0 | 90 | 180 | 270;
    /** Saturation multiplier (0 = greyscale, 1 = unchanged). */
    saturation?: number;
    /** AI segmentation — set non-`foreground` pixels transparent. */
    segment?: "foreground";
    /** Sharpen strength (0–10). */
    sharpen?: number;
    /** Target width in pixels (integer). Clamped to the configured ceiling. */
    width?: number;
}

/** The output image formats Cirrus permits (the binding allowlist plus `json` info). */
export type ImageOutputFormat = "image/avif" | "image/gif" | "image/jpeg" | "image/png" | "image/webp";

/** Options for the terminal `output(...)` call. */
export interface OutputOptions {
    /** Encode animated source frames into the output (WebP/GIF/AVIF). */
    anim?: boolean;
    /** Background color (CSS color) for formats without an alpha channel. */
    background?: string;
    /** Output MIME type. Validated against {@link ImageOutputFormat}. Default `image/webp`. */
    format?: ImageOutputFormat;
    /** Encoder quality 1–100 (lossy formats). */
    quality?: number;
}

/**
 * The result of `binding.input(...).transform(...).output(...)`. Mirrors the
 * real `ImageTransformationResult` — a `Response`, the content type, and the
 * raw byte stream.
 */
export interface ImageTransformationResultLike {
    contentType: () => string;
    image: () => ReadableStream<Uint8Array>;
    response: () => Response;
}

/** Metadata returned by `binding.info(...)` — format, and (for raster images) dimensions + size. */
export type ImageInfoLike = { fileSize: number; format: string; height: number; width: number } | { format: string };

/** One link in the transform chain: apply more transforms or finalize with `output`. */
export interface ImageTransformerLike {
    output: (options: OutputOptions) => Promise<ImageTransformationResultLike>;
    transform: (transform: TransformOptions) => ImageTransformerLike;
}

/**
 * Minimal projection of `ImagesBinding`. Declared structurally so unit tests can
 * pass a plain object double; the real `env.IMAGES` binding satisfies the same
 * shape. Only the input/transform/output chain and `info` are projected — the
 * hosted-images CRUD surface is out of scope.
 */
export interface ImagesBindingLike {
    info: (stream: ReadableStream<Uint8Array>) => Promise<ImageInfoLike>;
    input: (stream: ReadableStream<Uint8Array>) => ImageTransformerLike;
}

/**
 * An R2 object body (as returned by `ctx.storage.download(key)`) — first-class
 * transform input. Only `.body` is read, so a structural projection is enough.
 */
export interface R2ObjectBodyLike {
    body: ReadableStream | null;
}

/** Anything `transform`/`info` accept as input bytes. R2 bodies are unwrapped to their stream. */
export type ImageInput = ArrayBuffer | Blob | R2ObjectBodyLike | ReadableStream | Uint8Array;

export interface CirrusImagesOptions {
    /** The Cloudflare Images binding (`env.IMAGES`). */
    binding: ImagesBindingLike;

    /**
     * Base URL of the image delivery origin / Worker route the URL helpers point
     * at (e.g. `https://cdn.acme.test`). Required by `buildImageDeliveryUrl` /
     * the signed-delivery helpers when used through the factory.
     */
    deliveryBaseUrl?: string;
    /** Maximum pixel value any single `width`/`height` may request. Default 10000. */
    maxDimension?: number;
    /** HMAC secret for the signed-delivery helpers. Required for signed URLs. */
    signingSecret?: string;
}

/**
 * The action-only Images client wired onto `ctx.images`.
 *
 * The binding-backed `transform`/`info` calls are non-deterministic network /
 * compute I/O, so this lives on **ActionCtx only** — the same seam as `ctx.ai`.
 * The pure URL/signed-URL builders are exported as free functions (see
 * `index.ts`) and are safe to call from any handler.
 */
export interface Images {
    /**
     * Probe an image for its format and (for raster formats) dimensions + byte
     * size, without running a transform. Wraps `binding.info(...)`.
     */
    info: (input: ImageInput) => Promise<ImageInfoLike>;

    /**
     * Resize / reformat / optimize `input`, returning the transformed result
     * (a `Response`, content type, and byte stream). Accepts a raw stream/buffer,
     * a `Blob`, or an R2 object body straight from `ctx.storage.download(key)`.
     *
     * `transform` dimensions are clamped to the configured ceiling and the output
     * `format` is validated against the allowlist, so a hostile request can't
     * mint a multi-gigapixel canvas or an unexpected content type.
     */
    transform: (input: ImageInput, transform?: TransformOptions, output?: OutputOptions) => Promise<ImageTransformationResultLike>;
}
