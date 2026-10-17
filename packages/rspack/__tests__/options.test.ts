import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveOptions, resolveRunnableTargetOrThrow } from "../src/options";

let workdir: string;

describe(resolveOptions, () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-rspack-options-"));
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(workdir, { force: true, recursive: true });
    });

    it("defaults to the cloudflare target, the lunora schema dir, and openapi", () => {
        expect.assertions(1);

        expect(resolveOptions({ projectRoot: workdir })).toStrictEqual({
            apiSpec: "openapi",
            lazyFunctions: false,
            projectRoot: workdir,
            schemaDir: "lunora",
            target: "cloudflare",
            validateWrangler: true,
        });
    });

    it("opts into lazy functions explicitly or through the dev child environment", () => {
        expect.assertions(3);

        vi.stubEnv("LUNORA_LAZY_FUNCTIONS", "");

        expect(resolveOptions({ projectRoot: workdir }).lazyFunctions).toBe(false);
        expect(resolveOptions({ lazyFunctions: true, projectRoot: workdir }).lazyFunctions).toBe(true);

        vi.stubEnv("LUNORA_LAZY_FUNCTIONS", "1");

        expect(resolveOptions({ projectRoot: workdir }).lazyFunctions).toBe(true);
    });

    it("rejects a target with no command-line toolchain", () => {
        expect.assertions(1);

        // `node` is a legitimate CODEGEN target, so `resolveTargetOrThrow` alone
        // accepts it — and the build would then emit the wrong surface silently.
        expect(() => resolveRunnableTargetOrThrow(workdir, "node")).toThrow("has no command-line toolchain");
    });

    it("rejects an unknown target", () => {
        expect.assertions(1);

        expect(() => resolveOptions({ projectRoot: workdir, target: "not-a-target" })).toThrow("not-a-target");
    });
});
