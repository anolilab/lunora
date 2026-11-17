import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeBindingManifestFile } from "../../src/util/binding-manifest-file";
import type { Logger } from "../../src/util/logger";

describe(writeBindingManifestFile, () => {
    let projectRoot: string;

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-binding-manifest-"));
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
    });

    it("warns about a binding name that is not a string on an unasked (quiet) write", () => {
        expect.assertions(2);

        // The dev manifest is written unasked, and `quiet` mutes the `unknown`
        // warning. A wrong-typed name must land in `malformed`, which stays loud.
        writeFileSync(join(projectRoot, "wrangler.jsonc"), JSON.stringify({ name: "app", r2_buckets: [{ binding: 7, bucket_name: "files" }] }), "utf8");

        const logger: Logger = {
            error: vi.fn<Logger["error"]>(),
            info: vi.fn<Logger["info"]>(),
            success: vi.fn<Logger["success"]>(),
            warn: vi.fn<Logger["warn"]>(),
        };
        const result = writeBindingManifestFile({ destination: "manifest.json", logger, projectRoot, quiet: true });

        expect(result).toStrictEqual({});
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("r2_buckets.binding"));
    });
});
