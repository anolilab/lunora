import type { StorageListPage } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { useFileBrowser } from "../../../src/features/storage/hooks/use-file-browser";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

/**
 * Enough objects to run the orphan check's bucket enumeration past its
 * `ORPHAN_LIVE_KEY_CAP`. The check pages the bucket at 1,000 keys a call, so the
 * display listing (a different `limit`) is answered separately and stays small.
 */
const cappedListing = (options: { cursor?: string; limit?: number } = {}): StorageListPage => {
    if (options.limit !== 1000) {
        return { objects: [{ etag: "k1", key: "live.png", size: 10 }] };
    }

    const page = Number(options.cursor ?? "0");

    return {
        cursor: (page + 1).toString(),
        objects: Array.from({ length: 1000 }, (_, index) => {
            return { etag: "e", key: `bulk/${page.toString()}-${index.toString()}`, size: 1 };
        }),
    };
};

const wrapperFor =
    (mock: MockClientHooks) =>
    ({ children }: { children: ReactNode }): ReactElement => <LunoraProvider client={mock.asClient}>{children}</LunoraProvider>;

describe("useFileBrowser list cancellation", () => {
    it("discards an out-of-order list response so a stale prefix can't overwrite the current one", async () => {
        expect.assertions(3);

        // Hand-controlled list responses: each call parks a resolver so the test can
        // resolve them in a deliberately out-of-order sequence.
        const deferred: { prefix: string; resolve: (page: StorageListPage) => void }[] = [];
        const mock = createMockClient();

        mock.listStorageObjects.mockImplementation(
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- test mock returns a deferred promise by design
            async (options: { bucket?: string; cursor?: string; limit?: number; prefix?: string } = {}) =>
                new Promise<StorageListPage>((resolve) => {
                    deferred.push({ prefix: options.prefix ?? "", resolve });
                }),
        );

        const { result } = renderHook(() => useFileBrowser({ pageSize: 50 }), { wrapper: wrapperFor(mock) });

        // The mount effect kicked off the root ("") listing — its resolver is parked.
        await act(async () => {
            await Promise.resolve();
        });

        // Navigate into a folder, kicking off a second (newer) listing for "docs/".
        act(() => {
            result.current.navigate("docs/");
        });

        const rootCall = deferred.find((entry) => entry.prefix === "");
        const docsCall = deferred.find((entry) => entry.prefix === "docs/");

        // Resolve the NEWER (docs/) response first, then the older/stale root one.
        await act(async () => {
            docsCall?.resolve({ objects: [{ etag: "d1", key: "docs/guide.md", size: 300 }] });
            await Promise.resolve();
            rootCall?.resolve({ objects: [{ etag: "r1", key: "root.txt", size: 10 }] });
            await Promise.resolve();
        });

        // The stale root response must NOT have overwritten the docs/ listing.
        expect(result.current.prefix).toBe("docs/");
        expect(result.current.files).toHaveLength(1);
        expect(result.current.files[0]?.key).toBe("docs/guide.md");
    });
});

describe("useFileBrowser orphan check", () => {
    it("reports truncation — and no reference list at all — when the bucket outruns the enumeration cap", async () => {
        expect.assertions(3);

        const mock = createMockClient({ listStorageObjects: cappedListing });

        const { result } = renderHook(() => useFileBrowser({ pageSize: 50 }), { wrapper: wrapperFor(mock) });

        act(() => {
            result.current.checkOrphans();
        });

        await waitFor(() => {
            if (result.current.danglingBusy) {
                throw new Error("still checking");
            }
        });

        // The check deliberately skips the RPC on a partial key set, so it produced
        // no verdict: an empty `[]` here reads downstream as "checked, found none".
        expect(result.current.danglingTruncated).toBe(true);
        expect(result.current.danglingReferences).toBeUndefined();
        expect(mock.query.mock.calls.some((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.storageOrphans)).toBe(false);
    });

    it("keeps the reference list unset when the check fails, so an error can't sit beside a clean verdict", async () => {
        expect.assertions(3);

        const mock = createMockClient({
            listStorageObjects: (): StorageListPage => {
                return { objects: [{ etag: "k1", key: "live.png", size: 10 }] };
            },
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.storageOrphans) {
                    throw new Error("admin gate closed");
                }

                return { references: {}, storageColumns: { users: ["avatar"] } };
            },
        });

        const { result } = renderHook(() => useFileBrowser({ pageSize: 50 }), { wrapper: wrapperFor(mock) });

        act(() => {
            result.current.checkOrphans();
        });

        await waitFor(() => {
            if (result.current.danglingBusy) {
                throw new Error("still checking");
            }
        });

        expect(result.current.error).toContain("admin gate closed");
        expect(result.current.danglingReferences).toBeUndefined();
        expect(result.current.danglingTruncated).toBe(false);
    });
});
