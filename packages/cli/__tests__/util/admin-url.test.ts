import { afterEach, describe, expect, it, vi } from "vitest";

import { adminFetch } from "../../src/util/admin-url";

describe("adminFetch", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("names a local target, the reason, and the dev server when the connection is refused", async () => {
        expect.assertions(1);

        vi.stubGlobal("fetch", async () => {
            throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8787") });
        });

        await expect(adminFetch("http://localhost:8787/_lunora/admin/import")).rejects.toThrow(
            "could not reach http://localhost:8787/_lunora/admin/import (connect ECONNREFUSED 127.0.0.1:8787) — is the dev server running? Start it, or pass --url to point at the worker",
        );
    });

    it("names a remote target without blaming a dev server", async () => {
        expect.assertions(1);

        vi.stubGlobal("fetch", async () => {
            throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND app.example") });
        });

        await expect(adminFetch("https://app.example/_lunora/admin/export")).rejects.toThrow(
            /^could not reach https:\/\/app\.example\/_lunora\/admin\/export \(getaddrinfo ENOTFOUND app\.example\)$/u,
        );
    });

    it("rethrows an abort as it is", async () => {
        expect.assertions(1);

        const abort = new DOMException("The operation was aborted", "AbortError");

        vi.stubGlobal("fetch", async () => {
            throw abort;
        });

        await expect(adminFetch("http://localhost:8787/_lunora/rpc")).rejects.toBe(abort);
    });
});
