import { bench, describe } from "vitest";

import { createFakeR2UploadBucket } from "../__tests__/fake-r2-upload-bucket";
import { R2UploadPartWriter } from "../src/r2-upload-part-writer";
import type { FileRecord, R2UploadBucket, Segment } from "../src/r2-upload-types";

/**
 * A tus client sending chunks under R2's 5 MiB part minimum leaves each one in
 * the bucket as a segment, and the request that completes a part (or the file)
 * reads every waiting segment back before storing it. Those reads are R2 round
 * trips, so the fake bucket answers `get` after a simulated network delay: the
 * bench measures how the reads are scheduled, not memcpy.
 */

const GET_LATENCY_MS = 5;
const SEGMENT_COUNT = 4;
const SEGMENT_SIZE = 256 * 1024;

const slowGets = (bucket: R2UploadBucket): R2UploadBucket => {
    return {
        ...bucket,
        get: async (...arguments_: Parameters<R2UploadBucket["get"]>) => {
            await new Promise((resolve) => {
                setTimeout(resolve, GET_LATENCY_MS);
            });

            return bucket.get(...arguments_);
        },
    };
};

const file = { contentType: "application/octet-stream", id: "bench", name: "bench.bin" } as FileRecord;
const lease = { confirm: async () => undefined, save: async () => undefined, token: "bench" };

// Seeded from the bench body: under this config a `beforeAll` here had not run
// by the first measured call, which then saw no bucket.
let seeded: Promise<{ bucket: R2UploadBucket; segments: Segment[] }> | undefined;

const seed = async (): Promise<{ bucket: R2UploadBucket; segments: Segment[] }> => {
    const fake = createFakeR2UploadBucket();
    const segments: Segment[] = [];

    for (let index = 0; index < SEGMENT_COUNT; index += 1) {
        const key = `segments/${String(index)}`;

        // eslint-disable-next-line no-await-in-loop -- one-time fixture setup
        await fake.put(key, new Uint8Array(SEGMENT_SIZE));
        segments.push({ key, size: SEGMENT_SIZE });
    }

    return { bucket: slowGets(fake), segments };
};

describe("R2UploadPartWriter.finish", () => {
    bench(`joins ${String(SEGMENT_COUNT)} waiting segments (${String(GET_LATENCY_MS)} ms per get)`, async () => {
        seeded ??= seed();

        const { bucket, segments } = await seeded;
        const writer = new R2UploadPartWriter(bucket, file, { parts: [], segments }, "segments/", lease);

        await writer.finish();
    });
});
