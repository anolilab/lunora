import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findCliPackageRoot, resolveCliVersion } from "../../src/util/cli-manifest";

describe(findCliPackageRoot, () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-cli-manifest-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("skips a nested dependency's manifest and finds the @lunora/cli one above a hashed chunk", () => {
        expect.assertions(1);

        const chunk = join(root, "node_modules", "dep", "dist", "packem_shared");

        mkdirSync(chunk, { recursive: true });
        writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@lunora/cli", version: "1.2.3" }), "utf8");
        writeFileSync(join(root, "node_modules", "dep", "package.json"), JSON.stringify({ name: "dep" }), "utf8");

        expect(findCliPackageRoot(chunk)).toBe(root);
    });

    it("resolves the running CLI's own version", () => {
        expect.assertions(1);

        expect(resolveCliVersion()).toMatch(/^\d+\.\d+\.\d+/u);
    });
});
