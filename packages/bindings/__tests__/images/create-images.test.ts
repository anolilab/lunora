import { describe, expect, it, vi } from "vitest";

import { createImages } from "../../src/images/create-images";
import type {
    ImageDrawOptions,
    ImageInfoLike,
    ImagesBindingLike,
    ImageTransformationResultLike,
    ImageTransformerLike,
    OutputOptions,
    TransformOptions,
} from "../../src/images/types";

interface DrawCall {
    image: ImageTransformerLike | ReadableStream<Uint8Array>;
    options?: ImageDrawOptions;
}

interface RecordedCalls {
    /** Every `draw(image, options)` applied to the primary transformer chain. */
    draws: DrawCall[];
    infoStreams: ReadableStream[];
    /** Every `input(stream)` call's stream, in order (base image first, then overlay streams). */
    inputStreams: ReadableStream[];
    output?: OutputOptions;
    /** The base image stream (first `input(...)`). */
    stream?: ReadableStream;
    /** Every `transform(...)` call, in order (base transform first, then any overlay transforms). */
    transforms: TransformOptions[];
}

/**
 * A recording double for the `input(stream).transform(opts).draw(...).output(opts)`
 * chain. Captures the transform + draw + output options the factory threads
 * through so we can assert on them without a real `env.IMAGES` worker pool.
 */
const createFakeBinding = (): { binding: ImagesBindingLike; calls: RecordedCalls } => {
    const calls: RecordedCalls = { draws: [], infoStreams: [], inputStreams: [], transforms: [] };

    const result: ImageTransformationResultLike = {
        contentType: () => "image/webp",
        image: () => new ReadableStream<Uint8Array>(),
        response: () => new Response(null),
    };

    // Every link in the chain shares one recording transformer so draws/transforms
    // applied after the first `.transform(...)` are all captured.
    const makeTransformer = (): ImageTransformerLike => {
        const transformer: ImageTransformerLike = {
            draw: (image, options) => {
                calls.draws.push({ image, options });

                return transformer;
            },
            output: async (output): Promise<ImageTransformationResultLike> => {
                calls.output = output;

                return result;
            },
            transform: (transform) => {
                calls.transforms.push(transform);

                return transformer;
            },
        };

        return transformer;
    };

    const binding: ImagesBindingLike = {
        info: async (stream): Promise<ImageInfoLike> => {
            calls.infoStreams.push(stream);

            return { fileSize: 100, format: "image/png", height: 10, width: 10 };
        },
        input: (stream) => {
            calls.inputStreams.push(stream);
            calls.stream ??= stream;

            return makeTransformer();
        },
    };

    return { binding, calls };
};

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });

describe("createImages", () => {
    it("threads width/height/format through the transform chain", async () => {
        expect.assertions(2);

        const { binding, calls } = createFakeBinding();
        const images = createImages({ binding });

        await images.transform(streamOf(new Uint8Array([1, 2, 3])), { fit: "cover", height: 128, width: 256 }, { format: "image/avif", quality: 80 });

        expect(calls.transforms[0]).toMatchObject({ fit: "cover", height: 128, width: 256 });
        expect(calls.output).toEqual({ format: "image/avif", quality: 80 });
    });

    it("defaults the output format to image/webp", async () => {
        expect.assertions(1);

        const { binding, calls } = createFakeBinding();
        const images = createImages({ binding });

        await images.transform(streamOf(new Uint8Array([1])));

        expect(calls.output?.format).toBe("image/webp");
    });

    it("accepts an R2 object body and reads its .body stream", async () => {
        expect.assertions(2);

        const { binding, calls } = createFakeBinding();
        const images = createImages({ binding });
        const body = streamOf(new Uint8Array([9, 9, 9]));

        await images.transform({ body }, { width: 64 });

        expect(calls.stream).toBe(body);
        expect(calls.transforms[0]).toMatchObject({ width: 64 });
    });

    it("throws when an R2 object body is null", async () => {
        expect.assertions(1);

        const { binding } = createFakeBinding();
        const images = createImages({ binding });

        await expect(images.transform({ body: null })).rejects.toThrow(/R2 object body is null/);
    });

    it("rejects a disallowed output format before touching the binding", async () => {
        expect.assertions(2);

        const { binding } = createFakeBinding();
        const inputSpy = vi.spyOn(binding, "input");
        const images = createImages({ binding });

        await expect(images.transform(streamOf(new Uint8Array([1])), undefined, { format: "image/tiff" as never })).rejects.toThrow(
            /unsupported output format/,
        );
        expect(inputSpy).not.toHaveBeenCalled();
    });

    it("clamps width/height to the configured ceiling", async () => {
        expect.assertions(1);

        const { binding, calls } = createFakeBinding();
        const images = createImages({ binding, maxDimension: 4096 });

        await images.transform(streamOf(new Uint8Array([1])), { height: 10_000_000, width: 10_000 });

        expect(calls.transforms[0]).toMatchObject({ height: 4096, width: 4096 });
    });

    it("rejects a non-positive dimension", async () => {
        expect.assertions(1);

        const { binding } = createFakeBinding();
        const images = createImages({ binding });

        await expect(images.transform(streamOf(new Uint8Array([1])), { width: -1 })).rejects.toThrow(/positive finite number/);
    });

    it("probes info() with the input stream", async () => {
        expect.assertions(2);

        const { binding, calls } = createFakeBinding();
        const images = createImages({ binding });
        const stream = streamOf(new Uint8Array([1, 2]));

        const info = await images.info(stream);

        expect(calls.infoStreams[0]).toBe(stream);
        expect(info).toMatchObject({ format: "image/png" });
    });

    it("wraps a Blob input into a stream", async () => {
        expect.assertions(2);

        const { binding, calls } = createFakeBinding();
        const images = createImages({ binding });

        await images.transform(new Blob([new Uint8Array([1, 2, 3])]), { width: 32 });

        expect(calls.stream).toBeInstanceOf(ReadableStream);
        expect(calls.transforms[0]).toMatchObject({ width: 32 });
    });

    it("threads the new scale-up fit + AI upscale knobs through unchanged", async () => {
        expect.assertions(1);

        const { binding, calls } = createFakeBinding();
        const images = createImages({ binding });

        await images.transform(streamOf(new Uint8Array([1])), { fit: "scale-up", height: 2000, upscale: "generate", width: 2000 });

        expect(calls.transforms[0]).toMatchObject({ fit: "scale-up", upscale: "generate" });
    });

    it("applies overlays via draw() in order, last on top", async () => {
        expect.assertions(3);

        const { binding, calls } = createFakeBinding();
        const images = createImages({ binding });
        const logo = streamOf(new Uint8Array([7]));
        const badge = streamOf(new Uint8Array([8]));

        await images.transform(streamOf(new Uint8Array([1])), { width: 800 }, { format: "image/webp" }, [
            { composite: "over", image: logo, opacity: 0.8, top: 10, left: 10 },
            { composite: "lighter", image: badge, bottom: 0, right: 0 },
        ]);

        expect(calls.draws).toHaveLength(2);
        expect(calls.draws[0]).toMatchObject({ image: logo, options: { composite: "over", left: 10, opacity: 0.8, top: 10 } });
        expect(calls.draws[1]).toMatchObject({ image: badge, options: { bottom: 0, composite: "lighter", right: 0 } });
    });

    it("pre-sizes an overlay through its own transform before drawing", async () => {
        expect.assertions(3);

        const { binding, calls } = createFakeBinding();
        const images = createImages({ binding });
        const logo = streamOf(new Uint8Array([7]));

        await images.transform(streamOf(new Uint8Array([1])), { width: 800 }, undefined, [{ image: logo, transform: { width: 64 }, top: 5 }]);

        // base transform + overlay transform both recorded; overlay drawn with a transformer, not the raw stream.
        expect(calls.transforms).toEqual([{ width: 800 }, { width: 64 }]);
        expect(calls.draws[0]?.options).toMatchObject({ top: 5 });
        expect(calls.draws[0]?.image).not.toBe(logo);
    });

    it("wraps an ArrayBuffer input into a one-chunk stream", async () => {
        expect.assertions(2);

        const { binding, calls } = createFakeBinding();
        const images = createImages({ binding });

        await images.transform(new Uint8Array([1, 2, 3]).buffer, { width: 16 });

        expect(calls.stream).toBeInstanceOf(ReadableStream);
        expect(calls.transforms[0]).toMatchObject({ width: 16 });
    });

    it("wraps a Uint8Array input into a one-chunk stream", async () => {
        expect.assertions(1);

        const { binding, calls } = createFakeBinding();
        const images = createImages({ binding });

        await images.transform(new Uint8Array([4, 5, 6]), { height: 16 });

        expect(calls.stream).toBeInstanceOf(ReadableStream);
    });

    it("clamps an overlay's own transform dimensions to the ceiling", async () => {
        expect.assertions(1);

        const { binding, calls } = createFakeBinding();
        const images = createImages({ binding, maxDimension: 256 });
        const logo = streamOf(new Uint8Array([7]));

        await images.transform(streamOf(new Uint8Array([1])), { width: 200 }, undefined, [{ image: logo, transform: { width: 9999 } }]);

        // base transform first, then the overlay transform — clamped to 256.
        expect(calls.transforms).toEqual([{ width: 200 }, { width: 256 }]);
    });

    it("clamps a fractional dimension up to 1 rather than down to 0", async () => {
        expect.assertions(1);

        // The positivity guard runs on the RAW value, so `0.5` passed it and
        // then floored to `0` — outside the `[1, maxDimension]` range the clamp
        // promises, and a dimension the binding rejects.
        const { binding, calls } = createFakeBinding();
        const images = createImages({ binding });

        await images.transform(streamOf(new Uint8Array([1])), { height: 0.5, width: 0.25 });

        expect(calls.transforms[0]).toStrictEqual({ height: 1, width: 1 });
    });
});
