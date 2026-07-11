import type { StorageListPage } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { act, renderHook } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { useFileBrowser } from "../../../src/features/storage/hooks/use-file-browser";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

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
