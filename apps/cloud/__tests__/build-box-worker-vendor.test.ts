import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import bundleReleaseManifest from "../scripts/vendor-release-manifest";

/**
 * The build box's vendored release-manifest translation is its source, today.
 *
 * `containers/build/vendor/release-manifest.mjs` bundles `buildBindingManifest`
 * (`@lunora/config`) and `collectAssets` (`@lunora/cli`) for the box's
 * Cloudflare Worker runtime, which runs no Lunora CLI. A plain Worker's release
 * must be derived exactly as a Lunora project's is, so a change to either
 * source — or an esbuild or dependency bump that changes the bundle — fails
 * here until `scripts/vendor-release-manifest.ts` is re-run and both files are
 * committed.
 */

const VENDOR = new URL("../containers/build/vendor/", import.meta.url);

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("build box vendored release manifest", () => {
    it("matches a fresh bundle of its sources, licences included", async () => {
        expect.assertions(2);

        const [fresh, module, licenses] = await Promise.all([
            bundleReleaseManifest(),
            readFile(fileURLToPath(new URL("release-manifest.mjs", VENDOR)), "utf8"),
            readFile(fileURLToPath(new URL("release-manifest.LICENSES", VENDOR)), "utf8"),
        ]);

        // Compared as hashes, not diffed: the bundle is 78 KB, and the fix is the same either way — re-run the script.
        expect(sha256(module)).toBe(sha256(fresh.module));
        expect(sha256(licenses)).toBe(sha256(fresh.licenses));
    }, 30_000);

    it("exports exactly the two functions the box imports", async () => {
        expect.assertions(1);

        const vendored = (await import("../containers/build/vendor/release-manifest.mjs")) as Record<string, unknown>;

        expect(Object.keys(vendored).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["buildBindingManifest", "collectAssets"]);
    });
});
