import { afterEach, describe, expect, it, vi } from "vitest";

import { adminFetch } from "../../src/util/admin-url";

describe("adminFetch", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("names the target and the reason when the connection is refused", async () => {
        expect.assertions(1);

        vi.stubGlobal("fetch", async () => {
            throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8787") });
        });

        await expect(adminFetch("http://localhost:8787/_lunora/admin/import")).rejects.toThrow(
            "could not reach http://localhost:8787/_lunora/admin/import (connect ECONNREFUSED 127.0.0.1:8787) — is the dev server running? Start it, or pass --url to point at the worker",
        );
    });
});
