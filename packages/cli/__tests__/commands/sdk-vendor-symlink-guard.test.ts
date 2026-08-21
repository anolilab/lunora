/**
 * The SDK transport is copied out of a giget-fetched (possibly hostile) staging
 * directory or an arbitrary `--from` directory. A hostile source could plant a
 * symlink (`config.py -> ~/.ssh/id_rsa`) inside the transport — copying it
 * verbatim into the user's project would make anything that later reads the
 * generated SDK follow the link. The vendor copy must refuse, matching the
 * registry copy-in guard. Every symlink here points at a scratch file this test
 * creates and deletes — never a real user path.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SDK_TARGETS } from "@lunora/codegen";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { vendorTransport } from "../../src/commands/sdk/vendor";
import type { Logger } from "../../src/util/logger";

const silentLogger: Logger = { error: () => {}, info: () => {}, success: () => {}, warn: () => {} };

const target = SDK_TARGETS.python!;

let transportRoot: string;
let outputDirectory: string;
let scratchDir: string;

/** The shared option bag for a `--from` vendoring of the python transport. */
const vendorOptions = () => {
    return {
        allowUnsafeSource: undefined,
        from: transportRoot,
        language: "python",
        logger: silentLogger,
        outputDirectory,
        ref: undefined,
        source: undefined,
        target,
    };
};

describe("sdk vendor — refuses to copy a transport symlink", () => {
    beforeEach(() => {
        transportRoot = mkdtempSync(join(tmpdir(), "lunora-sdk-transport-"));
        outputDirectory = mkdtempSync(join(tmpdir(), "lunora-sdk-out-"));
        scratchDir = mkdtempSync(join(tmpdir(), "lunora-sdk-scratch-"));
        mkdirSync(join(transportRoot, "python", "lunora"), { recursive: true });
        writeFileSync(join(transportRoot, "python", "lunora", "client.py"), "CLIENT = 1\n", "utf8");
    });

    afterEach(() => {
        rmSync(transportRoot, { force: true, recursive: true });
        rmSync(outputDirectory, { force: true, recursive: true });
        rmSync(scratchDir, { force: true, recursive: true });
    });

    it("throws naming the symlink's path and vendors nothing through the link", async () => {
        expect.assertions(2);

        const linkTarget = join(scratchDir, "target.txt");

        writeFileSync(linkTarget, "scratch-marker\n", "utf8");
        symlinkSync(linkTarget, join(transportRoot, "python", "lunora", "config.py"));

        await expect(vendorTransport(vendorOptions())).rejects.toThrow(
            `refusing to vendor "${join("lunora", "config.py")}" — it is a symlink, not a regular file`,
        );

        expect(existsSync(join(outputDirectory, "lunora", "config.py"))).toBe(false);
    });

    it("writes nothing at all when it refuses, rather than leaving a partial transport", async () => {
        expect.assertions(2);

        const linkTarget = join(scratchDir, "target.txt");

        writeFileSync(linkTarget, "scratch-marker\n", "utf8");
        // The link sorts AFTER the regular file, so a guard that refused mid-copy
        // (from inside `cpSync`'s filter) would already have written client.py.
        symlinkSync(linkTarget, join(transportRoot, "python", "lunora", "zz-last.py"));

        await expect(vendorTransport(vendorOptions())).rejects.toThrow("refusing to vendor");

        expect(existsSync(join(outputDirectory, "lunora"))).toBe(false);
    });

    it("does not abort over a symlink the copy would have excluded anyway", async () => {
        // A test file is never vendored, so it must not be able to fail the
        // vendoring — only a link that would actually land in the project does.
        expect.assertions(2);

        const linkTarget = join(scratchDir, "target.txt");

        writeFileSync(linkTarget, "scratch-marker\n", "utf8");
        symlinkSync(linkTarget, join(transportRoot, "python", "lunora", "test_client.py"));

        const result = await vendorTransport(vendorOptions());

        expect(result.files).toStrictEqual(["lunora/client.py"]);
        expect(existsSync(join(outputDirectory, "lunora", "test_client.py"))).toBe(false);
    });

    it("a symlink-free transport still vendors correctly (regression guard)", async () => {
        expect.assertions(2);

        const result = await vendorTransport(vendorOptions());

        expect(result.files).toStrictEqual(["lunora/client.py"]);
        expect(readFileSync(join(outputDirectory, "lunora", "client.py"), "utf8")).toBe("CLIENT = 1\n");
    });
});
