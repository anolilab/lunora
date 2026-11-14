/**
 * `sdk generate --source <repo>` names a fork's transport tree. The ref must be
 * resolved against that source, not against `anolilab/lunora`: a SHA pinned on
 * the upstream repo may not exist in the fork, and the stamp would name a
 * source the transport did not come from. The fetch is mocked, so nothing here
 * touches the network.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SDK_TARGETS } from "@lunora/codegen";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { resolveItemDirectory } from "../../src/commands/registry/resolve";
import { vendorTransport } from "../../src/commands/sdk/vendor";
import type { Logger } from "../../src/util/logger";
import { resolvePinnedSourceRef } from "../../src/util/source-ref";

const { resolveItemDirectoryMock } = vi.hoisted(() => {
    return { resolveItemDirectoryMock: vi.fn<typeof resolveItemDirectory>() };
});

vi.mock(import("../../src/commands/registry/resolve"), () => {
    return { resolveItemDirectory: resolveItemDirectoryMock };
});

vi.mock(import("../../src/util/source-ref"), async (importOriginal) => {
    return {
        ...(await importOriginal()),
        resolvePinnedSourceRef: vi.fn<typeof resolvePinnedSourceRef>(async () => {
            throw new Error("must not pin a custom source");
        }),
    };
});

const silentLogger: Logger = { error: () => {}, info: () => {}, success: () => {}, warn: () => {} };

const target = SDK_TARGETS.python!;

let transportRoot: string;
let outputDirectory: string;

/** A minimal python transport on disk, handed back by the mocked fetch. */
const fakeTransportDirectory = (): string => {
    const directory = join(transportRoot, "python");

    mkdirSync(join(directory, "lunora"), { recursive: true });
    writeFileSync(join(directory, "lunora", "client.py"), "CLIENT = 1\n", "utf8");

    return directory;
};

const vendorOptions = (overrides: { ref?: string; source?: string }) => {
    return {
        allowUnsafeSource: undefined,
        from: undefined,
        language: "python",
        logger: silentLogger,
        outputDirectory,
        ref: overrides.ref,
        source: overrides.source,
        target,
    };
};

describe("sdk vendor — resolves refs against a custom --source", () => {
    beforeEach(() => {
        transportRoot = mkdtempSync(join(tmpdir(), "lunora-sdk-source-"));
        outputDirectory = mkdtempSync(join(tmpdir(), "lunora-sdk-source-out-"));
        resolveItemDirectoryMock.mockReset();
        resolveItemDirectoryMock.mockImplementation(async () => {
            return { cleanup: () => {}, directory: fakeTransportDirectory() };
        });
        vi.mocked(resolvePinnedSourceRef).mockClear();
    });

    afterEach(() => {
        rmSync(transportRoot, { force: true, recursive: true });
        rmSync(outputDirectory, { force: true, recursive: true });
    });

    it("fetches from the custom source without pinning it, and stamps that source", async () => {
        expect.assertions(3);

        const result = await vendorTransport(vendorOptions({ source: "gh:someone/fork/sdks" }));

        expect(resolvePinnedSourceRef).not.toHaveBeenCalled();
        expect(resolveItemDirectoryMock.mock.calls[0]?.[1]).toMatchObject({ source: "gh:someone/fork/sdks" });
        expect(result.source).toBe("gh:someone/fork/sdks/python");
    });

    it("passes an explicit --ref through verbatim when the source is custom", async () => {
        expect.assertions(2);

        await vendorTransport(vendorOptions({ ref: "v9.9.9", source: "gh:someone/fork/sdks" }));

        expect(resolveItemDirectoryMock.mock.calls[0]?.[1]).toMatchObject({ ref: "v9.9.9", source: "gh:someone/fork/sdks" });
        expect(resolvePinnedSourceRef).not.toHaveBeenCalled();
    });

    it("still pins the upstream ref and stamps the default base when no source is given", async () => {
        expect.assertions(3);

        vi.mocked(resolvePinnedSourceRef).mockResolvedValueOnce("0123456789abcdef0123456789abcdef01234567");

        const result = await vendorTransport(vendorOptions({}));

        expect(resolvePinnedSourceRef).toHaveBeenCalledWith(expect.any(String), silentLogger);
        expect(resolveItemDirectoryMock.mock.calls[0]?.[1]).toMatchObject({ ref: "0123456789abcdef0123456789abcdef01234567" });
        expect(result.source).toBe("gh:anolilab/lunora/sdks/python");
    });
});
