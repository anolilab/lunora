/* eslint-disable no-secrets/no-secrets -- JSDoc names the `ReadableStream<Uint8Array>` return type, not a credential. */

/**
 * The action-only Images client over the Cloudflare Images binding.
 *
 * `transform`/`info` run `env.IMAGES.input(stream).transform(...).output(...)`
 * — non-deterministic network/compute I/O, so the generated ctx wires this onto
 * **ActionCtx only** (the `ctx.ai` precedent). The pure URL builders live in
 * their own modules and are safe anywhere.
 */
import { LunoraError } from "@lunora/errors";

import type {
    ImageDrawOptions,
    ImageInfoLike,
    ImageInput,
    ImageOutputFormat,
    ImageOverlay,
    Images,
    ImageTransformationResultLike,
    ImageTransformerLike,
    LunoraImagesOptions,
    OutputOptions,
    R2ObjectBodyLike,
    TransformOptions,
} from "./types";

/** Output MIME types Lunora permits. A request for anything else is rejected before it hits the binding. */
const ALLOWED_OUTPUT_FORMATS: ReadonlySet<ImageOutputFormat> = new Set<ImageOutputFormat>(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);

/** Ceiling on any single `width`/`height` so a hostile request can't ask for a multi-gigapixel canvas. */
const DEFAULT_MAX_DIMENSION = 10_000;

const DEFAULT_OUTPUT_FORMAT: ImageOutputFormat = "image/webp";

const isR2ObjectBody = (input: ImageInput): input is R2ObjectBodyLike => {
    if (typeof input !== "object") {
        return false;
    }

    const object: object = input;

    return "body" in object && !(input instanceof ArrayBuffer) && !(input instanceof Uint8Array);
};

/**
 * Normalize any accepted input into the `ReadableStream<Uint8Array>` the binding
 * wants. An R2 object body (from `ctx.storage.download(key)`) is unwrapped to its
 * `.body` stream; a `Blob`/`ArrayBuffer`/`Uint8Array` is wrapped in a one-chunk
 * stream; a stream passes through.
 */
const toStream = (input: ImageInput): ReadableStream<Uint8Array> => {
    if (input instanceof ReadableStream) {
        return input as ReadableStream<Uint8Array>;
    }

    if (isR2ObjectBody(input)) {
        if (input.body === null) {
            throw new LunoraError("INTERNAL", "@lunora/bindings/images: R2 object body is null (object missing or already consumed)");
        }

        return input.body as ReadableStream<Uint8Array>;
    }

    if (input instanceof Blob) {
        return input.stream();
    }

    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
};

/**
 * Clamp `width`/`height` to `[1, maxDimension]` (integers) so a malformed or
 * hostile request can't request an absurd canvas. Other transform keys pass
 * through untouched — the binding owns their validation.
 */
const sanitizeTransform = (transform: TransformOptions | undefined, maxDimension: number): TransformOptions => {
    if (transform === undefined) {
        return {};
    }

    // `Math.max(1, …)` is what makes the range the docblock promises real: the
    // positivity guard runs on the RAW value, so a fractional `0.5` passed it
    // and then floored to `width: 0` — a dimension the binding rejects, for a
    // request that named a legitimate (if sub-pixel) size.
    const clampDimension = (value: number): number => {
        if (!Number.isFinite(value) || value <= 0) {
            throw new TypeError("@lunora/bindings/images: width/height must be a positive finite number");
        }

        return Math.max(1, Math.min(Math.floor(value), maxDimension));
    };

    return {
        ...transform,
        ...(transform.width === undefined ? {} : { width: clampDimension(transform.width) }),
        ...(transform.height === undefined ? {} : { height: clampDimension(transform.height) }),
    };
};

/** Split an overlay into its image-bearing parts and the bare `draw` blend/position options. */
const splitOverlay = (overlay: ImageOverlay): { drawOptions: ImageDrawOptions; image: ImageInput; transform?: TransformOptions } => {
    const { image, transform, ...drawOptions } = overlay;

    return { drawOptions, image, transform };
};

const resolveOutput = (output: OutputOptions | undefined): OutputOptions & { format: ImageOutputFormat } => {
    const format = output?.format ?? DEFAULT_OUTPUT_FORMAT;

    if (!ALLOWED_OUTPUT_FORMATS.has(format)) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/bindings/images: unsupported output format "${format}" (allowed: ${[...ALLOWED_OUTPUT_FORMATS].join(", ")})`,
        );
    }

    return { ...output, format };
};

/**
 * Build the action-only {@link Images} client over a Cloudflare Images binding.
 *
 * ```ts
 * const images = createImages({ binding: env.IMAGES });
 * const result = await images.transform(
 *     await ctx.storage.download("uploads/avatar.png"),
 *     { width: 256, height: 256, fit: "cover" },
 *     { format: "image/webp", quality: 82 },
 * );
 * ```
 */
// eslint-disable-next-line import/prefer-default-export -- named export: the package barrel re-exports by name, per the repo's no-default-mixing convention
export const createImages = (options: LunoraImagesOptions): Images => {
    const { binding } = options;
    const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;

    return {
        info: async (input: ImageInput): Promise<ImageInfoLike> => binding.info(toStream(input)),

        transform: async (
            input: ImageInput,
            transform?: TransformOptions,
            output?: OutputOptions,
            overlays?: ImageOverlay[],
        ): Promise<ImageTransformationResultLike> => {
            const safeTransform = sanitizeTransform(transform, maxDimension);
            const outputOptions = resolveOutput(output);

            let transformer: ImageTransformerLike = binding.input(toStream(input)).transform(safeTransform);

            for (const overlay of overlays ?? []) {
                const { drawOptions, image, transform: overlayTransform } = splitOverlay(overlay);
                // Pre-size/reformat the overlay via its own transform when requested, otherwise
                // hand the raw stream to `draw` directly.
                const overlayImage =
                    overlayTransform === undefined
                        ? toStream(image)
                        : binding.input(toStream(image)).transform(sanitizeTransform(overlayTransform, maxDimension));

                transformer = transformer.draw(overlayImage, drawOptions);
            }

            return transformer.output(outputOptions);
        },
    };
};
