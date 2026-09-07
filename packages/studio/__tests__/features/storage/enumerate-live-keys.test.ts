import type { StorageListPage } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { enumerateLiveKeys, ORPHAN_LIVE_KEY_CAP } from "../../../src/features/storage/hooks/use-file-browser";

/**
 * A bucket of exactly `total` keys, paged the way R2 does: a cursor on every
 * page that has a successor and none on the last.
 */
const bucketOf = (total: number): { list: (options: { cursor?: string; limit?: number }) => Promise<StorageListPage> } => {
    return {
        list: async (options: { cursor?: string; limit?: number }): Promise<StorageListPage> => {
            const offset = Number(options.cursor ?? "0");
            const size = Math.min(options.limit ?? 1000, total - offset);
            const next = offset + size;

            return {
                ...(next < total ? { cursor: next.toString() } : {}),
                objects: Array.from({ length: size }, (_, index) => {
                    return { etag: "e", key: `k${(offset + index).toString()}`, size: 1 };
                }),
            };
        },
    };
};

describe("enumerateLiveKeys", () => {
    it("walks a small bucket to the end and reports no truncation", async () => {
        expect.assertions(2);

        const result = await enumerateLiveKeys(bucketOf(2500));

        expect(result.liveKeys).toHaveLength(2500);
        expect(result.truncated).toBe(false);
    });

    it("stops at the cap and reports truncation when pages remain", async () => {
        expect.assertions(2);

        const result = await enumerateLiveKeys(bucketOf(ORPHAN_LIVE_KEY_CAP + 1));

        expect(result.liveKeys).toHaveLength(ORPHAN_LIVE_KEY_CAP);
        expect(result.truncated).toBe(true);
    });

    it("does not call a bucket of exactly the cap truncated — it enumerated completely", async () => {
        expect.assertions(2);

        const result = await enumerateLiveKeys(bucketOf(ORPHAN_LIVE_KEY_CAP));

        expect(result.liveKeys).toHaveLength(ORPHAN_LIVE_KEY_CAP);
        expect(result.truncated).toBe(false);
    });

    /**
     * Nothing on the wire enforces `objects.length <= limit`: `StorageListFunction`
     * is a caller-supplied seam and the admin route hands its result straight back.
     * A lister that ignores `limit` must not be able to overrun the cap — and must
     * not get a complete verdict for the keys it dropped on the way past it.
     */
    const overLimitBucket = (pageSize: number, pages: number): { list: (options: { cursor?: string; limit?: number }) => Promise<StorageListPage> } => {
        return {
            list: async (options: { cursor?: string; limit?: number }): Promise<StorageListPage> => {
                const page = Number(options.cursor ?? "0");
                const offset = page * pageSize;

                return {
                    ...(page + 1 < pages ? { cursor: (page + 1).toString() } : {}),
                    objects: Array.from({ length: pageSize }, (_, index) => {
                        return { etag: "e", key: `k${(offset + index).toString()}`, size: 1 };
                    }),
                };
            },
        };
    };

    it("caps a lister that ignores `limit` and returns an over-sized page", async () => {
        expect.assertions(2);

        // One cursorless page holding 1.5× the cap: the walk ends with nothing
        // pending, so the old `hasMore` reported `truncated: false` over a live-key
        // list half again the size it is allowed to hold.
        const result = await enumerateLiveKeys(overLimitBucket(ORPHAN_LIVE_KEY_CAP * 1.5, 1));

        expect(result.liveKeys).toHaveLength(ORPHAN_LIVE_KEY_CAP);
        expect(result.truncated).toBe(true);
    });

    it("keeps `truncated` for an over-sized page that still has a cursor", async () => {
        expect.assertions(2);

        const result = await enumerateLiveKeys(overLimitBucket(ORPHAN_LIVE_KEY_CAP + 5, 3));

        expect(result.liveKeys).toHaveLength(ORPHAN_LIVE_KEY_CAP);
        expect(result.truncated).toBe(true);
    });
});
