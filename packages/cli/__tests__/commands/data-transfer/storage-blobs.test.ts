/**
 * `listStorageObjects` — the cursored walk behind the import/backup idempotency
 * pre-flight. The paging itself is `shared/collect-pages.ts`; what is local here
 * is the adapter that renames the storage route's `objects` array to the walker's
 * `records`, which a silent typo would turn into "nothing is stored yet" and a
 * full re-upload of every blob.
 */
import { describe, expect, it, vi } from "vitest";

import type { StreamingFetchLike } from "../../../src/commands/data-transfer/shared";
import type { BlobUploadContext } from "../../../src/commands/data-transfer/storage-blobs";
import { listStorageObjects } from "../../../src/commands/data-transfer/storage-blobs";

const jsonResponse = (body: unknown): Response => Response.json(body, { headers: { "content-type": "application/json" }, status: 200 });

describe("listStorageObjects", () => {
    it("walks every page and returns the objects from all of them", async () => {
        expect.assertions(3);

        const fetchImpl = vi.fn<StreamingFetchLike>(async (input) =>
            input.includes("cursor=")
                ? jsonResponse({ objects: [{ key: "b" }], truncated: false })
                : jsonResponse({ cursor: "c1", objects: [{ key: "a" }], truncated: true }),
        );

        const context: BlobUploadContext = { baseUrl: "https://app.example", fetchImpl, token: "tkn" };

        await expect(listStorageObjects(context, "blobs/")).resolves.toStrictEqual([{ key: "a" }, { key: "b" }]);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("&cursor=c1");
    });

    it("throws on a failed page instead of returning a short list", async () => {
        expect.assertions(1);

        const context: BlobUploadContext = {
            baseUrl: "https://app.example",
            fetchImpl: async () => new Response("nope", { status: 500 }),
            token: "tkn",
        };

        await expect(listStorageObjects(context, "blobs/")).rejects.toThrow("storage list failed (HTTP 500)");
    });
});
