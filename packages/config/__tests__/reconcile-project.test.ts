import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileBindingsSafely } from "../src/cloudflare/reconcile-project";

describe("reconcileBindingsSafely target gate", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-reconcile-project-"));
        mkdirSync(join(root, "lunora"), { recursive: true });
        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app", "compatibility_date": "2026-04-07" }\n`, "utf8");
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const sourceMaps = (): unknown => (parseJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8")) as { upload_source_maps?: unknown }).upload_source_maps;
    const logger = { info: (): void => {}, warn: (): void => {} };

    it.each([["celld"], ["node"]])("does not write upload_source_maps for the %s target", async (target) => {
        expect.assertions(1);

        await reconcileBindingsSafely({ projectRoot: root, schemaDir: "lunora", target }, logger);

        expect(sourceMaps()).toBeUndefined();
    });

    it("writes upload_source_maps for the cloudflare target", async () => {
        expect.assertions(1);

        await reconcileBindingsSafely({ projectRoot: root, schemaDir: "lunora", target: "cloudflare" }, logger);

        expect(sourceMaps()).toBe(true);
    });
});
