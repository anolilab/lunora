import { describe, expect, it, vi } from "vitest";

import { createImages } from "../create-images";
import type { ImageInfoLike, ImagesBindingLike, ImageTransformationResultLike, OutputOptions, TransformOptions } from "../types";

/**
 * A recording double for the `input(stream).transform(opts).output(opts)` chain.
 * Captures the transform + output options the factory threads through so we can
 * assert on them without a real `env.IMAGES` worker pool.
 */
const createFakeBinding = (): {
    binding: ImagesBindingLike;
    calls: { infoStreams: ReadableStream[]; output?: OutputOptions; stream?: ReadableStream; transform?: TransformOptions };
} => {
    const calls: { infoStreams: ReadableStream[]; output?: OutputOptions; stream?: ReadableStream; transform?: TransformOptions } = {
        infoStreams: [],
    };

    const result: ImageTransformationResultLike = {
        contentType: () => "image/webp",
        image: () => new ReadableStream<Uint8Array>(),
        response: () => new Response(null),
    };

    const binding: ImagesBindingLike = {
        info: async (stream): Promise<ImageInfoLike> => {
            calls.infoStreams.push(stream);

            return { fileSize: 100, format: "image/png", height: 10, width: 10 };
        },
        input: (stream) => {
            calls.stream = stream;

            return {
                output: async (output): Promise<ImageTransformationResultLike> => {
                    calls.output = output;

                    return result;
                },
                transform: (transform) => {
                    calls.transform = transform;

                    return {
                        output: async (output): Promise<ImageTransformationResultLike> => {
                            calls.output = output;

                            return result;
                        },
                        transform: () => {
                            throw new Error("unused");
                        },
                    };
                },
            };
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

        expect(calls.transform).toMatchObject({ fit: "cover", height: 128, width: 256 });
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
        expect(calls.transform).toMatchObject({ width: 64 });
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

        expect(calls.transform).toMatchObject({ height: 4096, width: 4096 });
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
        expect(calls.transform).toMatchObject({ width: 32 });
    });
});
