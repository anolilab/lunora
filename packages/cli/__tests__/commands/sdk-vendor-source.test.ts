/**
 * `sdk generate --source <repo>` names a fork's transport tree. The ref must be
 * resolved against that source, not against `anolilab/lunora`: a SHA pinned on
 * the upstream repo may not exist in the fork, and the stamp would name a
 * source the transport did not come from. The ref is pinned to a commit of the
 * fork with `git ls-remote`, so the stamp never records a moving branch. The fetch
 * and `git` are mocked, so nothing here touches the network.
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

const { execFileMock, resolveItemDirectoryMock } = vi.hoisted(() => {
    return {
        execFileMock:
            vi.fn<
                (file: string, args: string[], options: unknown, callback: (error: Error | null, result?: { stderr: string; stdout: string }) => void) => void
            >(),
        resolveItemDirectoryMock: vi.fn<typeof resolveItemDirectory>(),
    };
});

vi.mock(import("node:child_process"), async (importOriginal) => {
    return { ...(await importOriginal()), execFile: execFileMock as never };
});

const FORK_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const TAG_SHA = "1111111111111111111111111111111111111111";

/** `git ls-remote` as a fork that has an `alpha` branch, a `feat/alpha` branch and an annotated `v9.9.9` tag. */
const fakeLsRemote = (): void => {
    execFileMock.mockImplementation((_file, args, _options, callback) => {
        const refs: Record<string, string> = {
            "refs/heads/alpha": FORK_SHA,
            "refs/heads/feat/alpha": "2222222222222222222222222222222222222222",
            "refs/tags/v9.9.9": "3333333333333333333333333333333333333333",
            "refs/tags/v9.9.9^{}": TAG_SHA,
        };
        const stdout = Object.entries(refs)
            .filter(([name]) => args.includes(name))
            .map(([name, sha]) => `${sha}\t${name}\n`)
            .join("");

        callback(null, { stderr: "", stdout });
    });
};

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
        execFileMock.mockReset();
        fakeLsRemote();
    });

    afterEach(() => {
        rmSync(transportRoot, { force: true, recursive: true });
        rmSync(outputDirectory, { force: true, recursive: true });
    });

    it("pins a branch to the fork's commit, fetches that commit, and stamps it", async () => {
        expect.assertions(5);

        const result = await vendorTransport(vendorOptions({ ref: "alpha", source: "gh:someone/fork/sdks" }));

        expect(resolvePinnedSourceRef).not.toHaveBeenCalled();
        expect(execFileMock.mock.calls[0]?.[1]).toContain("https://github.com/someone/fork");
        expect(resolveItemDirectoryMock.mock.calls[0]?.[1]).toMatchObject({ ref: FORK_SHA, source: "gh:someone/fork/sdks" });
        expect(result.ref).toBe(FORK_SHA);
        expect(result.source).toBe("gh:someone/fork/sdks/python");
    });

    it("pins an annotated tag to the commit it points at", async () => {
        expect.assertions(1);

        const result = await vendorTransport(vendorOptions({ ref: "v9.9.9", source: "gh:someone/fork/sdks" }));

        expect(result.ref).toBe(TAG_SHA);
    });

    it("passes a full commit SHA through without asking git", async () => {
        expect.assertions(2);

        const result = await vendorTransport(vendorOptions({ ref: FORK_SHA, source: "gh:someone/fork/sdks" }));

        expect(execFileMock).not.toHaveBeenCalled();
        expect(result.ref).toBe(FORK_SHA);
    });

    it("fails clearly when the ref is not a branch or tag of the fork", async () => {
        expect.assertions(2);

        await expect(vendorTransport(vendorOptions({ ref: "missing", source: "gh:someone/fork/sdks" }))).rejects.toThrow(
            "missing is not a branch or tag of https://github.com/someone/fork.",
        );
        expect(resolveItemDirectoryMock).not.toHaveBeenCalled();
    });

    it("fails clearly when git cannot reach the fork", async () => {
        expect.assertions(1);

        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            callback(Object.assign(new Error("Command failed"), { stderr: "fatal: repository not found\n" }));
        });

        await expect(vendorTransport(vendorOptions({ ref: "alpha", source: "gh:someone/fork/sdks" }))).rejects.toThrow(
            "could not resolve alpha in https://github.com/someone/fork with git ls-remote: fatal: repository not found",
        );
    });

    it("refuses a source that names no git repository instead of stamping an unpinned ref", async () => {
        expect.assertions(2);

        await expect(vendorTransport(vendorOptions({ ref: "alpha", source: "https://example.com/sdks.tar.gz" }))).rejects.toThrow(
            "cannot pin --source https://example.com/sdks.tar.gz to a commit",
        );
        expect(resolveItemDirectoryMock).not.toHaveBeenCalled();
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
