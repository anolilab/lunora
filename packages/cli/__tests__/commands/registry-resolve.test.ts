import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveRemoteRef } from "../../src/commands/registry/resolve";
import type { AddCommandOptions } from "../../src/commands/registry/types";
import type { Logger } from "../../src/util/logger";

/** A fully-hex 40-char commit SHA fixture. */
const SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

const silentLogger = (): Logger => {
    const noop = (): void => {};

    return { error: noop, info: noop, success: noop, warn: noop };
};

/** The (loosely-typed) shape of the global `fetch` the pinning code calls — enough for a stub. */
type FetchStub = () => Promise<{ json: () => Promise<unknown>; ok: boolean }>;

/** A GitHub commits API stub that always resolves the branch to {@link SHA}. */
const okShaResponse: FetchStub = async () => {
    return {
        json: async () => {
            return { sha: SHA };
        },
        ok: true,
    };
};

describe("resolveRemoteRef", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("pins the moving branch to a SHA once per operation and reuses it for every fetch", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<FetchStub>(okShaResponse);

        vi.stubGlobal("fetch", fetchMock);

        // A single command may fetch an item directory AND the registry root — they
        // share one `options` object, so the branch must be pinned exactly once and
        // the same SHA reused (never resolved twice, which could mix two commits).
        const options: AddCommandOptions = { logger: silentLogger(), names: [] };

        const first = await resolveRemoteRef(options);
        const second = await resolveRemoteRef(options);

        expect(first).toBe(SHA);
        expect(second).toBe(SHA);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("re-resolves for a distinct operation (a fresh options object)", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<FetchStub>(okShaResponse);

        vi.stubGlobal("fetch", fetchMock);

        // Separate commands = separate options objects = each pins independently,
        // so a later command can't be stuck on an earlier command's stale pin.
        await resolveRemoteRef({ logger: silentLogger(), names: [] });
        await resolveRemoteRef({ logger: silentLogger(), names: [] });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
