/**
 * Structural projections of the Cloudflare **Images** binding (`env.IMAGES`).
 *
 * Declared structurally — the same pattern `@lunora/storage` uses for
 * `R2BucketLike` — so a unit test can pass a plain object double and the real
 * `ImagesBinding` from `@cloudflare/workers-types` satisfies the same shape. We
 * project only the slice of the chain we actually call
 * (`input(stream).transform(opts).output(opts)` + `info(stream)`), not the full
 * hosted-images CRUD surface.
 *
 * TODO(workers-types): the 2026-06-16 optimization features — the `aspect-crop`
 * / `scale-up` fit modes and the `upscale` param — are modeled here by hand
 * because `@cloudflare/workers-types` (through 4.20260616.1) does not type them
 * yet. Re-check on the next `@cloudflare/workers-types` bump: once `ImageTransform`
 * carries `fit: "aspect-crop" | "scale-up"` and `upscale`, drop our hand-rolled
 * additions and lean on the upstream type.
 */

/**
 * Porter-Duff compositing operation controlling how an overlay is blended onto
 * the image beneath it. Mirrors the binding's `ImageCompositeMode`.
 *
 * - `over` — foreground drawn on top of the backdrop (default).
 * - `in` — foreground shown only where the backdrop is opaque.
 * - `atop` — foreground drawn on top, clipped to the backdrop's shape.
 * - `out` — foreground shown only where the backdrop is transparent.
 * - `xor` — foreground and backdrop visible only where the other is not.
 * - `lighter` — foreground and backdrop channels added (brightening).
 */
export type ImageCompositeMode = "atop" | "in" | "lighter" | "out" | "over" | "xor";

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

    /**
     * Resize mode. Affects how `width`/`height` are interpreted.
     *
     * - `scale-down` — contain, but never enlarges.
     * - `contain` — fit within the box, preserving aspect ratio.
     * - `cover` — fill the box, cropping overflow.
     * - `crop` — shrink-and-crop to fit, but never enlarges.
     * - `aspect-crop` — crop to the target aspect ratio, but never enlarges.
     * - `pad` — fit within the box, padding the remainder with `background`.
     * - `squeeze` — stretch to the exact box, distorting aspect ratio.
     * - `scale-up` — enlarge to show the whole image, but never downscales.
     */
    fit?: "aspect-crop" | "contain" | "cover" | "crop" | "pad" | "scale-down" | "scale-up" | "squeeze";
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

    /**
     * Algorithm used when a transform enlarges the image (e.g. `fit: "scale-up"`).
     *
     * - `interpolate` — bicubic interpolation (default), may soften detail.
     * - `generate` — AI upscaling for sharper, more detailed enlargements.
     */
    upscale?: "generate" | "interpolate";
    /** Target width in pixels (integer). Clamped to the configured ceiling. */
    width?: number;
}

/** The output image formats Lunora permits (the binding allowlist plus `json` info). */
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

/**
 * Binding-side overlay options for `transformer.draw(image, options)` — the
 * blend/position/opacity knobs. There is no `url` (the overlay bytes are passed
 * as the stream) and no `width`/`height` (the overlay is pre-sized via its own
 * transform); mirrors `ImageDrawOptions`.
 */
export interface ImageDrawOptions {
    /** Offset, in pixels, from the bottom edge. */
    bottom?: number;
    /** Blend mode for compositing this overlay onto the image. Default `over`. */
    composite?: ImageCompositeMode;
    /** Offset, in pixels, from the left edge. */
    left?: number;
    /** Overlay opacity, `0.0` (transparent) – `1.0` (opaque). */
    opacity?: number;
    /** Tile the overlay across the base image: `true`, or a single axis `"x"`/`"y"`. */
    repeat?: "x" | "y" | boolean;
    /** Offset, in pixels, from the right edge. */
    right?: number;
    /** Offset, in pixels, from the top edge. */
    top?: number;
}

/**
 * One overlay applied through the **binding** path (`Images.transform`'s
 * `overlays` argument). The overlay bytes come from `image` (any {@link ImageInput});
 * an optional `transform` pre-sizes/reformats the overlay before it is drawn.
 */
export interface ImageOverlay extends ImageDrawOptions {
    /** The overlay image bytes — a stream, buffer, `Blob`, or R2 object body. */
    image: ImageInput;
    /** Optional transform applied to the overlay before compositing (e.g. resize). */
    transform?: TransformOptions;
}

/** One link in the transform chain: apply more transforms, draw an overlay, or finalize with `output`. */
export interface ImageTransformerLike {
    draw: (image: ImageTransformerLike | ReadableStream<Uint8Array>, options?: ImageDrawOptions) => ImageTransformerLike;
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

export interface LunoraImagesOptions {
    /** The Cloudflare Images binding (`env.IMAGES`). */
    binding: ImagesBindingLike;

    /** Maximum pixel value any single `width`/`height` may request. Default 10000. */
    maxDimension?: number;
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
     *
     * `overlays` are composited over the result in order (last on top) via the
     * binding's `draw` step — each overlay's bytes come from its own `image`, with
     * optional per-overlay `transform` (resize/reformat) and blend/position options.
     */
    transform: (input: ImageInput, transform?: TransformOptions, output?: OutputOptions, overlays?: ImageOverlay[]) => Promise<ImageTransformationResultLike>;
}
