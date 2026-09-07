import { describe, expect, it, vi } from "vitest";

import { collectPages } from "../../../shared/collect-pages";

describe("collectPages", () => {
    it("concatenates every page in order", async () => {
        expect.assertions(2);

        const fetchPage = vi.fn<(cursor?: string) => Promise<{ cursor?: string; records?: number[]; truncated?: boolean }>>(async (cursor) =>
            cursor === undefined ? { cursor: "c1", records: [1, 2], truncated: true } : { records: [3], truncated: false },
        );

        await expect(collectPages(fetchPage)).resolves.toStrictEqual([1, 2, 3]);
        expect(fetchPage).toHaveBeenNthCalledWith(2, "c1");
    });

    it("stops on a page that claims more but carries an empty cursor", async () => {
        expect.assertions(2);

        // The case the two hand-written walkers disagreed on: trusting
        // `truncated` alone rebuilds the FIRST page's URL (an empty cursor is
        // no cursor) and re-requests it forever.
        const fetchPage = vi.fn<() => Promise<{ cursor?: string; records?: number[]; truncated?: boolean }>>(async () => {
            return { cursor: "", records: [1], truncated: true };
        });

        await expect(collectPages(fetchPage)).resolves.toStrictEqual([1]);
        expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it("throws rather than looping when the cursor stops advancing", async () => {
        expect.assertions(1);

        const fetchPage = async () => {
            return { cursor: "stuck", records: [1], truncated: true };
        };

        await expect(collectPages(fetchPage)).rejects.toThrow("did not advance its cursor");
    });

    it("tolerates a page with no records array", async () => {
        expect.assertions(1);

        await expect(
            collectPages(async () => {
                return {};
            }),
        ).resolves.toStrictEqual([]);
    });
});
